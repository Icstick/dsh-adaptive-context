// src/composer.mjs — Context Composer：每个模型步骤前"什么进模型、什么不进"。
//
// 流程（COMPOSER.md §2）：
//   Resolve Scope → Resolve Work Focus → Policy/Safety → Disclosure
//   → Build RecallPlan → Parallel Provider Recall → Normalize
//   → Read Governance → Rank（Eligibility → Relevance）→ Diversity/Dedup
//   → Token Packing（section quota）→ Source-labelled Render
//
// MVP 实现为确定性管线（无 LLM reranker）：
//   候选来源 = Ledger query + 可选 Provider recall
//   → readGuard 过滤（资格）
//   → lexical 排序（无 Provider 时 semantic 并入 lexical）
//   → packBySection 装箱
//   → source-labelled render（plugin user message）
//
// 排序公式（COMPOSER.md §4，Provider 自适应）：
//   MemOS 在线：0.32×semantic + 0.18×lexical + 0.16×work_focus + 0.12×temporal_fit
//               + 0.10×evidence_support + 0.07×freshness + 0.05×provider_prior
//   本地 Ledger：semantic 并入 lexical → 0.50×lexical + 其余同
// 刻意不把 authority 乘进 score（authority 决定行为资格，不决定相关性）。

import { hashHex } from './constants.mjs'
import { readGuard } from './governance.mjs'
import { packBySection, estimateTokens, MVP_SECTION_QUOTA, MVP_TOTAL_BUDGET, ComposeTelemetry } from './budget.mjs'

// —— 权重（COMPOSER.md §4）——
export const WEIGHTS = Object.freeze({
  semantic: 0.32,
  lexical: 0.18,
  workFocus: 0.16,
  temporalFit: 0.12,
  evidenceSupport: 0.10,
  freshness: 0.07,
  providerPrior: 0.05,
})

/** 无 Provider 时 semantic 并入 lexical（2026-08-25 决策） */
export const LEXICAL_WITHOUT_SEMANTIC = WEIGHTS.lexical + WEIGHTS.semantic

/**
 * 计算两个文本的 lexical 重叠分（0..1）：query 词元在 content 中出现的比例。
 * CJK 按连续段切分（子串匹配，中文友好）。
 * @param {string} query
 * @param {string} content
 * @returns {number}
 */
export function lexicalScore(query, content) {
  const q = String(query ?? '').toLowerCase()
  const c = String(content ?? '').toLowerCase()
  if (!q || !c) return 0
  const tokens = q.split(/[\s\p{P}]+/u).filter((t) => t.length > 0)
  if (tokens.length === 0) return 0
  // CJK：整串命中=1；否则按 bigram 重叠比例（连续 2 字符窗口）
  if (/[\u4e00-\u9fff]/.test(q)) {
    if (c.includes(q)) return 1
    const grams = new Set()
    for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2))
    if (grams.size === 0) return 0
    let hit = 0
    for (const g of grams) if (c.includes(g)) hit += 1
    return hit / grams.size
  }
  let hit = 0
  for (const t of tokens) {
    if (c.includes(t)) hit += 1
  }
  return hit / tokens.length
}

/**
 * 计算 evidence_support 分（0..1）。
 * 输入候选的 evidenceIds 数量（Observation 才有）；原始 Evidence 无 → 用 confidence 近似。
 * @param {object} cand
 * @returns {number}
 */
export function evidenceSupportScore(cand) {
  if (Array.isArray(cand.evidenceIds) && cand.evidenceIds.length > 0) {
    return Math.min(1, cand.evidenceIds.length / 5)
  }
  if (typeof cand.confidence === 'number') return cand.confidence
  return 0.5
}

/**
 * 计算 temporal_fit（0..1）：候选在"现在"是否有效。
 * @param {object} cand
 * @param {string} [validAt]
 * @returns {number}
 */
