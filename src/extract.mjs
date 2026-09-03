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
/** content 块数组 → 文本（type==='text' 块拼接；与 DSH 消息 content 形状同构） */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

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
    const t = blocksToText(msg?.content)
    if (t) parts.push(t)
  }
  return parts.join(' ').trim()
}

/**
 * 是否为压缩重建消息（compaction checkpoint）。
 * 官方引擎压缩后 append 一条 user/message 摘要消息，事件顶层带
 * surfaceOp={op:'replace',...} + sourceEventSeqs——这是系统重建产物，
 * 不是用户输入（用户真实消息 surfaceOp='append' 或无该字段）。
 * 原始被压内容在 append 实时流中已被摄取，跳过 checkpoint 不丢语义。
 * （2026-09-03 防御：防「已压缩 N 条」这类消息冒充 user_fact 入 ledger。）
 * @param {object} event
 * @returns {boolean}
 */
export function isCompactionCheckpoint(event) {
  const sop = event?.surfaceOp
  return !!sop && typeof sop === 'object' && sop.op === 'replace'
}

export function isEvidenceWorthy(event) {
  const type = event?.type ?? ''
  const text = extractText(event)
  if (isSystemInjected(text)) return false
  if (isCompactionCheckpoint(event)) return false // 压缩重建消息非用户输入（2026-09-03 防御）
  if (type === 'agent/inbox/spliced') return !!text
  return WORTHY_PREFIXES.some((p) => type.startsWith(p)) && !!text
}

/**
 * 是否系统注入内容（system-reminder：AGENTS.md 等指令文件以 user 角色注入模型 context）。
 * 这类内容是系统/项目指令的逐轮重复注入，不是用户输入；摄入会污染 ledger 并跨 session
 * 扩散项目内部指令（2026-08-30 问题记录 F3）。
 * @param {string} text
 * @returns {boolean}
 */
export function isSystemInjected(text) {
  return typeof text === 'string' && text.includes('<system-reminder>')
}

/**
 * 从事件提取规范化文本（content）。
 * @param {object} event
 * @returns {string}
 */
// P0-1（2026-09-03）：超长事件文本（如巨型 tool/result）入库前截断，保幂等（同一文本截断一致）
const MAX_EVENT_TEXT_CHARS = 4000

/**
 * 从事件提取规范化文本（content）。
 * 提取顺序：
 *   1. 事件顶层 content/text/message.content（synthetic 测试形态，content 可为字符串或块数组）
 *   2. agent/inbox/spliced → data.inserted[].content（用户/插件/协调者消息）
 *   3. P0-1：真实事件的 data.message.content[]（assistant/message、tool/result、user/message
 *      —— 真实文本全在 data 层，2026-09-03 校准；与 inbox inserted[].content 同构）
 * @param {object} event
 * @returns {string}
 */
export function extractText(event) {
  const direct = event?.content ?? event?.text ?? event?.message?.content
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, MAX_EVENT_TEXT_CHARS)
  if (Array.isArray(direct)) {
    const t = blocksToText(direct)
    if (t) return t.slice(0, MAX_EVENT_TEXT_CHARS)
  }
  const inboxText = textOfInboxMessage(event)
  if (inboxText) return inboxText.slice(0, MAX_EVENT_TEXT_CHARS)
  const dm = event?.data?.message
  if (dm && Array.isArray(dm.content)) {
    const t = blocksToText(dm.content)
    if (t) return t.slice(0, MAX_EVENT_TEXT_CHARS)
  }
  return ''
}

/**
 * 从事件提取消息来源 kind（agent/inbox/spliced 取 inserted[0].source.kind；
 * 其余按事件类型前缀推断）。取不到 → ''（不可判定）。
 * @param {object} event
 * @returns {string}
 */
