// src/constants.mjs — ACP 枚举、阈值与固定值。零依赖。
// 语义来自 CONTRACTS.md：confidence/authority/durability/relevance 四维分离。

import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const DEFAULT_DB_NAME = 'acp-ledger.db'

/** Evidence 状态机 */
export const EVIDENCE_STATES = Object.freeze([
  'active',      // 正常可用
  'quarantined', // 可疑，不注入
  'superseded',  // 被新证据替代（不物理删除）
  'redacted',    // 内容被脱敏
])

/** 来源分类：决定写入时的权威约束 */
export const SOURCE_CLASSES = Object.freeze([
  'system',
  'user_input',
  'user_correction',
  'external_tool',
  'agent_authored',
])

/** 权威层级：从高到低（写入时确定性声明 7 值，2026-08-25 决策）。
 *  user_repeated_behavior 已移除——"多次观察累积"由 Observation 层表达。 */
export const AUTHORITY_ORDER = Object.freeze([
  'system_policy',
  'user_explicit',
  'user_correction',
  'single_observation',
  'agent_inference',
  'agent_self_evaluation',
  'external_information',
])
export const AUTHORITIES = Object.freeze([...AUTHORITY_ORDER])

/** 声明域：一条证据属于什么知识 */
export const CLAIM_DOMAINS = Object.freeze([
  'user_fact',
  'user_preference',
  'work',
  'experience',
  'style',
  'external_fact',
])

/** 敏感度 */
export const SENSITIVITIES = Object.freeze([
  'public',
  'private',
  'sensitive',
  'secret',
])

/** 会话类型：防 subagent 污染（OpenViking issue 教训） */
export const SESSION_TYPES = Object.freeze([
  'root',
  'subagent',
  'fork',
])

/** 作用域（对齐 dsh-memento 语义） */
export const SCOPES = Object.freeze([
  'user-global',
  'workspace',
])

/** 错误码 */
export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  DENIED: 'DENIED',
  QUARANTINED: 'QUARANTINED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
})

/** 写入最大内容长度（字符） */
export const MAX_EVIDENCE_CONTENT_CHARS = 8000

/** 确定性 content hash（sha256 hex） */
export function hashHex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 幂等键 = hash(sourceRef 规范化 JSON + contentHash)，重放同一事件必然得到同一 id */
export function evidenceIdOf({ sourceRef, contentHash }) {
  const src = sourceRef ? JSON.stringify(sourceRef) : ''
  return 'ev_' + hashHex(src + '|' + contentHash).slice(0, 24)
}