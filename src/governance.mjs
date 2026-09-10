// src/governance.mjs — 读写边界守卫。
// Write Guard：sourceClass → claimDomain 权威约束、secret/PII 确定性扫描、payload 限制。
// Read Guard：scope/state/sensitivity/authority-domain 过滤。
// 全部确定性实现，不调用 LLM（OWASP AMG 参考：基础治理不需要为每次 read 再调模型）。

import { MAX_EVIDENCE_CONTENT_CHARS, CLAIM_DOMAINS } from './constants.mjs'

// --- 确定性 secret/PII 模式（保守，宁可 quarantine 也不放行） ---
const SECRET_PATTERNS = [
  /\b(?:sk|pk|api[_-]?key|token|secret|password|passwd|pwd|credential|bearer|private[_-]?key|access[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9_-]{12,}/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,                 // GitHub PAT
  /\bgho_\w{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,         // Slack token
  /\bAKIA[0-9A-Z]{16}\b/,                     // AWS access key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

// --- 确定性 prompt-injection 提示词（保守） ---
const INJECTION_PATTERNS = [
  /ignore (?:all |the |any )?(?:previous|prior|above|earlier|old) (?:instructions?|prompts?|rules?|preferences?|directives?|guidelines?|policies?|context|settings?)/i,
  /disregard (?:all |the |any )?(?:previous|prior|above|earlier|old) (?:instructions?|prompts?|rules?|preferences?|directives?|guidelines?|policies?|context|settings?)/i,
  /you are now (?:a |an )?[^\n]{0,40}without (?:any )?(?:restrictions?|limitations?|rules?)/i,
  /system prompt:\s*[\s\S]{0,200}/i,
  /you must (?:ignore|forget|override)/i,
]

/** sourceClass 允许的 claimDomain（写边界权威约束的核心） */
const SOURCE_DOMAIN_ALLOW = {
  system:           new Set(['user_fact', 'user_preference', 'work', 'experience', 'style', 'external_fact']),
  user_input:       new Set(['user_fact', 'user_preference', 'work', 'experience', 'style', 'external_fact']),
  user_correction:  new Set(['user_fact', 'user_preference', 'work', 'experience', 'style', 'external_fact']),
  // external_tool 默认不能产生 personal-preference / style / behavior authority；
  // 可进 experience（外部文档/工具输出补充工作经验，2026-08-25 决策）
  external_tool:    new Set(['user_fact', 'work', 'experience', 'external_fact']),
  agent_authored:   new Set(['user_fact', 'work', 'experience', 'external_fact']), // 不能直接 claim preference/style
}

/** sourceClass → authority 确定性映射（2026-08-25 决策，写入校验用） */
const SOURCE_AUTHORITY_MAP = {
  system: 'system_policy',
  user_input: 'user_explicit',
  user_correction: 'user_correction',
  external_tool: 'external_information',
  // agent_authored 走子规则（调用方在 append 前由 authority 归一化层决定）
  agent_authored: null,
}
/** agent_authored 的子规则：按证据性质选 authority */
export function agentAuthoredAuthority(kind) {
  if (kind === 'self_eval') return 'agent_self_evaluation'
  if (kind === 'inference') return 'agent_inference'
  return 'single_observation'
}
/** 校验：authority 与 sourceClass 是否矛盾（外部显式声明的 authority 必须匹配） */
export function assertAuthorityConsistent(sourceClass, authority) {
  const expected = SOURCE_AUTHORITY_MAP[sourceClass]
  if (expected && expected !== authority) {
    throw new TypeError(`authority '${authority}' inconsistent with sourceClass '${sourceClass}' (expected '${expected}')`)
  }
  return true
}

/**
 * authority → claimDomain 资格矩阵（读边界，GOVERNANCE.md §2.5，决策日期 2026-08-25）。
 *
 * 行 = 7 个 authority；列 = 6 个 claimDomain。✓ = 该 authority 的证据可注入目标域；
 * ✗ = 拒绝（不进 active view）。
 *
 *   authority              user_fact user_preference work experience style external_fact
 *   system_policy             ✓         ✓           ✓      ✓        ✓        ✓
 *   user_explicit             ✓         ✓           ✓      ✓        ✓        ✓
 *   user_correction           ✓         ✓           ✓      ✓        ✓        ✓
 *   single_observation        ✓         ✗           ✓      ✓        ✗        ✓
 *   agent_inference           ✗         ✗           ✗      ✗        ✗        ✗   （不进 active view，MVP quarantine）
 *   agent_self_evaluation     ✗         ✗           ✗      ✗        ✗        ✗   （永不 promotion）
 *   external_information      ✓         ✗           ✓      ✓        ✗        ✓
 *
 * 语义要点：single_observation 可进 user_fact 但不能影响 preference/style
 * （"观察到用 TS"≠"用户喜欢 TS"）；external_information 可进 experience
 * （外部文档/工具输出补充工作经验知识，2026-08-25 调整）。
 */
/** 由允许域列表构建矩阵行：列表内 ✓，其余 ✗（全部列显式填充，保证 6 域全覆盖） */
function makeMatrixRow(allowedDomains) {
  const allowed = new Set(allowedDomains)
  return Object.freeze(
    Object.fromEntries(CLAIM_DOMAINS.map((domain) => [domain, allowed.has(domain)])),
  )
}

/** 事实型/经验型域：single_observation 与 external_information 可注入的范围 */
const FACTUAL_DOMAINS = ['user_fact', 'work', 'experience', 'external_fact']

/** 资格矩阵（只读，行/列均冻结）。 */
export const AUTHORITY_DOMAIN_MATRIX = Object.freeze({
  system_policy:         makeMatrixRow([...CLAIM_DOMAINS]),
  user_explicit:         makeMatrixRow([...CLAIM_DOMAINS]),
  user_correction:       makeMatrixRow([...CLAIM_DOMAINS]),
  single_observation:    makeMatrixRow(FACTUAL_DOMAINS),
  agent_inference:       makeMatrixRow([]),
  agent_self_evaluation: makeMatrixRow([]),
  external_information:  makeMatrixRow(FACTUAL_DOMAINS),
})

/**
 * 查表：authority 是否允许注入 targetDomain（读边界资格）。
 * 未知 authority → 返回 true（矩阵不适用，不拒绝；避免新增 authority 时误伤存量调用）。
 * @param {string} authority
 * @param {string} targetDomain
 * @returns {boolean}
 */
export function authorityMayClaimDomain(authority, targetDomain) {
  const row = AUTHORITY_DOMAIN_MATRIX[authority]
  if (!row) return true
  return row[targetDomain] === true
}

/**
 * Write Guard 判定。
 * @param {object} ev - 候选 evidence（sourceClass/claimDomain/content/sensitivity...）
 * @returns {{decision: 'allow'|'redact'|'quarantine'|'block', reasons: string[]}}
 */
export function writeGuard(ev) {
  const reasons = []

  // 1. 权威约束：sourceClass 不允许的 claimDomain
  const allowed = SOURCE_DOMAIN_ALLOW[ev.sourceClass]
  if (allowed && !allowed.has(ev.claimDomain)) {
    return { decision: 'block', reasons: [`sourceClass '${ev.sourceClass}' cannot claim domain '${ev.claimDomain}'`] }
  }

  // 2. payload 大小
  if (typeof ev.content !== 'string' || ev.content.length > MAX_EVIDENCE_CONTENT_CHARS) {
    return { decision: 'block', reasons: ['content too large or not string'] }
  }

  // 3. secret 扫描 → block（secret 不进 ledger）
  for (const re of SECRET_PATTERNS) {
    if (re.test(ev.content)) {
      return { decision: 'block', reasons: ['secret/credential pattern detected'] }
    }
  }

  // 4. injection 扫描 → quarantine（可疑但保留审计）
  for (const re of INJECTION_PATTERNS) {
    if (re.test(ev.content)) {
      reasons.push('prompt-injection pattern detected')
      return { decision: 'quarantine', reasons }
    }
  }

  // 5. 敏感度策略
  if (ev.sensitivity === 'secret') {
    return { decision: 'block', reasons: ['sensitivity=secret blocked from storage'] }
  }
  if (ev.sensitivity === 'sensitive' && ev.sourceClass === 'external_tool') {
    reasons.push('sensitive content from external_tool')
    return { decision: 'quarantine', reasons }
  }

  return { decision: 'allow', reasons }
}

/**
 * Read Guard 判定：候选 context 是否可注入主模型。
 * @param {object} ev
 * @param {object} ctx - { scopeId?, targetDomain? }
 * @returns {{allowed: boolean, reasons: string[]}}
 */
export function readGuard(ev, ctx = {}) {
  const reasons = []

  // quarantine/redacted 永不注入
  if (ev.state === 'quarantined' || ev.state === 'redacted') {
    return { allowed: false, reasons: ['state not injectable'] }
  }
  // superseded 默认不注入（除非显式要求历史）
  if (ev.state === 'superseded' && !ctx.allowSuperseded) {
    return { allowed: false, reasons: ['superseded by newer evidence'] }
  }

  // scope 过滤
  if (ctx.scopeId && ev.scopeId !== ctx.scopeId) {
    return { allowed: false, reasons: ['scope mismatch'] }
  }

  // temporal validity
  if (ctx.validAt) {
    const t = ctx.validAt
    if (ev.validFrom && ev.validFrom > t) return { allowed: false, reasons: ['not yet valid'] }
    if (ev.validUntil && ev.validUntil < t) return { allowed: false, reasons: ['expired'] }
  }

  // authority → claimDomain 资格矩阵：ctx.targetDomain 指定时查表，✗ 拒绝
  // （GOVERNANCE.md §2.5，2026-08-25：single_observation 不影响 preference/style；
  //   agent_inference / agent_self_evaluation 不进 active view；external_information 可进 experience）
  if (ctx.targetDomain && !authorityMayClaimDomain(ev.authority, ctx.targetDomain)) {
    return { allowed: false, reasons: ['authority not permitted for target domain: ' + ctx.targetDomain] }
  }

  return { allowed: true, reasons }
}

// ===================== T2.5（2026-09-07）：会话动作流水形态过滤 =====================
// 问题：consolidation 把用户消息流转写成「subject=用户 + 动作谓词」的第三人称动作句
// （「用户 询问/确认/审批/使用…」），authority 按支撑证据聚合为 user_explicit → 过 T2 闸门，
// 每轮注入会话流水账（实测 86 条 active user_explicit obs 属此类）。
// 判定：subject=用户/User + predicate ∈ 动作流水词集 → 非画像、无跨会话价值。
// 保守取向：宁可少挡（偏好词如 偏好/希望/需要/喜欢/倾向/要求 一律保留），
// 只排除明确的一次性会话动作。本函数供读侧（composer 注入）与写侧（consolidation 落库前）双用。

/** 动作流水谓词（subject=用户 时判定为会话流水账，排除） */
export const ACTION_FLOW_PREDICATES = new Set([
  // 会话互动/询问类
  '询问', '问', '确认', '审批', '批准', '回复', '回应', '回答', '告知', '反馈', '报告',
  '表示', '告诉', '提及', '提到', '承认', '否认', '回答',
  // 动作执行类（已完成/进行中的一次性操作）
  '使用', '让', '叫', '打开', '关闭', '点击', '拉取', '克隆', '运行', '执行', '重启', '切换',
  '检查', '查看', '搜索', '上传', '下载', '安装', '删除', '创建', '编辑', '写入', '读取',
  '修复', '测试', '调试', '完成', '开始', '继续', '进行', '处理', '提交', '合并', '推送',
  '遇到', '发现', '报错', '卡在',
  // 状态转述类（瞬态，无跨会话价值）
  '处于', '从事', '知晓', '知道', '采用', '决定', '选择', '同意', '指示', '下令',
  // 英文兜底（LLM 偶发英文转写）
  'asked', 'confirmed', 'approved', 'replied', 'reported', 'used', 'requested',
  'mentioned', 'informed', 'told', 'checked', 'opened', 'closed', 'ran', 'executed',
  'restarted', 'switched', 'searched', 'downloaded', 'uploaded', 'created', 'deleted',
  'edited', 'completed', 'started', 'continued', 'finished', 'tested', 'fixed',
])

/** 是否会话动作流水形态（subject=用户 + 动作谓词）——是 → 不进观察/不注入 */
export function isActionFlowObservation(subject, predicate) {
  const s = String(subject ?? '').trim()
  if (s !== '用户' && s !== 'User' && s !== 'user') return false
  const p = String(predicate ?? '').trim()
  return ACTION_FLOW_PREDICATES.has(p)
}

// ===================== 一次性任务指令判别（阶段 2.3，2026-09-09） =====================
// 问题：134 条 user_preference 里真正跨会话的不到 20 条，其余是当次任务指令
// （"字体再大一些""改一下默认值"）——它们进 user_model 注入会稀释画像。
// 判别只针对 claimDomain==='user_preference'，且**保守**：宁可漏判也不误杀
// （明确耐久表达的偏好一律保留）。纯确定性实现，不调 LLM。

/** 强信号：指代当次上下文——离开当前会话即无意义。
 *  「这个/那个」排除成语用法（"这个时候""那个时候"）。 */
const EPHEMERAL_DEIXIS = /(?:这里|这边|这段|这行|这份|这页|该页|这张|此项|此处|上述|刚才|这版|那版|这个(?!时候)|那个(?!时候))/
/** 弱信号：命令式动作短语（需配合"无耐久标记"才判一次性） */
const EPHEMERAL_IMPERATIVE = /(?:先做|改一下|改下|试试|试下|弄一下|弄下|调一下|调整一下|看看|做吧|加上|去掉|删掉|换掉|再来|继续|接着|往下)/
/** 命令式只认开头 N 字内出现，或整条 ≤M 字——避免长文本夹一个"去掉"就误杀 */
const IMPERATIVE_HEAD_CHARS = 12
const IMPERATIVE_SHORT_CHARS = 40
/** 耐久信号：明确表达跨会话的稳定偏好 → 一律保留 */
// 注意：「默认」不在此列——它同时出现在任务指令里（"改一下默认值"），
// 判别保守取向是"宁可漏判"，所以只收明确表达跨会话稳定性的词。
const DURABLE_MARKER = /(?:之后|以后|统一|一律|总是|每次|习惯|偏好|一直|都要|永远|今后|往后|不喜欢|喜欢|倾向|原则|纪律|先行|优先|流程|规范|约定)/

/**
 * 是否为"一次性任务指令"（不应进 user_model 画像注入）。
 * @param {{claimDomain?: string, text?: string}} obs - observation 行
 * @returns {boolean} true = 判为一次性（读侧可据此过滤）
 */
export function isEphemeralPreference(obs) {
  if (!obs || obs.claimDomain !== 'user_preference') return false
  const text = String(obs.text ?? '')
  if (!text) return false
  if (DURABLE_MARKER.test(text)) return false
  if (EPHEMERAL_DEIXIS.test(text)) return true
  const m = EPHEMERAL_IMPERATIVE.exec(text)
  if (!m) return false
  return m.index < IMPERATIVE_HEAD_CHARS || text.length <= IMPERATIVE_SHORT_CHARS
}

/**
 * 读侧过滤闸门（阶段 2.3）：mode=off 全放行；shadow 只统计不生效；on 真过滤。
 * @param {{claimDomain?: string, text?: string}} obs
 * @param {'off'|'shadow'|'on'} mode
 * @returns {boolean} true = 允许进入注入候选
 */
export function preferenceFilterAllows(obs, mode = 'shadow') {
  if (mode === 'off') return true
  if (!isEphemeralPreference(obs)) return true
  return mode !== 'on'
}