export function eventKindOf(event) {
  const type = event?.type ?? ''
  if (type === 'agent/inbox/spliced') {
    return event?.data?.inserted?.[0]?.source?.kind ?? ''
  }
  // 2026-09-03 防御：事件自带 source.kind 且非 'user' → 按该 kind 归类，
  // 防插件/系统以 user 角色 append 的消息冒充真实用户（如压缩 checkpoint）。
  const sourceKind = event?.data?.source?.kind ?? ''
  if (sourceKind && sourceKind !== 'user') return sourceKind
  if (type.startsWith('user/')) return 'user'
  if (type.startsWith('tool/')) return 'tool'
  if (type.startsWith('system/')) return 'system'
  if (type.startsWith('assistant/')) return 'assistant'
  return ''
}

/**
 * 从事件确定性推导 sourceClass。
 *
 * DSH harness 实际 source.kind 映射（2026-08-30 校准，见 ISSUES-INJECTION-ISOLATION.md §2.1）：
 *   user              → user_input / user_correction（真实用户；子代理 prompt 派发也走
 *                       kind='user'，由调用方用 opts.subagent 在候选层降权，见 toEvidenceCandidate）
 *   tool              → external_tool
 *   plugin / agent    → agent_authored
 *   coordinator       → agent_authored（send_message 续派，tool-subagent-control）
 *   subagent-settled  → agent_authored（子代理完成通知，subagent/continuation）
 *   未知 kind         → agent_authored（保守：宁可不冒充用户，也不 fallback 到 user_input）
 * @param {object} event
 * @returns {'system'|'user_input'|'user_correction'|'external_tool'|'agent_authored'}
 */
export function sourceClassOf(event) {
  const kind = eventKindOf(event)
  if (kind === 'user') return isCorrection(event) ? 'user_correction' : 'user_input'
  if (kind === 'tool') return 'external_tool'
  if (kind === 'plugin' || kind === 'agent'
    || kind === 'coordinator' || kind === 'subagent-settled') return 'agent_authored'
  const type = event?.type ?? ''
  if (type.startsWith('system/')) return 'system'
  return 'agent_authored'
}

/**
 * 任务书特征前缀：父 agent 派发给子代理的完整任务书（含"不要改 X"等措辞，
 * 会被纠正标记词误判为 user_correction——2026-08-30 问题记录 F2）。
 * 保守判定：前缀命中且文本足够长（≥30 字符）才视为任务书；短句不受影响。
 */
const TASK_BRIEF_PREFIXES = ['你是', 'You are', '任务：', '项目：']
const TASK_BRIEF_MIN_LEN = 30

/**
 * 是否判定为明确纠正。
 * 规则：仅 user 来源消息 + 包含纠正标记词 → user_correction。
 * 排除：非 user 来源（tool/coordinator/subagent-settled/plugin/agent 永不判纠正）；
 *       任务书特征文本（父 agent 派发指令，非用户反馈）。
 * （保守：宁可少判纠正，也不把普通陈述/任务书当纠正。）
 * @param {object} event
 * @returns {boolean}
 */
export function isCorrection(event) {
  const text = extractText(event)
  if (!text) return false
  // 仅 user 来源可判纠正
  if (eventKindOf(event) !== 'user') return false
  // 任务书负向排除（前缀 + 长度；短句不误伤）
  if (text.length >= TASK_BRIEF_MIN_LEN) {
    for (const p of TASK_BRIEF_PREFIXES) {
      if (text.startsWith(p)) return false
    }
  }
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
 * @param {boolean} [opts.subagent] - 子代理会话降权（session.header.origin==='subagent'）：
 *   kind='user' 的消息无法与真实用户区分（父 agent 派发 prompt 也走 kind='user'），
 *   统一降权为 agent_authored/agent_inference/experience——记录但 quarantine
 *   （agent_inference 在 readGuard 全 ✗，不进任何会话注入），
 *   避免父任务书冒充用户指令（2026-08-30 问题记录 F4，决策 D2-A）。
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
  const cand = {
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
  // 子代理会话降权：user 消息（含父 prompt）→ agent_inference（记录但 quarantine）
  if (opts.subagent && (sc === 'user_input' || sc === 'user_correction')) {
    cand.sourceClass = 'agent_authored'
    cand.authority = 'agent_inference'
    cand.claimDomain = 'experience'
    cand.confidence = 0.5
    cand.durability = 0.5
  }
  return cand
}