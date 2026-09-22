// src/profile.mjs — Profile 物化视图（CONTRACTS.md §4）。A0（2026-09-22）
//
// 为什么现在有它：在 A0 之前，user_model 段的候选源是 **evidence 直供**——228 条真人短消息
// （「继续」「重启好了」）把 800 token 配额塞到 121%，而 CONTRACTS §4 定义的 Profile
// （五数组、可追溯到 session event）一行实现都没有。A0 把画像段改成由 Profile 喂，
// Profile 由 **observation** 构建——也就是「蒸馏过的稳定结论」，不是原始消息。
//
// 设计取舍（与 DREAMING.md §12.2 的初稿不同，以本文件为准）：
//   Profile **不落盘**，每步从 observation 现算。理由：源只有几十条，派生成本≈0，
//   而落盘视图会引入「缓存陈旧」这一整类故障。views are rebuildable —— 一个现算的视图
//   天然可重建，比落盘的更符合契约。

import { observationToCandidate } from './candidates.mjs'

/** CONTRACTS.md §4 的五个数组（顺序固定，渲染与测试都依赖它） */
export const PROFILE_ARRAYS = Object.freeze([
  'stableFacts', 'preferences', 'recentState', 'interactionPatterns', 'inferredTraits',
])

/**
 * claimDomain → Profile 数组。**未列出的域不进画像**：
 *   work              → work_state 段（与 Profile 分离，五条不可变原则之一）
 *   style             → expression 段
 *   experience / external_fact → memory 段
 */
export const PROFILE_DOMAIN_ARRAY = Object.freeze({
  user_fact: 'stableFacts',
  user_preference: 'preferences',
})

/** MVP 恒空的数组（CONTRACTS §4：recentState / interactionPatterns / inferredTraits 标注 v0.1 启用） */
export const PROFILE_EMPTY_IN_MVP = Object.freeze(['recentState', 'interactionPatterns', 'inferredTraits'])

export function profileArrayOf(claimDomain) {
  return PROFILE_DOMAIN_ARRAY[claimDomain] ?? null
}

export function isProfileDomain(claimDomain) {
  return profileArrayOf(claimDomain) !== null
}

/**
 * 加权（2026-09-22）：Profile 此前只按 observedAt 排序——「同一件事说了 6 次」和「随口提了一句」
 * 待遇完全一样。而 user_model 段是**饱和**的（766/800），进谁不进谁完全由排序决定，
 * 所以权重直接决定注入内容。三个确定性信号，全部可从库里现算：
 *
 *   evidenceCount  该 observation 的溯源证据条数（支撑强度）
 *   days          所属 dreaming 候选跨了几个自然日（复现稳定性；无候选时为 0）
 *   confirmed     该候选是否被人工批准（candidate_memory.state='approved'）
 *
 * 纪律：**只动 confidence，不碰 authority**。authority 是「写入时确定性声明」的安全核心
 * （AGENTS.md 铁律 2/3），且五铁律写明 Confidence is not authority——加权只能影响排序。
 */
export const PROFILE_WEIGHT = Object.freeze({
  base: 0.6,          // 与 observationToCandidate 的 confidence 一致（不加权时的原值）
  evidenceStep: 0.08, // 每多一条支撑证据
  evidenceMax: 4,     // 支撑加成封顶条数（+0.32）
  recurrenceStep: 0.08, // 每多跨一个自然日
  recurrenceMax: 3,   // 复现加成封顶天数（+0.24）
  confirmedBonus: 0.12, // 人工批准
  cap: 0.95,          // 上限（不宣称确定）
})

/**
 * 计算一条 Profile ref 的权重（纯函数、确定性）。
 * @param {number} evidenceCount
 * @param {{days?: number, sessions?: number, confirmed?: boolean}} [support]
 * @param {object} [cfg] - 覆盖 PROFILE_WEIGHT（测试用）
 * @returns {{weight: number, signals: object}}
 */
export function computeProfileWeight(evidenceCount, support = {}, cfg = PROFILE_WEIGHT) {
  const ev = Math.max(0, Number(evidenceCount) || 0)
  const days = Math.max(0, Number(support.days) || 0)
  const evBonus = Math.min(Math.max(0, ev - 1), cfg.evidenceMax) * cfg.evidenceStep
  const recBonus = Math.min(Math.max(0, days - 1), cfg.recurrenceMax) * cfg.recurrenceStep
  const confBonus = support.confirmed ? cfg.confirmedBonus : 0
  const raw = cfg.base + evBonus + recBonus + confBonus
  return {
    weight: Math.min(Math.round(raw * 1000) / 1000, cfg.cap),
    signals: {
      evidenceCount: ev,
      days,
      sessions: Math.max(0, Number(support.sessions) || 0),
      confirmed: Boolean(support.confirmed),
    },
  }
}

