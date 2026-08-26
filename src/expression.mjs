// src/expression.mjs — Expression manual promotion（P1-6 / T6，决策 5B=approval 审批门）。
//
// 设计来源：EXPRESSION.md + M2-PLAN.md 决策点 5B。
// 核心语义：style/expression 证据的 candidate→confirmed 手动路径——用户通过
// approval 审批面板确认（reviewStatus='promoted'）或驳回（reviewStatus='dismissed'）。
//
// 铁律对齐：
//   - Learning does not imply promotion：单一自动信号永不直接提升表达风格权威，
//     必须过 human-in-the-loop 审批门（EXPRESSION.md §1 不变量）。
//   - Evidence is truth：审批结果只写 evidence.metadata.reviewStatus，证据行本身
//     append-only 不动；结果可导出审计（GOVERNANCE.md 审计三链之一环）。
//   - fail-open：approval 服务不可用/调用故障时静默跳过（debug/warn 日志），
//     绝不抛错阻断 turn。
//
// 接口说明（与 M2-PLAN 任务规格对齐）：
//   applyPromotionDecision(ledger, evidenceId, decision) — 纯函数，ledger 显式传入。
//   createExpression({ ledger }) → { requestPromotion(candidate, ctx) } — requestPromotion
//     依赖 ledger，经工厂闭包注入；对外保持规格签名 (candidate, ctx) 两参，
//     index.mjs 桥与 C 组接缝 acp.requestPromotion(candidate, ctx) 直接兼容。

/** 审批面板可识别的 toolName（对齐 memento askApproval 的 {toolName, reason} 形状）。 */
export const PROMOTION_TOOL_NAME = 'acp.promotion'

/** reviewStatus 合法值（metadata 固定键集已含 reviewStatus，见 store.mjs） */
export const REVIEW_STATUSES = Object.freeze(['promoted', 'dismissed'])

/**
 * 应用人工审批决策：evidence.metadata.reviewStatus 迁移为 promoted/dismissed。
 * @param {object} ledger - openEvidenceLedger() 返回的 Provider
 * @param {string} evidenceId - 目标证据 id
 * @param {'promoted'|'dismissed'} decision - 审批结果
 * @returns {object} 更新后的证据行
 * @throws {TypeError} decision 非 promoted|dismissed
 * @throws {Error} evidenceId 不存在（ledger.updateMetadata 抛 evidence '<id>' not found）
 */
export function applyPromotionDecision(ledger, evidenceId, decision) {
  if (!REVIEW_STATUSES.includes(decision)) {
    throw new TypeError(`decision must be 'promoted'|'dismissed', got ${JSON.stringify(decision)}`)
  }
  return ledger.updateMetadata(evidenceId, { reviewStatus: decision })
}

/**
 * 构造 approval/request 载荷：证据内容 + source 溯源 + promote/dismiss 语义。
 * 形状对齐 memento askApproval 的 {agent?, toolName, reason}（ApprovalLike.request 契约）。
 * @param {{id?: string, content?: string, claimDomain?: string, sourceRef?: object, agent?: unknown}} candidate
 * @returns {{agent?: unknown, toolName: string, reason: string}}
 */
export function buildPromotionRequest(candidate = {}) {
  const request = {
    toolName: PROMOTION_TOOL_NAME,
    reason: [
      'ACP expression promotion (reviewStatus: promoted | dismissed)',
      'evidenceId: ' + String(candidate.id ?? '(none)'),
      'claimDomain: ' + String(candidate.claimDomain ?? '(none)'),
      'content: ' + String(candidate.content ?? ''),
      'sourceRef: ' + JSON.stringify(candidate.sourceRef ?? {}),
    ].join('\n'),
  }
  if (candidate.agent !== undefined) request.agent = candidate.agent
  return request
}

/**
 * 内部实现：发起审批请求并按 outcome 落 reviewStatus。
 * ledger 由 createExpression 闭包注入；对外两参签名 (candidate, ctx)。
 * @param {{id: string, content?: string, claimDomain?: string, sourceRef?: object, agent?: unknown}} candidate
 * @param {object} ctx - cordis Context（只显式 ctx.get('approval')，遵守 proxy 铁律）
 * @param {object} ledger - Evidence Ledger Provider
 * @returns {Promise<object|null>} 审批通过/驳回后返回更新行；跳过/未知 outcome 返回 null
 */
async function requestPromotionImpl(candidate, ctx, ledger) {
  const evidenceId = candidate?.id
  if (!evidenceId) {
    ctx?.logger?.debug?.('[acp] promotion skipped: candidate has no id')
    return null
  }
  // withService 可选模式（运行时形态）：服务缺失/无 request 方法 → 静默跳过
  const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
  if (!approval || typeof approval.request !== 'function') {
    ctx?.logger?.debug?.('[acp] approval service unavailable; promotion request skipped (evidence ' + evidenceId + ')')
    return null
  }
  let outcome
  try {
    outcome = await approval.request(buildPromotionRequest(candidate))
  } catch (err) {
    // fail-open：审批服务故障不阻断调用方，只记日志
    ctx?.logger?.warn?.('[acp] approval request failed: ' + (err && err.message))
    return null
  }
  // 审批面板 outcome：approved → promoted；rejected → dismissed；其余（如 unavailable）忽略
  if (outcome === 'approved') return applyPromotionDecision(ledger, evidenceId, 'promoted')
  if (outcome === 'rejected') return applyPromotionDecision(ledger, evidenceId, 'dismissed')
  ctx?.logger?.debug?.('[acp] promotion outcome ignored: ' + String(outcome))
  return null
}

/**
 * 工厂：绑定 ledger，返回 (candidate, ctx) 两参接口。
 * @param {{ledger: object}} deps
 * @returns {{applyPromotionDecision: (evidenceId: string, decision: string) => object,
 *            requestPromotion: (candidate: object, ctx: object) => Promise<object|null>}}
 */
export function createExpression({ ledger }) {
  return {
    applyPromotionDecision: (evidenceId, decision) => applyPromotionDecision(ledger, evidenceId, decision),
    requestPromotion: (candidate, ctx) => requestPromotionImpl(candidate, ctx, ledger),
  }
}
