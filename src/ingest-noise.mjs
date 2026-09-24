// src/ingest-noise.mjs — 机器模板冻结表（2026-09-24）
// ---------------------------------------------------------------------------
// 背景：账本摄入面带进大量「机器自己产生的文本」——子代理任务书 / context-maid 归档 /
// 子代理完成横幅 / system-reminder 注入。2026-09-24 实测：1669 条 evidence 处于
// quarantined/redacted，其中 101 条 active observation 仍引用它们、**28 条已进 Profile 注入**
// （见 docs/ops/acp-ingest-cascade-20260924.md）。
//
// 两条硬纪律（都是实测踩出来的，别绕）：
//   1. **只做前缀 / 整行锚定匹配，绝不做子串**。审计动作本身会写账本：实测那条
//      「分析长文里引用了模板串」的命中位置在 @700 —— 子串判定会把自己写的分析文当噪声。
//   2. **模板表冻结在这里**：加/改模板要显式改本文件并 bump INGEST_NOISE_VERSION，
//      不要在调用点临时拼正则 —— 否则判据会随调用点漂移，且无法审计「哪个版本拦了什么」。

export const INGEST_NOISE_VERSION = 1

/**
 * 冻结模板表。
 * kind: 'prefix'（content 去掉前导空白后以其开头）| 'regex'（对同一归一后的文本做锚定匹配）
 */
export const MACHINE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'reviewer-prompt',
    kind: 'prefix',
    value: 'You are the background skill reviewer.',
    note: 'background skill reviewer 任务书；08-30 那批还落成了 user_correction/user_preference',
  }),
  Object.freeze({
    id: 'maid-archive',
    kind: 'prefix',
    value: '【maid 压缩归档】',
    note: 'context-maid 压缩归档正文',
  }),
  Object.freeze({
    id: 'subagent-banner',
    kind: 'regex',
    value: /^Background subagent [0-9a-f-]{36} (?:reported|finished)/,
    note: '子代理完成横幅（kind=subagent-settled）；历史 57 条被记成 user_explicit/user_fact',
  }),
  Object.freeze({
    id: 'system-reminder',
    kind: 'prefix',
    value: '<system-reminder',
    note: '系统注入块；AGENTS.md 铁律 7 本就要求解析会话事件时跳过它',
  }),
])

/** 前导空白（含全角空格）归一，供前缀判定用 */
const LEAD_WS = /^[\s\u3000]+/

/**
 * 命中哪条模板。
 * @param {string} text
 * @returns {{id:string, kind:string, note:string}|null} 命中的模板（不含 pattern 本身）或 null
 */
export function machineTemplateOf(text) {
  const s = String(text ?? '')
  if (!s) return null
  const body = s.replace(LEAD_WS, '')
  for (const t of MACHINE_TEMPLATES) {
    const hit = t.kind === 'prefix' ? body.startsWith(t.value) : t.value.test(body)
    if (hit) return { id: t.id, kind: t.kind, note: t.note }
  }
  return null
}

/** @returns {boolean} */
export function isMachineTemplate(text) {
  return machineTemplateOf(text) !== null
}
