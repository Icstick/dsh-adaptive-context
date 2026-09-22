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

function sortKey(o) {
  return [String(o?.observedAt ?? o?.createdAt ?? ''), String(o?.id ?? '')]
}

/**
 * 从 observation 构建 Profile（纯函数，确定性）。
 * 每个数组元素是 ObservationRef —— 带 observationId 与 evidenceIds，
 * 因此 Profile item → Observation → Evidence → session event 三级回链可走通。
 * @param {object[]} observations - observation 行（camelCase）
 * @param {object} [opts]
 * @returns {object} Profile（对应 CONTRACTS.md §4 的 interface）
 */
export function buildProfile(observations, opts = {}) {
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
    profile[profileArrayOf(o.claimDomain)].push({
      observationId: o.id,
      subject: o.subject ?? '',
      predicate: o.predicate ?? '',
      claimDomain: o.claimDomain,
      text: String(o.text ?? ''),
      authority: o.authority ?? 'single_observation',
      evidenceIds: Array.isArray(o.evidenceIds) ? o.evidenceIds : [],
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
    }))
}
