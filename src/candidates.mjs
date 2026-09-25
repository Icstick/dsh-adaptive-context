// src/candidates.mjs — 各来源行 → composer 候选的纯映射（2026-09-22 从 index.mjs 搬出）。
//
// 为什么要独立成模块：A0 的 Profile 视图（src/profile.mjs）需要复用 observationToCandidate，
// 而 profile.mjs 若 import index.mjs 就形成 index → profile → index 的**循环依赖**（depcruise 会拦）。
// 搬到中性模块后两边单向依赖，映射只有一份，不复制。
// index.mjs 仍然 re-export 本函数，既有调用方（含 test/p3-profile-injection.test.mjs）不受影响。

import { classifyBacklink } from './backlink.mjs'

/**
 * P1-1（2026-09-02）：Observation → composer 候选。
 *
 * 背景：observation 层（subject/predicate/text≤500 的浓缩认知）**写了从来没人读**——
 * 4 个查询接口在生产代码零调用方，8 条 observation 从未进过注入。而"索引常驻、正文按需"
 * 这套两段式注入需要的浓缩层，其实已经躺在库里。
 *
 * 权威定级（P3，2026-09-07，PLAN-S2 §8.3 修正）：observation 是蒸馏产物 ≠ 原始 evidence，
 * 其权威来自溯源证据（store.upsertObservation 写行时按 evidenceIds 聚合落 authority 列，
 * 见 store.deriveObservationAuthority）。行 authority 缺失/未知（旧行、无溯源）回退
 * single_observation——单次观察不得影响 user_preference/style（矩阵兜底）。
 * confidence 0.6：不宣称权威（五铁律：Confidence is not authority）。
 *
 * 注入面标签 sourceClass='observation'：只用于渲染标签与候选语义，不参与写入侧
 * sourceClass 枚举（那 5 值是写边界约束）。无 sessionId → 不过跨会话闸门、不罚降权
 * （稳定画像全局可见 = P3 放行语义；原始 user_input 的 F7 闸门不受影响）。
 *
 * 2026-09-25（方案 3）：多带一个 `backlinkTier`（src/backlink.mjs 的分层），用来区分
 * 「外机导入、回链按设计清空 → 不可核验」与「本机产出却没回链 → 真异常」。
 * **纯标注**：confidence / durability / authority 一律不动 —— 空回链的候选本来就有
 * evidenceSupportScore → confidence 的兜底（composer.mjs:146），不是「被压到 0」。
 */
export function observationToCandidate(o, fallbackScopeId) {
  const subject = String(o.subject ?? '').trim()
  const predicate = String(o.predicate ?? '').trim()
  const text = String(o.text ?? '').trim()
  const head = subject && predicate ? subject + ' ' + predicate + '：' : ''
  // 档位判据需要 scopeId（id 的派生输入之一）；缺失时只报 unknown，不指控任何一方
  const effectiveScopeId = o.scopeId ?? fallbackScopeId
  const backlink = effectiveScopeId
    ? classifyBacklink({ ...o, scopeId: effectiveScopeId })
    : { tier: 'unknown', foreign: false }
  return {
    id: o.id,
    content: head + text,
    sourceClass: 'observation',
    claimDomain: o.claimDomain ?? 'experience',
    authority: o.authority ?? 'single_observation',
    confidence: 0.6,
    durability: 0.6,
    sensitivity: 'private',
    state: 'active',
    scopeId: o.scopeId ?? fallbackScopeId,
    observedAt: o.createdAt ?? o.observedAt,
    sourceRef: { kind: 'observation', evidenceIds: o.evidenceIds ?? [] },
    evidenceIds: o.evidenceIds ?? [],
    isObservation: true,
    backlinkTier: backlink.tier,
    backlinkForeign: backlink.foreign === true,
  }
}
