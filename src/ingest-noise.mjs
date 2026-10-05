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

// 2026-10-04 bump 2：新增「工具执行回执」一类（审计发现 memory 段被它占满）。
//   实测：memory 段候选 99.7% 是 external_tool 转写，396 条抢 290 token，入选的全是
//   done / ok / written 11663 / report bytes: 13328 / still stale bytes 13326 这类**执行回执**。
//   它们没有信息量，却因为 tokens 小（效率高）把配额占满 —— 有内容的工具输出反而进不来。
export const INGEST_NOISE_VERSION = 2

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
  // ── 工具执行回执（2026-10-04，version 2）──────────────────────────────
  // ⚠️ 这一类**必须整条锚定**（^…$）—— 它们都是极端短的短语，做前缀或子串会误伤
  //    正常正文（比如一句话里提到「done」）。纪律见本文件头部第 1 条。
  Object.freeze({
    id: 'tool-receipt-bare',
    kind: 'regex',
    value: /^(?:done|ok|success|finished|empty|no output)\.?$/i,
    note: '工具/脚本的裸回执；实测样例 done / ok',
  }),
  Object.freeze({
    id: 'tool-receipt-written',
    kind: 'regex',
    // 两种形态都实测见过：
    //   `written 11663`（无文件名）
    //   `[d2-plugin-sources.md written] size=5543`（written 在方括号里）
    // ⇒ 第一条的文件名部分必须可选，第二条单独写。**整条锚定**，不做子串。
    value: /^(?:\[?[\w./\\-]{1,120}\]?\s+)?(?:written|created|updated|saved)\s+\d+\s*(?:bytes?|B)?\.?$/i,
    note: '写文件回执（无文件名形态）；实测样例「written 11663」',
  }),
  Object.freeze({
    id: 'tool-receipt-written-bracketed',
    kind: 'regex',
    value: /^\[[\w./\\-]{1,120}\s+written\]\s*(?:size\s*[:=]\s*\d+)?\.?$/i,
    note: '写文件回执（方括号形态）；实测样例「[d2-plugin-sources.md written] size=5543」',
  }),
  Object.freeze({
    id: 'tool-receipt-counts',
    kind: 'regex',
    value: /^(?:report\s+bytes|bytes|size|lines?|rows?)\s*[:=]?\s*\d+\s*(?:bytes?|B|行|条)?\.?$/i,
    note: '计数回执；实测样例「report bytes: 13328」',
  }),
  Object.freeze({
    id: 'tool-receipt-stale',
    kind: 'regex',
    value: /^(?:still\s+stale|unchanged|up[\s-]?to[\s-]?date|no\s+changes?)\b[\s\S]{0,40}$/i,
    note: '状态回执；实测样例「still stale\nbytes 13326」',
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
