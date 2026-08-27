// src/expression.mjs — Expression manual promotion（P1-6 / T6，决策 5B=approval 审批门）。
//
// 2026-08-27 集成验证后的契约修正：
//   - ApprovalRequest.agent 必填（路由 UI 面板 + 审计），outcome = 'allowed-once' | 'rejected' |
//     'cancelled' | 'unavailable'（唯一通过值是 'allowed-once'，不是 'approved'）
//   - 后台任务（turn/end consolidation）无 agent 引用 → 无法直接发面板审批；
//     改为：consolidation 把 style 候选的源证据标 reviewStatus='pending_promotion'，
//     下个 turn 的 pre-step（payload.agent 可用）fire-and-forget 发起审批（不阻塞 turn）。
//
// 铁律对齐：Learning does not imply promotion（人工审批门）；Evidence is truth（只写 metadata）；
// fail-open（审批服务不可用/故障静默跳过，不阻断 turn）。

/** 审批面板可识别的 toolName（对齐 DSH approval.request 的 toolName 字段）。 */
export const PROMOTION_TOOL_NAME = 'acp.promotion'

/** reviewStatus 合法值（metadata 固定键集已含 reviewStatus） */
export const REVIEW_STATUSES = Object.freeze(['promoted', 'dismissed'])

/** pending 标记：consolidation 产出 style 候选时写入源证据 metadata */
export const PENDING_PROMOTION = 'pending_promotion'

/**
 * 应用人工审批决策：evidence.metadata.reviewStatus 迁移为 promoted/dismissed。
 * @param {object} ledger
 * @param {string} evidenceId
 * @param {'promoted'|'dismissed'} decision
 * @returns {object} 更新后的证据行
 */
export function applyPromotionDecision(ledger, evidenceId, decision) {
  if (!REVIEW_STATUSES.includes(decision)) {
    throw new TypeError('decision must be promoted|dismissed, got ' + JSON.stringify(decision))
  }
  return ledger.updateMetadata(evidenceId, { reviewStatus: decision })
}

/**
 * 构造 approval.request 载荷（对齐 DSH ApprovalRequest 契约：agent 必填）。
 * @param {{id?: string, content?: string, claimDomain?: string, sourceRef?: object}} candidate
 * @param {object} agent - 当前 turn 的 agent（pre-step payload.agent）
 * @returns {{agent: object, toolName: string, reason: string}}
 */
export function buildPromotionRequest(candidate = {}, agent) {
  return {
    agent,
    toolName: PROMOTION_TOOL_NAME,
    reason: [
      'ACP expression promotion (reviewStatus: promoted | dismissed)',
      'evidenceId: ' + String(candidate.id ?? '(none)'),
      'claimDomain: ' + String(candidate.claimDomain ?? '(none)'),
      'content: ' + String(candidate.content ?? ''),
      'sourceRef: ' + JSON.stringify(candidate.sourceRef ?? {}),
    ].join('\n'),
  }
}

/**
 * 收集待审批的 style 候选（active 且 reviewStatus === 'pending_promotion' 的证据）。
 * @param {object} ledger
 * @returns {object[]} 证据行数组
 */
export function collectPendingPromotions(ledger) {
  const rows = typeof ledger.listActive === 'function'
    ? ledger.listActive('user-global')
    : ledger.query({ state: 'active', limit: 200 }).items
  return rows.filter((ev) => ev.metadata?.reviewStatus === PENDING_PROMOTION)
}

/**
 * 发起一次审批请求并按 outcome 落 reviewStatus（不抛错，fail-open）。
 * @param {object} candidate - {id, content?, claimDomain?, sourceRef?}
 * @param {object} ctx - cordis Context（ctx.get('approval')）
 * @param {object} ledger
 * @param {object} agent - ApprovalRequest.agent（必填）
 * @returns {Promise<object|null>} 更新行或 null
 */
export async function requestPromotionImpl(candidate, ctx, ledger, agent) {
  const evidenceId = candidate?.id
  if (!evidenceId) return null
  const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
  if (!approval || typeof approval.request !== 'function' || !agent) {
    ctx?.logger?.debug?.('[acp] approval unavailable; promotion skipped (evidence ' + evidenceId + ')')
    return null
  }
  let outcome
  try {
    outcome = await approval.request(buildPromotionRequest(candidate, agent))
  } catch (err) {
    ctx?.logger?.warn?.('[acp] approval request failed: ' + (err && err.message))
    return null
  }
  // DSH approval outcome：'allowed-once' 唯一通过；'rejected' 驳回；其余忽略
  if (outcome === 'allowed-once') return applyPromotionDecision(ledger, evidenceId, 'promoted')
  if (outcome === 'rejected') return applyPromotionDecision(ledger, evidenceId, 'dismissed')
  ctx?.logger?.debug?.('[acp] promotion outcome ignored: ' + String(outcome))
  return null
}

/**
 * 工厂：绑定 ledger，返回 (candidate, ctx, agent) 三参接口。
 * @param {{ledger: object}} deps
 */
export function createExpression({ ledger }) {
  return {
    applyPromotionDecision: (evidenceId, decision) => applyPromotionDecision(ledger, evidenceId, decision),
    collectPendingPromotions: () => collectPendingPromotions(ledger),
    requestPromotion: (candidate, ctx, agent) => requestPromotionImpl(candidate, ctx, ledger, agent),
  }
}
