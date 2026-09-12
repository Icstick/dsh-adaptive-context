// src/feedback.mjs — 反馈通道：纠正 → 规则草案（T4 M4.2，2026-09-07）。
//
// 流程（docs/t4-feedback-channel-impl-2026-09-07.md §2 M3）：
//   user_correction/user_explicit evidence（权威最高轨）→ G1/G2 闸门 → 候选集
//   → LLM 草拟（复用 consolidation 路由；可缺失）→ rule 表 draft 行 + audit rule_drafted
// 幂等：已入 rules.evidence_ids 的证据不重复草拟；同 scope+domain+text 天然同 rule id。
// 纪律：authority/claimDomain 契约冻结；闸门判定确定性实现（零 LLM）；
//       未过闸门的纠正维持现状（evidence 层按需召回）。
//
// 闸门（妹妹拍板 2+3 混合，MVP 先落两条）：
//   G1 显式前缀：记住：/更正：/规则：/remember: 开头 → 规则请求
//   G2 同义重复：user_correction 归一化 key（前 24 字符）出现 ≥2 次 → 取最新作代表
//   G3 安全类：仅手工提 + 显式审批（不在本模块自动草拟）

import {
  ruleIdOf, RULE_TEXT_MAX_CHARS, RULE_TITLE_MAX_CHARS, RULE_DOMAIN_MAX_CHARS,
} from './rule.mjs'

/** 显式规则前缀（G1） */
export const RULE_PREFIXES = [
  '记住：', '记住:', '更正：', '更正:', '规则：', '规则:',
  'remember: ', 'remember：', 'please remember: ',
]

/** 候选窗口：只看近 N 天证据（时间衰减 MVP 常量） */
export const CANDIDATE_WINDOW_MS = 7 * 86400000
/** G2 重复次数阈值 */
export const G2_REPEAT_MIN = 2
/** G2 归一化 key 长度（字符） */
export const G2_KEY_CHARS = 24
/** 单次草拟批次上限 */
export const DRAFT_MAX_BATCH = 3
/** 草拟 run 日限（acp_meta feedback_draft_day/count 节流） */
export const DRAFT_MAX_RUNS_PER_DAY = 4

/** G2 归一化 key：压缩空白后取前 N 字符（确定性，异措辞同义开头可聚） */
export function g2KeyOf(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, G2_KEY_CHARS)
}

/** G1：显式规则前缀命中（正文以 记住:/更正:/规则: 开头且有余量文本） */
export function isExplicitRuleRequest(text) {
  const t = String(text ?? '').trim()
  for (const p of RULE_PREFIXES) {
    if (t.startsWith(p) && t.length > p.length + 3) return true
  }
  return false
}

/**
 * 采集规则候选（近 N 天 active 高权威证据过闸门）。
 * G1 池：user_explicit + user_correction 中前缀命中；
 * G2 池：user_correction 中归一化 key 重复 ≥2（取同 key 最新一条作代表）。
 * @param {object} ledger
 * @param {object} [opts] - { windowMs }
 * @returns {object[]} 候选证据行（observed_at DESC 序）
 */
export function collectRuleCandidates(ledger, opts = {}) {
  const since = new Date(Date.now() - (opts.windowMs ?? CANDIDATE_WINDOW_MS)).toISOString()
  const rows = []
  for (const authority of ['user_correction', 'user_explicit']) {
    const q = ledger.query({ state: 'active', authority, limit: 200 })
    for (const ev of q.items) {
      if (typeof ev.observedAt === 'string' && ev.observedAt >= since) rows.push(ev)
    }
  }
  const g1 = rows.filter((ev) => isExplicitRuleRequest(ev.content))
  // G2：同 key 计数（key → 最新证据），仅保留重复 ≥2 的 key
  const corr = rows.filter((ev) => ev.authority === 'user_correction')
  const counts = new Map()
  const latest = new Map()
  for (const ev of corr) {
    const k = g2KeyOf(ev.content)
    if (!k) continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
    const cur = latest.get(k)
    if (!cur || ev.observedAt > cur.observedAt) latest.set(k, ev)
  }
  const g2 = []
  for (const [k, n] of counts) {
    if (n >= G2_REPEAT_MIN && latest.has(k)) g2.push(latest.get(k))
  }
  const seen = new Set()
  const out = []
  for (const ev of [...g1, ...g2]) {
    if (seen.has(ev.id)) continue
    seen.add(ev.id)
    out.push(ev)
  }
  return out
}