export function temporalFitScore(cand, validAt) {
  if (!validAt) return 1 // 未指定时间 → 不惩罚
  if (cand.validFrom && cand.validFrom > validAt) return 0.1
  if (cand.validUntil && cand.validUntil < validAt) return 0.1
  return 1
}

/**
 * 计算 freshness（0..1）：observedAt 越新越高（30 天衰减）。
 * @param {object} cand
 * @param {number} [now]
 * @returns {number}
 */
export function freshnessScore(cand, now = Date.now()) {
  if (!cand.observedAt) return 0.5
  const t = new Date(cand.observedAt).getTime()
  if (Number.isNaN(t)) return 0.5
  const ageMs = Math.max(0, now - t)
  return Math.max(0, 1 - ageMs / (30 * 24 * 3600 * 1000))
}

/**
 * 单条候选的 utility 计算（COMPOSER.md §4）。
 * @param {object} cand - { content, confidence?, evidenceIds?, validFrom?, validUntil?, observedAt?, workMatch?, providerScore?, explicitRef?, explicitCorrection? }
 * @param {object} opts - { query, validAt?, hasProvider?, now? }
 * @returns {{relevance: number, quality: number, utility: number}}
 */
export function utilityOf(cand, opts = {}) {
  const lex = lexicalScore(opts.query, cand.content)
  const semantic = opts.hasProvider ? (cand.providerScore ?? 0) : 0
  const lexEffective = opts.hasProvider ? lex : lex
  const lexicalW = opts.hasProvider ? WEIGHTS.lexical : LEXICAL_WITHOUT_SEMANTIC
  const semanticTerm = opts.hasProvider ? WEIGHTS.semantic * semantic : 0

  const relevance =
    semanticTerm
    + lexicalW * lexEffective
    + WEIGHTS.workFocus * (cand.workMatch ?? 0)
    + WEIGHTS.temporalFit * temporalFitScore(cand, opts.validAt)
    + WEIGHTS.evidenceSupport * evidenceSupportScore(cand)
    + WEIGHTS.freshness * freshnessScore(cand, opts.now)
    + WEIGHTS.providerPrior * (cand.providerPrior ?? 0)

  const quality = 0.50 + 0.50 * (cand.confidence ?? 0.5)
  let utility = relevance * quality
  if (cand.explicitRef) utility += 0.2   // explicit_ref_boost
  if (cand.explicitCorrection) utility += 0.3 // explicit_correction_boost（更高）
  return { relevance, quality, utility }
}

/**
 * Context Composer 主入口。
 *
 * @param {object[]} rawCandidates - 候选（Ledger query 结果 / Provider recall 结果）
 * @param {object} opts
 * @param {string} [opts.query] - 当前用户消息/查询（用于 self-echo 过滤，空则不启用）
 * @param {string} [opts.scopeId] - 作用域
 * @param {string} [opts.targetDomain] - 目标域（readGuard 矩阵查表用）
 * @param {string} [opts.validAt] - 时间点（temporal 过滤）
 * @param {boolean} [opts.hasProvider] - 是否有语义 Provider（MemOS 在线）
 * @param {object} [opts.quota] - section quota（默认 MVP）
 * @param {number} [opts.maxTokens] - 总预算上限（默认 MVP_TOTAL_BUDGET）
 * @returns {{items: object[], dropped: object[], telemetry: object}}
 */
