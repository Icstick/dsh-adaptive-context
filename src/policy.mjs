// src/policy.mjs — Promotion policy 评估器（B2，feat/policy）。
//
// 落地 EXPRESSION.md §3-7 的 personagent 式自动提升护栏：
//   Evidence (truth) → Candidate (inert proposal) → **Promotion (policy gate)** → Few-shot pool
// 铁律对齐：Learning does not imply promotion（policy 只评估，不写任何状态）；
//           Evidence is truth（评估是纯函数，零副作用——调用方决定 promote/hold 后的落盘）。
//
// 决策语义（M3-PLAN §6.2 契约，三值）：
//   promote —— floors 全部达标且 auto_promote=true（自动路径）
//   hold    —— 不自动提升、非终局：留人工（M2 approval 路径）或等更多/更新证据
//   reject  —— 终局不可提升（候选状态本身不允许提升）
//
// 拒绝路径 reason 清单（顺序对齐 EXPRESSION.md §7，全部可审计）：
//   1. auto_promote 未开启        → "automatic promotion disabled (auto_promote=false)"  [hold]
//   2. 状态非 proposed            → "state is X, not proposed"                            [reject]
//   3. 存在反对证据                → "compatible evidence disagrees — left for review"      [hold]
//   4. 存在冲突候选                → "a conflicting candidate exists — left for review"    [hold]
//   5. strong 不足                → "N/M strong events (K supporting)"                    [hold]
//   6. 事件数不足                 → "N/M compatible events"                               [hold]
//   7. 证据全部过期                → "all compatible evidence expired (older than X days)" [hold]
//
// 方向性（EXPRESSION.md §5）：supports/opposes 是候选相对概念——
//   显式 direction 字段优先（'supports'|'opposes'|'neutral'，由候选构建方声明，如 reflector）；
//   未声明时仅 STRONG（user_correction/user_explicit）默认 supports（任务规格），
//   其余（NEGATIVE_ONLY/WEAK）默认 neutral——不计数、不反对（弱证据任何数量都不 promotion）。
//   反向纠正 = 显式 direction='opposes' 的纠正（"replace X with C" ≠ 候选主张的 "replace X with B"）。
//
// floors（config 只允许更严，不可放宽；effective 快照进返回的 policy 字段供审计）：
//   min_events=2（floor：配 1 强制 2）、min_strong=1（floor）、
//   max_evidence_age_days=30（floor=上限：只允许更严，配 60 强制 30）、
//   require_same_conversation=true（floor：不可关闭）、auto_promote=false（master switch，默认全人工）。

/** 默认配置（宽松的"出厂"值；effective 以 floors 收口） */
export const POLICY_DEFAULTS = Object.freeze({
  minEvents: 2,
  minStrong: 1,
  maxEvidenceAgeDays: 30,
  requireSameConversation: true,
  autoPromote: false,
})

/** floors：不可放宽的底线（config 只能更严） */
export const POLICY_FLOORS = Object.freeze({
  minEvents: 2,            // 两个独立兼容事件——最小"不可能由一次误读产生"的数量
  minStrong: 1,            // 至少一个 STRONG（directed correction / accepted retry）
  maxEvidenceAgeDays: 30,  // 30 天前的证据不再计数（四个月前是历史，不是授权）
  requireSameConversation: true, // 防 cross-room 放大：一个 loud teacher 不会到处达标
  autoPromote: false,      // master switch：默认关，全人工
})

/** 固定 reason（测试与审计直接引用） */
export const REASONS = Object.freeze({
  AUTO_DISABLED: 'automatic promotion disabled (auto_promote=false)',
  OPPOSING_EVIDENCE: 'compatible evidence disagrees — left for review',
  CONFLICTING_CANDIDATE: 'a conflicting candidate exists — left for review',
})

/** 动态 reason 模板（对齐 EXPRESSION.md §7 格式） */
export const stateNotProposedReason = (state) => `state is ${state}, not proposed`
export const strongInsufficientReason = (n, m, k) => `${n}/${m} strong events (${k} supporting)`
export const eventsInsufficientReason = (n, m) => `${n}/${m} compatible events`
export const evidenceExpiredReason = (days) => `all compatible evidence expired (older than ${days} days)`

const DAY_MS = 24 * 60 * 60 * 1000

/** 单事件可授予的权威量（EXPRESSION.md §4 映射，7 值全表）。 */
const STRENGTH_MAP = Object.freeze({
  user_correction: 'STRONG',        // directed correction ≈ STRONG
  user_explicit: 'STRONG',          // directed ≈ STRONG
  single_observation: 'NEGATIVE_ONLY', // 无具体内容的 rejection / 旁观者 correction
  agent_self_evaluation: 'WEAK',    // agent 自己的评分，永不单独 promotion
  // 其余 authority 不是用户行为反馈，不具提升资格（保守，fail-safe）：
  system_policy: 'not_eligible',        // 静态声明的策略，非行为学习信号
  agent_inference: 'not_eligible',      // agent 自身推断，非用户反馈
  external_information: 'not_eligible', // 外部信息，无行为权威
})