function sortKey(o) {
  return [String(o?.observedAt ?? o?.createdAt ?? ''), String(o?.id ?? '')]
}

/**
 * 从 observation 构建 Profile（纯函数，确定性）。
 * 每个数组元素是 ObservationRef —— 带 observationId 与 evidenceIds，
 * 因此 Profile item → Observation → Evidence → session event 三级回链可走通。
 * @param {object[]} observations - observation 行（camelCase）
 * @param {object} [opts]
 * @param {Map<string, {days?:number, sessions?:number, confirmed?:boolean}>} [opts.support]
 *        复现/批准信号（来自 candidate_memory）。缺省 → 全部按 base 权重，fail-open。
 * @returns {object} Profile（对应 CONTRACTS.md §4 的 interface）
 */
export function buildProfile(observations, opts = {}) {
  // support：Map<observationId, {days, sessions, confirmed}>，由调用方从 candidate_memory 构建。
  // 缺省（旧库 schema<7 / 查询失败）→ 空 Map → 权重退化为 base，fail-open。
  const support = opts.support instanceof Map ? opts.support : new Map()
  const profile = {
    subjectId: opts.scopeId ?? 'user-global',
    generatedAt: opts.generatedAt ?? null,
    sourceVersion: 0,
  }
  for (const arr of PROFILE_ARRAYS) profile[arr] = []

  const rows = (Array.isArray(observations) ? observations : [])
    .filter((o) => o && isProfileDomain(o.claimDomain))
    .slice()
    .sort((a, b) => {
      const [ta, ia] = sortKey(a)
      const [tb, ib] = sortKey(b)
      return ta.localeCompare(tb) || ia.localeCompare(ib)
    })

  for (const o of rows) {
    const evidenceIds = Array.isArray(o.evidenceIds) ? o.evidenceIds : []
    const { weight, signals } = computeProfileWeight(evidenceIds.length, support.get(o.id) ?? {})
    profile[profileArrayOf(o.claimDomain)].push({
      observationId: o.id,
      weight,
      signals,
      subject: o.subject ?? '',
      predicate: o.predicate ?? '',
      claimDomain: o.claimDomain,
      text: String(o.text ?? ''),
      authority: o.authority ?? 'single_observation',
      evidenceIds,
      observedAt: o.observedAt ?? null,
    })
  }
  // sourceVersion = 参与构建的 observation 条数（重放同一批源必然得到同一版本号）
  profile.sourceVersion = rows.length
  return profile
}

/** Profile 里所有 ObservationRef 的扁平列表（跨数组，顺序 = PROFILE_ARRAYS 顺序） */
export function profileRefs(profile) {
  const out = []
  for (const arr of PROFILE_ARRAYS) {
    for (const item of profile?.[arr] ?? []) out.push({ array: arr, ...item })
  }
  return out
}

/**
 * Profile → composer 候选（与 observationToCandidate 同形，多带 profileArray 供渲染/审计区分）。
 * 仍按 claimDomain 归段（user_fact / user_preference → user_model），与改动前一致。
 * @param {object} profile
 * @param {string} [fallbackScopeId]
 * @returns {object[]}
 */
export function profileToCandidates(profile, fallbackScopeId) {
  if (!profile) return []
  return profileRefs(profile)
    .filter((r) => r.text)
    .map((r) => ({
      ...observationToCandidate({
        id: r.observationId,
        subject: r.subject,
        predicate: r.predicate,
        claimDomain: r.claimDomain,
        text: r.text,
        authority: r.authority,
        evidenceIds: r.evidenceIds,
        scopeId: profile.subjectId,
        observedAt: r.observedAt,
      }, fallbackScopeId),
      profileArray: r.array,
      profileWeight: r.weight,
      profileSignals: r.signals,
      // 加权落到 confidence（排序信号），**不碰 authority**——见 PROFILE_WEIGHT 的纪律说明。
      confidence: typeof r.weight === 'number' ? r.weight : 0.6,
    }))
}