export function compose(rawCandidates, opts = {}) {
  const telemetry = new ComposeTelemetry()
  telemetry.retrieved = (rawCandidates ?? []).length

  // —— Eligibility：readGuard 过滤（scope/state/sensitivity/temporal/authority-domain）——
  const eligible = []
  for (const cand of rawCandidates ?? []) {
    const g = readGuard(cand, {
      scopeId: opts.scopeId,
      targetDomain: opts.targetDomain,
      validAt: opts.validAt,
    })
    if (g.allowed) eligible.push(cand)
    else telemetry.dropped.push({ id: cand.id, reason: g.reasons.join(';') })
  }

  // —— Rank：utility 计算 + 候选元数据补齐 ——
  const ranked = eligible.map((cand) => {
    const { utility } = utilityOf(cand, {
      query: opts.query,
      validAt: opts.validAt,
      hasProvider: opts.hasProvider,
      now: opts.now,
    })
    const section = sectionOf(cand)
    const tokens = estimateTokens(cand.content)
    return { ...cand, utility, section, tokens }
  })

  // —— Self-echo 过滤（T1）：当前用户消息（opts.query）不应被自己注回 ——
  // 摄入发生在 agent/pre-step 之前：pre-step 时 ledger 里已有当前 turn 刚摄入的
  // 用户消息，若不排除会把它自己注回模型 context（回声）。
  // 判定：候选 content 完全等于 query，或 content 包含 query（query 是 content 的子串）
  //   → dropped，reason='self-echo'。
  // 反向（query 包含 content，即用户问句包含历史短事实）→ 保留。
  // opts.query 为空时不启用该过滤。
  const queryText = opts.query ? String(opts.query) : ''
  const noEcho = []
  if (queryText) {
    for (const cand of ranked) {
      const content = String(cand.content ?? '')
      if (content === queryText || content.includes(queryText)) {
        telemetry.dropped.push({ id: cand.id, reason: 'self-echo' })
      } else {
        noEcho.push(cand)
      }
    }
  } else {
    noEcho.push(...ranked)
  }

  // —— Dedup：先按 id（跨 Provider 重复），再按 contentHash（内容重复，T2）——
  // contentHash = cand.contentHash ?? hashHex(cand.content)；同 hash 仅保留 utility
  // 最高的一条（按 utility 降序后首次出现者保留），其余 dropped，reason='duplicate-content'。
  // packBySection 会再按 utility/token 排序，此处重排无副作用。
  const seen = new Set()
  const idDeduped = []
  for (const c of noEcho) {
    if (seen.has(c.id)) {
      telemetry.dropped.push({ id: c.id, reason: 'duplicate' })
      continue
    }
    seen.add(c.id)
    idDeduped.push(c)
  }

  const byUtilityDesc = [...idDeduped].sort((a, b) => b.utility - a.utility)
  const bestByHash = new Set()
  const deduped = []
  for (const c of byUtilityDesc) {
    const hash = c.contentHash ?? hashHex(String(c.content ?? ''))
    if (bestByHash.has(hash)) {
      telemetry.dropped.push({ id: c.id, reason: 'duplicate-content' })
    } else {
      bestByHash.add(hash)
      deduped.push(c)
    }
  }

  // —— Token Packing：section quota + 总预算 ——
  const packed = packBySection(deduped, opts.quota ?? MVP_SECTION_QUOTA)
  telemetry.dropped.push(...packed.dropped)
  telemetry.admitted = packed.items.length
  telemetry.sectionTokens = packed.sectionTokens
  telemetry.totalTokens = packed.totalTokens

  return {
    items: packed.items,
    dropped: telemetry.dropped,
    telemetry: telemetry.snapshot,
  }
}

/** 候选 → section 归类（MVP 简化：按 claimDomain） */
export function sectionOf(cand) {
  const domain = cand.claimDomain ?? ''
  if (domain === 'user_preference' || domain === 'user_fact') return 'user_model'
  if (domain === 'work') return 'work_state'
  if (domain === 'style') return 'expression'
  if (domain === 'experience' || domain === 'external_fact') return 'memory'
  return 'memory'
}

/**
 * 渲染为 source-labelled plugin message（untrusted historical context）。
 * @param {object[]} items
 * @returns {string}
 */
export function renderSourceLabelled(items) {
  return items
    .map((cand) =>
      `[acp:${cand.sourceClass ?? 'evidence'} | id=${cand.id} | domain=${cand.claimDomain ?? ''}] ${cand.content}`)
    .join('\n')
}
