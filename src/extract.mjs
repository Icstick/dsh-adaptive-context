// src/extract.mjs — SessionEvent → Evidence 规范化。
//
// 职责：把 DSH 的 durable session events 转成 Evidence 写入候选。
// 关键：sourceClass / authority / claimDomain 全部**确定性赋值**（不依赖 LLM）——
// 由事件类型 + 内容特征决定，保证写入时权威声明可信。
// 幂等：contentHash = sha256(规范化文本)，sourceRef = { sessionEventId }，
// 同一事件重放必然得到同一 Evidence id。
//
// 2026-08-26 真实契约校准：DSH 的真实事件是
//   agent/inbox/spliced（用户/工具/插件消息，data.inserted[]）
//   turn/start、turn/end、permission/*、sandbox/* 等
// 同时保留 synthetic 测试类型（user/message、tool/result、assistant/message）。

import { hashHex } from './constants.mjs'
import { agentAuthoredAuthority } from './governance.mjs'

/** 可摄入的 DSH session event 类型前缀/名称 */
const WORTHY_PREFIXES = ['user/', 'assistant/', 'tool/', 'turn/', 'agent/inbox/spliced']

/** 用户明确纠正的标记（事件类型或内容特征） */
const CORRECTION_MARKERS = [
  '更正', '纠正', '不对', '不是', '错了', '改成', '改为', '不要',
  'correction', 'actually', 'instead',
]

/**
 * 从 agent/inbox/spliced 事件的 data.inserted[] 提取文本
 * （真实 DSH 事件：inserted = [{ content: [{type:'text',text}], source:{kind}, role, id }]）。
 * @param {object} event
 * @returns {string}
 */
export function textOfInboxMessage(event) {
  const inserted = event?.data?.inserted
  if (!Array.isArray(inserted)) return ''
  const parts = []
  for (const msg of inserted) {
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}

/**
 * 判断事件是否值得摄入为 Evidence。
 * @param {object} event - DSH session event
 * @returns {boolean}
 */
export function isEvidenceWorthy(event) {
  const type = event?.type ?? ''
  if (type === 'agent/inbox/spliced') return !!textOfInboxMessage(event)
  return WORTHY_PREFIXES.some((p) => type.startsWith(p)) && !!extractText(event)
}

/**
 * 从事件提取规范化文本（content）。
 * @param {object} event
 * @returns {string}
 */
export function extractText(event) {
  const direct = event?.content ?? event?.text ?? event?.message?.content
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  return textOfInboxMessage(event)
}

/**
 * 从事件确定性推导 sourceClass。
 * @param {object} event
 * @returns {'system'|'user_input'|'user_correction'|'external_tool'|'agent_authored'}
 */
export function sourceClassOf(event) {
  const type = event?.type ?? ''
  if (type === 'agent/inbox/spliced') {
    const kind = event?.data?.inserted?.[0]?.source?.kind
    if (kind === 'user') return isCorrection(event) ? 'user_correction' : 'user_input'
    if (kind === 'tool') return 'external_tool'
    if (kind === 'plugin' || kind === 'agent') return 'agent_authored'
    return 'user_input'
  }
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
 * @param {string} [opts.sessionId] - session id（真实事件用 sessionId:seq 作 sourceRef）
 * @param {string} [opts.agentKey]
 * @param {string} [opts.sessionType]
 * @returns {object|null} Evidence candidate 或 null（不可摄入时）
 */
export function toEvidenceCandidate(event, opts = {}) {
  if (!isEvidenceWorthy(event)) return null
  const text = extractText(event)
  const sc = sourceClassOf(event)
  // sourceRef：真实 DSH 事件有 seq（session 内唯一）无 id；synthetic 测试事件有 id
  const eventRef = opts.sessionId && event.seq != null
    ? opts.sessionId + ':' + event.seq
    : (event.id ?? event.sessionEventId ?? String(event.seq ?? ''))
  return {
    sourceClass: sc,
    authority: authorityOf(event),
    claimDomain: claimDomainOf(event),
    confidence: sc === 'user_correction' ? 1 : sc === 'user_input' ? 0.9 : 0.5,
    durability: sc === 'user_correction' ? 0.9 : 0.5,
    sensitivity: 'private',
    content: text,
    contentHash: hashHex(text),
    sourceRef: { sessionEventId: eventRef },
    scopeId: opts.scopeId ?? 'user-global',
    agentKey: opts.agentKey ?? '',
    sessionType: opts.sessionType ?? 'root',
    observedAt: new Date().toISOString(),
  }
}