/**
 * 单事件可授予的权威量。
 * @param {string} authority - ACP authority 7 值之一
 * @returns {'STRONG'|'NEGATIVE_ONLY'|'WEAK'|'not_eligible'}
 */
export function classifyStrength(authority) {
  return STRENGTH_MAP[authority] ?? 'not_eligible'
}

/** 字段兼容读取：优先 camelCase（store.toEvidence 行），回退 snake_case（DB 原始行）。 */
function pick(row, camel, snake) {
  if (row == null) return undefined
  return row[camel] !== undefined ? row[camel] : row[snake]
}

/** 证据行时间戳（ms）；缺失 → null（无法验证年龄/新旧 → 不 veto，按最新处理）。 */
function tsOf(ev) {
  const observed = pick(ev, 'observedAt', 'observed_at')
  if (observed != null) {
    const d = new Date(observed).getTime()
    if (!Number.isNaN(d)) return d
  }
  const created = pick(ev, 'createdAt', 'created_at')
  if (typeof created === 'number' && !Number.isNaN(created)) return created
  return null
}

/**
 * 证据行所属会话键（同会话约束用）。
 * 解析顺序：sourceRef.sessionId → sourceRef.conversationId →
 * sourceRef.sessionEventId（extract.mjs 真实格式 "sessionId:seq" → 取 session 部分）→ ''（不可判定）。
 * @param {object} ev
 * @returns {string}
 */
export function conversationKeyOf(ev) {
  const ref = pick(ev, 'sourceRef', 'source_ref') ?? {}
  const sid = ref.sessionId ?? ref.session_id
  if (typeof sid === 'string' && sid) return sid
  const cid = ref.conversationId ?? ref.conversation_id
  if (typeof cid === 'string' && cid) return cid
  const sev = ref.sessionEventId ?? ref.session_event_id
  if (typeof sev === 'string' && sev) {
    const i = sev.lastIndexOf(':')
    return i > 0 ? sev.slice(0, i) : sev
  }
  return ''
}

/**
 * 解析证据方向（supports/opposes/neutral）。
 * 显式 direction（行字段或 metadata.direction）优先；未声明时 STRONG 默认 supports，
 * 其余（NEGATIVE_ONLY/WEAK）默认 neutral——弱/负向证据方向不明时不主张、不反对、不计数。
 * @param {object} ev
 * @returns {'supports'|'opposes'|'neutral'}
 */
export function resolveDirection(ev) {
  const declared = ev?.direction ?? ev?.metadata?.direction
  if (declared === 'supports' || declared === 'opposes' || declared === 'neutral') return declared
  return classifyStrength(ev?.authority) === 'STRONG' ? 'supports' : 'neutral'
}

/** 数字配置解析：NaN/非法 → 默认值。 */
function toNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 解析 effective 配置（floors 收口）。结果快照进评估返回的 policy 字段。
 * @param {object} [config]
 * @returns {object} effective 参数 + floors 明细（requested/effective 对照）
 */
export function resolvePolicyConfig(config = {}) {
  const reqMinEvents = toNum(config.minEvents, POLICY_DEFAULTS.minEvents)
  const reqMinStrong = toNum(config.minStrong, POLICY_DEFAULTS.minStrong)
  const reqMaxAge = toNum(config.maxEvidenceAgeDays, POLICY_DEFAULTS.maxEvidenceAgeDays)

  const minEvents = Math.max(reqMinEvents, POLICY_FLOORS.minEvents)
  const minStrong = Math.max(reqMinStrong, POLICY_FLOORS.minStrong)
  // age：floor=上限 30（只允许更严），且 ≥0（不允许负天数）
  const maxEvidenceAgeDays = Math.min(Math.max(reqMaxAge, 0), POLICY_FLOORS.maxEvidenceAgeDays)
  // require_same_conversation 是 floor：显式 false 也强制 true
  const requireSameConversation = POLICY_FLOORS.requireSameConversation
  // auto_promote 是 master switch：只有显式 true 才开启自动路径
  const autoPromote = config.autoPromote === true

  return {
    minEvents,
    minStrong,
    maxEvidenceAgeDays,
    requireSameConversation,
    autoPromote,
    floors: {
      minEvents: { requested: reqMinEvents, effective: minEvents },
      minStrong: { requested: reqMinStrong, effective: minStrong },
      maxEvidenceAgeDays: { requested: reqMaxAge, effective: maxEvidenceAgeDays },
    },
  }
}

/**
 * Promotion policy 评估（纯函数，零副作用）。
 * @param {object} args
 * @param {object} args.candidate - {state?, conflictingCandidates?}（B1 候选行子集；
 *   conflictingCandidates: 冲突候选 id 或对象数组，由调用方从 candidate store 装配）
 * @param {object[]} [args.evidenceRows] - 候选相关证据行（store 行或测试构造行；
 *   字段兼容 camelCase/snake_case；direction 可选）
 * @param {object} [args.config] - 生效参数（floors 不可放宽）；可注入 now（ms，测试/审计用）
 * @returns {{decision: 'promote'|'hold'|'reject', reason: string, policy: object}}
 */
