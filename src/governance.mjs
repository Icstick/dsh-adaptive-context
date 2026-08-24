// src/governance.mjs — 读写边界守卫。
// Write Guard：sourceClass → claimDomain 权威约束、secret/PII 确定性扫描、payload 限制。
// Read Guard：scope/state/sensitivity/authority-domain 过滤。
// 全部确定性实现，不调用 LLM（OWASP AMG 参考：基础治理不需要为每次 read 再调模型）。

import { MAX_EVIDENCE_CONTENT_CHARS } from './constants.mjs'

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
  // external_tool 默认不能产生 personal-preference / style / behavior authority
  external_tool:    new Set(['user_fact', 'work', 'external_fact']),
  agent_authored:   new Set(['user_fact', 'work', 'experience', 'external_fact']), // 不能直接 claim preference/style
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

  // authority-domain 兼容：external_information 不能注入到需要 user_preference 权威的域
  if (ctx.targetDomain === 'user_preference' || ctx.targetDomain === 'style') {
    if (ev.authority === 'external_information') {
      return { allowed: false, reasons: ['external information lacks authority for personal preference domain'] }
    }
  }

  return { allowed: true, reasons }
}