/** 已入 rules 的证据 id 集（幂等防重：草案/生效/历史全算已处理） */
export function draftedEvidenceIds(ledger) {
  const set = new Set()
  const { items } = ledger.ruleStore.queryRules({ limit: 500 })
  for (const r of items) {
    for (const eid of r.evidenceIds ?? []) set.add(eid)
  }
  return set
}

/** 兜底正文（LLM 不可用/解析失败）：G1 去前缀；其余原文截断 ≤200 字 */
export function fallbackRuleText(ev) {
  const t = String(ev?.content ?? '').trim()
  for (const p of RULE_PREFIXES) {
    if (t.startsWith(p)) {
      const rest = t.slice(p.length).trim()
      if (rest) return rest.slice(0, RULE_TEXT_MAX_CHARS)
    }
  }
  return t.slice(0, RULE_TEXT_MAX_CHARS)
}

/** 候选证据 → 单条草拟落库（确定性字段组装；llmJson 可选覆盖 domain/title/text） */
export function draftRuleFromEvidence(ledger, ev, opts = {}) {
  const gates = isExplicitRuleRequest(ev.content) ? ['explicit-prefix'] : ['repeated-2x']
  let domain = 'habit'
  let title = ''
  let text = ''
  const lj = opts.llmJson
  if (lj && typeof lj.text === 'string' && lj.text.trim()) {
    text = lj.text.trim().slice(0, RULE_TEXT_MAX_CHARS)
    title = String(lj.title ?? '').trim().slice(0, RULE_TITLE_MAX_CHARS) || text.slice(0, 20)
    if (typeof lj.domain === 'string' && lj.domain.trim()) {
      domain = lj.domain.trim().slice(0, RULE_DOMAIN_MAX_CHARS)
    }
  } else {
    text = fallbackRuleText(ev)
    title = text.slice(0, RULE_TITLE_MAX_CHARS)
  }
  return ledger.ruleStore.createRule({
    scopeId: ev.scopeId ?? 'user-global',
    domain, title, text,
    evidenceIds: [ev.id],
    gates,
    source: 'feedback',
  })
}

/** B11（2026-09-12）：CJK bigram 重叠度（用较短一方归一化，0..1）。
 *  语义：覆盖率导向——短规则被长纠正"整句命中"时接近 1。
 *  用途：判定"用户又纠正了同一件事，而 active 规则已存在" → 规则疑似未生效。 */
export function lexicalOverlap(a, b) {
  const grams = (s) => {
    const t = String(s ?? '').replace(/\s+/g, '')
    const set = new Set()
    if (t.length === 1) set.add(t)
    for (let i = 0; i + 1 < t.length; i += 1) set.add(t.slice(i, i + 2))
    return set
  }
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / Math.min(A.size, B.size)
}

/** B11：规则覆盖阈值（重叠 ≥ 此值视为已被既有规则覆盖） */
export const RULE_OVERLAP_THRESHOLD = 0.6

/**
 * B11：候选证据是否已被某条 active 规则覆盖。
 * @returns {{rule: object, overlap: number}|null} 取重叠最高者；无覆盖返回 null
 */
export function findCoveringRule(ledger, ev, threshold = RULE_OVERLAP_THRESHOLD) {
  // 短文本（<10 字）bigram 样本太少，min 归一化会把偶发重合放大成假阳性 → 不判定
  if (String(ev?.content ?? '').replace(/\s+/g, '').length < 10) return null
  let best = null
  const rules = ledger.ruleStore.queryRules({ state: 'active', limit: 200 }).items
  for (const r of rules) {
    const overlap = lexicalOverlap(ev?.content, r.text)
    if (overlap >= threshold && (best === null || overlap > best.overlap)) best = { rule: r, overlap }
  }
  return best
}

/** LLM 草拟 system prompt */
export const DRAFT_SYSTEM = [
  'You are distilling explicit user corrections/requests into durable RULES for a cross-session rule ledger.',
  'A rule is a short imperative/descriptive statement of how the user wants work to be done (≤200 chars, Chinese ≤100 字).',
  'Return ONLY a JSON array matching the input order, one object per input: [{"domain":"workflow|habit|communication|security|project","title":"短标题 ≤20 字","text":"规则正文 ≤200 字"}]',
  'domain values must be one of workflow/habit/communication/security/project. Do not invent facts. Output only JSON.',
].join('\n')

