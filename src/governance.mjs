// src/governance.mjs — 读写边界守卫。
// Write Guard：sourceClass → claimDomain 权威约束、secret/PII 确定性扫描、payload 限制。
// Read Guard：scope/state/sensitivity/authority-domain 过滤。
// 全部确定性实现，不调用 LLM（OWASP AMG 参考：基础治理不需要为每次 read 再调模型）。

import { MAX_EVIDENCE_CONTENT_CHARS, CLAIM_DOMAINS } from './constants.mjs'

// --- 确定性 secret/PII 模式（保守，宁可 quarantine 也不放行） ---
const SECRET_PATTERNS = [
  /\b(?:sk|pk|api[_-]?key|token|secret|password|passwd|pwd|credential|bearer|private[_-]?key|access[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,                 // GitHub PAT
  /\bgho_\w{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,         // Slack token
  /\bAKIA[0-9A-Z]{16}\b/,                     // AWS access key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

// --- 确定性 prompt-injection 提示词（保守） ---
const INJECTION_PATTERNS = [
  /ignore (?:all |the )?(?:previous|prior|above|earlier) (?:instructions?|prompts?|rules?|context)/i,
  /disregard (?:all |the )?(?:previous|prior) (?:instructions?|prompts?|rules?)/i,
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