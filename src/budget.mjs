// src/budget.mjs — Context Composer 的 token 预算与遥测。
//
// 预算三级承诺（COMPOSER.md §5.4，2026-08-25 决策）：
//   MVP  ACP 增量 ≤ 900 tokens/step
//   v0.1 ACP 增量 ≤ 1200 tokens/step
//   长期 soft 6000 / hard 8000（与模型窗口 ratio 0.12 共同约束）
//
// 900 是 ACP 自己的增量预算，不含用户 prompt / DSH system / tools / history。
// Section quota：每类 context 一个上限，防止单一来源占满预算。

/** MVP 固定预算（tokens/step） */
export const MVP_TOTAL_BUDGET = 900

/** v0.1 目标预算 */
export const V01_TOTAL_BUDGET = 1200

/** 长期软/硬上限 */
export const SOFT_MAX = 6000
export const HARD_MAX = 8000

/** Section quota（MVP，COMPOSER.md §5.3） */
export const MVP_SECTION_QUOTA = Object.freeze({
  user_model: 180,     // Profile / 用户画像
  work_state: 250,     // WorkState / 决策
  memory: 300,         // Observations / 相关记忆
  expression: 120,     // Expression few-shot
  provenance: 50,      // 来源/安全标签
})
/** quota 合计 = 900，与 MVP_TOTAL_BUDGET 一致 */
export const MVP_SECTION_TOTAL = Object.freeze(
  Object.values(MVP_SECTION_QUOTA).reduce((a, b) => a + b, 0),
)

/** 每条候选 token 的估算（中英混合约 1 char ≈ 0.7 token） */
export function estimateTokens(text) {
  const s = String(text ?? '')
  return Math.ceil(s.length * 0.7)
}

/** telemetry 快照：一次 compose 的可观察输出（retrieved/admitted/dropped/tokens） */
export class ComposeTelemetry {
  constructor() {
    this.retrieved = 0
    this.admitted = 0
    this.dropped = []      // [{ id, reason }]
    this.sectionTokens = {} // { section: tokens }
    this.totalTokens = 0
  }
  get snapshot() {
    return {
      retrieved: this.retrieved,
      admitted: this.admitted,
      dropped: this.dropped,
      sectionTokens: this.sectionTokens,
      totalTokens: this.totalTokens,
    }
  }
}

/**
 * 按 section quota 装箱：utility/token 降序放入对应 section，超 quota 截断。
 * @param {object[]} candidates - { id, section, utility, tokens, content }
 * @param {object} [quota] - section 上限（默认 MVP_SECTION_QUOTA）
 * @returns {{items: object[], dropped: object[], sectionTokens: object, totalTokens: number}}
 */
export function packBySection(candidates, quota = MVP_SECTION_QUOTA) {
  const used = {}
  const items = []
  const dropped = []
  let totalTokens = 0

  // utility/token 降序（贪心装箱）
  const sorted = [...candidates].sort((a, b) => (b.utility / b.tokens) - (a.utility / a.tokens))

  for (const c of sorted) {
    const cap = quota[c.section]
    if (cap === undefined) {
      dropped.push({ id: c.id, reason: `unknown section '${c.section}'` })
      continue
    }
    const current = used[c.section] ?? 0
    if (current + c.tokens > cap) {
      dropped.push({ id: c.id, reason: `section '${c.section}' budget` })
      continue
    }
    used[c.section] = current + c.tokens
    totalTokens += c.tokens
    items.push(c)
  }

  return { items, dropped, sectionTokens: used, totalTokens }
}
