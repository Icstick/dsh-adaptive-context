// src/extract.mjs — SessionEvent → Evidence 规范化。
//
// 职责：把 DSH 的 durable session events 转成 Evidence 写入候选。
// 关键：sourceClass / authority / claimDomain 全部**确定性赋值**（不依赖 LLM）——
// 由事件类型 + 内容特征决定，保证写入时权威声明可信。
// 幂等：contentHash = sha256(规范化文本)，sourceRef = { sessionEventId }，
// 同一事件重放必然得到同一 Evidence id。

import { hashHex } from './constants.mjs'
import { agentAuthoredAuthority } from './governance.mjs'

/** 可摄入的 DSH session event 类型前缀 */
const WORTHY_PREFIXES = ['user/', 'assistant/', 'tool/', 'turn/']

/** 用户明确纠正的标记（事件类型或内容特征） */
const CORRECTION_MARKERS = [
  '更正', '纠正', '不对', '不是', '错了', '改成', '改为', '不要',
  'correction', 'actually', 'instead',
]

/**
 * 判断事件是否值得摄入为 Evidence。
 * @param {object} event - DSH session event
 * @returns {boolean}
 */
export function isEvidenceWorthy(event) {
  const type = event?.type ?? ''
  return WORTHY_PREFIXES.some((p) => type.startsWith(p)) && !!extractText(event)
}

/**
 * 从事件提取规范化文本（content）。
 * @param {object} event
 * @returns {string}
 */
export function extractText(event) {
  const text = event?.content ?? event?.text ?? event?.message?.content ?? ''
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * 从事件确定性推导 sourceClass。
 * @param {object} event
 * @returns {'system'|'user_input'|'user_correction'|'external_tool'|'agent_authored'}
 */
export function sourceClassOf(event) {
  const type = event?.type ?? ''
  if (type.startsWith('user/')) {
    return isCorrection(event) ? 'user_correction' : 'user_input'
  }
  if (type.startsWith('tool/')) return 'external_tool'
  if (type.startsWith('system/')) return 'system'
  return 'agent_authored'
}

/**
 * 是否判定为明确纠正。
 * 规则：user 消息 + 包含纠正标记词 → user_correction。
 * （保守：宁可少判纠正，也不把普通陈述当纠正。）
 * @param {object} event
 * @returns {boolean}
 */
export function isCorrection(event) {
  const text = extractText(event)
  if (!text) return false
  // 至少 2 个汉字 + 含标记词；单字"不/对"太宽松
  return CORRECTION_MARKERS.some((m) => text.includes(m)) && text.length >= 2
}

/**
 * 从事件确定性推导 authority（通过 sourceClass）。
 * @param {object} event
 * @returns {string} authority（7 值之一）
 */
export function authorityOf(event) {
  const sc = sourceClassOf(event)
  if (sc === 'agent_authored') {
    // 子规则：tool 内部自评？这里 MVP 简化为单次观察；
    // agent 自评/推断由上层显式传入 kind 覆盖。
    return agentAuthoredAuthority('observation')
  }
  switch (sc) {
    case 'system': return 'system_policy'
    case 'user_input': return 'user_explicit'
    case 'user_correction': return 'user_correction'
    case 'external_tool': return 'external_information'
    default: return 'single_observation'
  }
}

/**
 * 从事件确定性推导 claimDomain。
 * @param {object} event
 * @returns {string} claimDomain（6 值之一）
 */
export function claimDomainOf(event) {
  const sc = sourceClassOf(event)
  if (sc === 'user_correction') return 'user_preference'
  if (sc === 'external_tool') return 'external_fact'
  if (sc === 'user_input') return 'user_fact'
  if (sc === 'system') return 'external_fact'
  return 'experience'
}

/**
 * 事件 → Evidence 写入候选（完整规范化）。
 * @param {object} event - DSH session event
 * @param {object} [opts]
 * @param {string} [opts.scopeId]
 * @param {string} [opts.agentKey]
 * @param {string} [opts.sessionType]
 * @returns {object|null} Evidence candidate 或 null（不可摄入时）
 */
export function toEvidenceCandidate(event, opts = {}) {
  if (!isEvidenceWorthy(event)) return null
  const text = extractText(event)
  const sc = sourceClassOf(event)
  return {
    sourceClass: sc,
    authority: authorityOf(event),
    claimDomain: claimDomainOf(event),
    confidence: sc === 'user_correction' ? 1 : sc === 'user_input' ? 0.9 : 0.5,
    durability: sc === 'user_correction' ? 0.9 : 0.5,
    sensitivity: 'private',
    content: text,
    contentHash: hashHex(text),
    sourceRef: { sessionEventId: event.id ?? event.sessionEventId },
    scopeId: opts.scopeId ?? 'user-global',
    agentKey: opts.agentKey ?? '',
    sessionType: opts.sessionType ?? 'root',
    observedAt: new Date().toISOString(),
  }
}