/** LLM 输出 → JSON 数组（容错：剥 markdown fence / 前后杂文；失败 null） */
export function parseDraftJson(text) {
  if (!text) return null
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('[')
  if (start < 0) return null
  const end = t.lastIndexOf(']')
  if (end <= start) return null
  try {
    const arr = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

/**
 * 执行一次草拟 run（幂等 + 日限节流）。
 * @param {object} ledger - openEvidenceLedger 句柄（含 ruleStore/auditStore/getMeta/setMeta）
 * @param {object} [opts] - { llmCall?, now?, logger? }
 * @returns {{ran: boolean, reason?: string, candidates: number, drafted: number}}
 */
export async function maybeDraft(ledger, opts = {}) {
  const now = opts.now ?? Date.now()
  // 日限节流（读 meta 短路，省查询）：同 day ≥ DRAFT_MAX_RUNS_PER_DAY → skip
  const today = new Date(now).toISOString().slice(0, 10)
  const day = ledger.getMeta?.('feedback_draft_day') ?? ''
  const count = Number(ledger.getMeta?.('feedback_draft_count') ?? 0)
  if (day === today && count >= DRAFT_MAX_RUNS_PER_DAY) {
    return { ran: false, reason: 'daily_cap', candidates: 0, drafted: 0, covered: 0 }
  }
  const candidates = collectRuleCandidates(ledger, opts)
  const done = draftedEvidenceIds(ledger)
  const fresh = candidates.filter((ev) => !done.has(ev.id))
  if (fresh.length === 0) {
    ledger.setMeta?.('feedback_draft_day', today)
    ledger.setMeta?.('feedback_draft_count', String(count + 1))
    return { ran: true, candidates: 0, drafted: 0, covered: 0 }
  }
  const batch = fresh.slice(0, DRAFT_MAX_BATCH)
  let parsed = null
  if (typeof opts.llmCall === 'function') {
    const userText = 'Evidence (JSON):\n' + JSON.stringify(batch.map((ev) => ({
      id: ev.id, authority: ev.authority, content: String(ev.content).slice(0, 800),
    })))
    try {
      parsed = parseDraftJson(await opts.llmCall(userText, DRAFT_SYSTEM))
    } catch (err) {
      opts.logger?.warn?.('[acp] feedback draft llm failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }
  let drafted = 0
  let covered = 0
  batch.forEach((ev, i) => {
    try {
      // B11（2026-09-12）：已被 active 规则覆盖 → 不重复草拟（避免规则表堆积同义条目），
      // 改落 rule_ineffective_suspect 审计 + 日志——"用户又纠正了同一件事但规则没生效"是
      // 行为层信号（可能是规则太长注不进、被容量裁掉，或模型没遵守）。
      const hit = findCoveringRule(ledger, ev)
      if (hit) {
        covered += 1
        try {
          ledger.auditStore?.appendAudit?.({
            op: 'rule_ineffective_suspect',
            targetId: hit.rule.id,
            scopeId: ev.scopeId ?? 'user-global',
            actor: 'feedback',
            reason: 'correction overlaps active rule (rule may be ineffective)',
            payload: { evidenceId: ev.id, overlap: Number(hit.overlap.toFixed(3)), ruleTitle: hit.rule.title },
          })
        } catch (err) {
          opts.logger?.warn?.('[acp] feedback audit failed: ' + (err instanceof Error ? err.message : String(err)))
        }
        opts.logger?.info?.('[acp] rule ineffective suspect: ' + hit.rule.id
          + ' overlap=' + hit.overlap.toFixed(2) + ' evidence=' + ev.id)
        return
      }
      const res = draftRuleFromEvidence(ledger, ev, { llmJson: parsed?.[i] ?? null })
      if (res.inserted) {
        drafted += 1 // 规则落库即算草拟成功；审计失败独立告警，不吞计数
        try {
          ledger.auditStore?.appendAudit?.({
            op: 'rule_drafted',
            targetId: res.row.id,
            scopeId: ev.scopeId ?? 'user-global',
            actor: 'feedback',
            reason: 'G1/G2 candidate drafted (T4 M4.2)',
            payload: { evidenceId: ev.id, gates: res.row.gates },
          })
        } catch (err) {
          opts.logger?.warn?.('[acp] feedback audit failed: ' + (err instanceof Error ? err.message : String(err)))
        }
      }
    } catch (err) {
      opts.logger?.warn?.('[acp] feedback draft item failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  })
  ledger.setMeta?.('feedback_draft_day', today)
  ledger.setMeta?.('feedback_draft_count', String(count + 1))
  return { ran: true, candidates: fresh.length, drafted, covered }
}

export { ruleIdOf }
export default { maybeDraft, collectRuleCandidates, isExplicitRuleRequest, g2KeyOf }
