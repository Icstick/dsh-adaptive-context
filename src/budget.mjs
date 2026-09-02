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
// 2026-09-02 修正：删除 provenance 配额——sectionOf 从不产出该 section，50 token 是死配额
// （配额表比没有配额更坏：看起来可分配，实际永远空转）。这 50 token 转给 memory，总额仍 900。
export const MVP_SECTION_QUOTA = Object.freeze({
  user_model: 180,     // Profile / 用户画像
  work_state: 250,     // WorkState / 决策（checkpoint 接线后启用）
  memory: 350,         // Observations / 相关记忆（原 300 + provenance 让出的 50）
  expression: 120,     // Expression few-shot
})
/** quota 合计 = 900，与 MVP_TOTAL_BUDGET 一致 */
export const MVP_SECTION_TOTAL = Object.freeze(
  Object.values(MVP_SECTION_QUOTA).reduce((a, b) => a + b, 0),
)

/** 单条注入行的固定开销：`[acp:sourceClass | id=... | domain=...]` 标签约 40-70 字符。
 *  旧实现完全不记账 → 预算账实不符（P0-3，2026-09-02）。 */
export const LINE_LABEL_TOKENS = 20

/** CJK 码点判定（统一表意文字 + 扩展区 + 全角/CJK 标点） */
function isCjkCodePoint(cp) {
  return (cp >= 0x3000 && cp <= 0x303f)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xffef)
    || (cp >= 0x20000 && cp <= 0x2fa1f)
}

/**
 * 每条候选的 token 估算。
 * P0-3（2026-09-02）：旧实现一律 `length × 0.7`，对中文**低估 30-40%**、对英文高估。
 * 改为分字符集估算：CJK ≈ 1.0 token/字，其余 ≈ 0.3 token/字。
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (isCjkCodePoint(ch.codePointAt(0))) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 1.0 + other * 0.3)
}

/**
 * 按 token 预算截断文本（与 estimateTokens 同一套字符成本）。
 * 决策 2（2026-09-02）：账本里 53.8% 的证据 >400 字符，在旧实现下**整条丢弃**、永远进不了注入面。
 * 改为截断 + 可回溯标注（保留 evidence id），把"看不见"变成"看得见摘要"。
 */
export function truncateToTokens(text, maxTokens) {
  const s = String(text ?? '')
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return ''
  let acc = 0
  let out = ''
  for (const ch of s) {
    const cost = isCjkCodePoint(ch.codePointAt(0)) ? 1 : 0.3
    if (acc + cost > maxTokens) break
    acc += cost
    out += ch
  }
  return out
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
export function packBySection(candidates, quota = MVP_SECTION_QUOTA, totalCap = undefined) {
  const used = {}
  const items = []
  const dropped = []
  let totalTokens = 0
  // P0-5（2026-09-02）：总预算上限真正生效。旧实现只看 section quota，
  // compose 文档里的 opts.maxTokens / config.hotTokens 传了没人读 = 死配置。
  const capTotal = Number.isFinite(totalCap) && totalCap > 0 ? totalCap : Infinity

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
    if (totalTokens + c.tokens > capTotal) {
      dropped.push({ id: c.id, reason: 'total budget' })
      continue
    }
    used[c.section] = current + c.tokens
    totalTokens += c.tokens
    items.push(c)
  }

  return { items, dropped, sectionTokens: used, totalTokens }
}