export function evaluateCandidate({ candidate = {}, evidenceRows = [], config = {} } = {}) {
  const now = toNum(config.now, Date.now())
  const policy = resolvePolicyConfig(config)

  // ── §7 路径 1：auto_promote 未开启（master switch，默认关 → 全部留人工） ──
  if (!policy.autoPromote) {
    return { decision: 'hold', reason: REASONS.AUTO_DISABLED, policy: snapshot(policy, now) }
  }

  // ── §7 路径 2：状态非 proposed ──
  if (candidate.state && candidate.state !== 'proposed') {
    return { decision: 'reject', reason: stateNotProposedReason(candidate.state), policy: snapshot(policy, now) }
  }

  // ── 证据分类（eligible → age → conversation → direction） ──
  const rows = Array.isArray(evidenceRows) ? evidenceRows : []
  const eligible = rows.filter((ev) => classifyStrength(ev?.authority) !== 'not_eligible')

  const freshRows = eligible.filter((ev) => {
    const ts = tsOf(ev)
    return ts == null || now - ts <= policy.maxEvidenceAgeDays * DAY_MS
  })
  const expired = eligible.filter((ev) => !freshRows.includes(ev))

  // 同会话约束：目标会话 = 可判定会话行中最新证据所在会话；只计数该会话内的行。
  // 全部不可判定 → 视为同一会话（缺失不 veto，回退事件数）。
  let counted = freshRows
  if (policy.requireSameConversation && freshRows.length > 0) {
    const keyed = freshRows.map((ev) => ({ ev, key: conversationKeyOf(ev) }))
    const determinable = keyed.filter((k) => k.key !== '')
    if (determinable.length > 0) {
      const target = determinable.reduce((a, b) => {
        const at = tsOf(a.ev) ?? -Infinity
        const bt = tsOf(b.ev) ?? -Infinity
        return bt > at ? b : a
      }).key
      counted = keyed.filter((k) => k.key === target).map((k) => k.ev)
    }
  }

  const dirs = counted.map((ev) => resolveDirection(ev))
  const supports = counted.filter((_, i) => dirs[i] === 'supports')
  const opposes = counted.filter((_, i) => dirs[i] === 'opposes')
  const strong = counted.filter((ev) => classifyStrength(ev?.authority) === 'STRONG')
  const strongSupporting = supports.filter((ev) => classifyStrength(ev?.authority) === 'STRONG')
  const compatibleEvents = supports.length + opposes.length

  const counts = {
    eligible: eligible.length,
    fresh: freshRows.length,
    expired: expired.length,
    sameConversation: counted.length,
    supports: supports.length,
    opposes: opposes.length,
    strong: strong.length,
    strongSupporting: strongSupporting.length,
    compatibleEvents,
  }

  // ── §7 路径 3：存在反对证据 ──
  if (opposes.length > 0) {
    return { decision: 'hold', reason: REASONS.OPPOSING_EVIDENCE, policy: snapshot(policy, now, counts) }
  }

  // ── §7 路径 4：存在冲突候选 ──
  const conflicting = candidate.conflictingCandidates ?? candidate.conflicting ?? []
  if (Array.isArray(conflicting) && conflicting.length > 0) {
    return { decision: 'hold', reason: REASONS.CONFLICTING_CANDIDATE, policy: snapshot(policy, now, counts) }
  }

  // ── §7 路径 5a：证据全部过期（先于 strong/events——新鲜度是更根本的问题） ──
  if (eligible.length > 0 && freshRows.length === 0) {
    return {
      decision: 'hold',
      reason: evidenceExpiredReason(policy.maxEvidenceAgeDays),
      policy: snapshot(policy, now, counts),
    }
  }

  // ── §7 路径 5b：strong 不足（只数支持性 STRONG——反向纠正不计入） ──
  if (strongSupporting.length < policy.minStrong) {
    return {
      decision: 'hold',
      reason: strongInsufficientReason(strongSupporting.length, policy.minStrong, strongSupporting.length),
      policy: snapshot(policy, now, counts),
    }
  }

  // ── §7 路径 6：事件数不足 ──
  if (compatibleEvents < policy.minEvents) {
    return {
      decision: 'hold',
      reason: eventsInsufficientReason(compatibleEvents, policy.minEvents),
      policy: snapshot(policy, now, counts),
    }
  }

  // ── 达标：自动提升 ──
  return {
    decision: 'promote',
    reason: `policy floors satisfied (${compatibleEvents}/${policy.minEvents} compatible events, ${strongSupporting.length}/${policy.minStrong} strong supporting)`,
    policy: snapshot(policy, now, counts),
  }
}

/** policy 快照：生效参数 + floors 明细 + 评估计数（审计用）。 */
function snapshot(policy, now, counts) {
  const snap = {
    ...policy,
    evaluatedAt: new Date(now).toISOString(),
  }
  if (counts) snap.counts = counts
  return snap
}
