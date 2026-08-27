// src/expression.mjs — Expression manual promotion（P1-6 / T6，决策 5B=approval 审批门）。
//
// 2026-08-27 集成验证后的契约修正：
//   - ApprovalRequest.agent 必填（路由 UI 面板 + 审计），outcome = 'allowed-once' | 'rejected' |
//     'cancelled' | 'unavailable'（唯一通过值是 'allowed-once'，不是 'approved'）
//   - 后台任务（turn/end consolidation）无 agent 引用 → 无法直接发面板审批；
//     改为：consolidation 把 style 候选的源证据标 reviewStatus='pending_promotion'，
//     下个 turn 的 pre-step（payload.agent 可用）fire-and-forget 发起审批（不阻塞 turn）。
//
// M3 B3（feat/auto-promote）：与 candidate 状态机对接——
//   Evidence (Ledger) → Candidate (inert proposal) → Promotion (policy gate) → View (hot path)
//   1) manual 审批（allowed-once）→ candidate promote（actor='user'）+ view 重写
//      + audit + 保留 evidence.metadata.reviewStatus 同步
//   2) autoPromote（policy decision=promote，actor 用 'consolidation'——
//      B1 AUDIT_ACTORS 不含 'policy'，审计以 reason=policyResult.reason + payload.policy 区分自动路径）
//   3) rollback(candidateId) 只对 promoted 有效 → rolled_back + view 重写 + audit
//   4) requestPromotionImpl 现有逻辑保留（manual 路径），审批通过后走 candidate promote
// 兼容性：createExpression({ledger}) 无 B3 依赖时保持 M2 纯 metadata 行为（旧测试全绿）。

import { buildExpressionRows } from './views.mjs'

/** 审批面板可识别的 toolName（对齐 DSH approval.request 的 toolName 字段）。 */
export const PROMOTION_TOOL_NAME = 'acp.promotion'

/** reviewStatus 合法值（metadata 固定键集已含 reviewStatus） */
export const REVIEW_STATUSES = Object.freeze(['promoted', 'dismissed'])

/** pending 标记：consolidation 产出 style 候选时写入源证据 metadata */
export const PENDING_PROMOTION = 'pending_promotion'

/**
 * 应用人工审批决策：evidence.metadata.reviewStatus 迁移为 promoted/dismissed。
 * （纯 metadata 层——M3 B3 完整路径见 promoteEvidence/dismissEvidence）
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

// ===================== M3 B3：candidate 状态机对接 =====================

/**
 * 查找引用某证据的 style 候选（同 scope + domain；不区分状态——由调用方决定迁移合法性）。
 * candidateStore.listCandidates 的 SQL 不支持 domain 过滤 → 内存过滤。
 * @param {object|null} candidateStore
 * @param {string} scopeId
 * @param {string} evidenceId
 * @param {string} [domain]
 * @returns {object|null} 候选行或 null
 */
export function findCandidateForEvidence(candidateStore, scopeId, evidenceId, domain = 'style') {
  if (!candidateStore || typeof candidateStore.listCandidates !== 'function') return null
  const cands = candidateStore.listCandidates({ scopeId, limit: 200 })
  for (const c of cands) {
    if (c.domain !== domain) continue
    if ((c.evidenceIds ?? []).includes(evidenceId)) return c
  }
  return null
}

/**
 * 重建 expression view（candidate 重放 → 行 → 原子写）。写/验同源（views.mjs）。
 * @returns {object|null} writeExpression 结果；views 缺失时 null
 */
export function refreshExpressionView(views, candidateStore, ledger, scopeId) {
  if (!views || typeof views.writeExpression !== 'function') return null
  const rows = buildExpressionRows({ candidateStore, ledger, scopeId })
  return views.writeExpression(rows)
}

/**
 * 完整 manual promote：candidate 行 promote（actor='user'）+ view 重写 + audit
 * + evidence.metadata.reviewStatus 同步。候选不存在时兜底创建（纯 manual 流程也可审计）。
 * @param {object} ledger
 * @param {object|null} candidateStore
 * @param {object|null} auditStore
 * @param {object|null} views
 * @param {string} scopeId
 * @param {string} evidenceId
 * @param {object} [opts] - {actor?, reason?}
 * @returns {object} 更新后的证据行
 */
export function promoteEvidence(ledger, candidateStore, auditStore, views, scopeId, evidenceId, opts = {}) {
  const actor = opts.actor ?? 'user'
  const reason = opts.reason ?? 'manual-approval'
  let candidate = findCandidateForEvidence(candidateStore, scopeId, evidenceId)
  if (!candidate && candidateStore) {
    candidate = candidateStore.createCandidate({ scopeId, domain: 'style', evidenceIds: [evidenceId] })
  }
  if (candidate) {
    candidateStore.transitionCandidate(candidate.id, 'promote', { reason, actor })
  }
  const row = applyPromotionDecision(ledger, evidenceId, 'promoted')
  if (auditStore && typeof auditStore.appendAudit === 'function') {
    auditStore.appendAudit({
      op: 'promote',
      targetId: candidate?.id ?? evidenceId,
      scopeId,
      actor,
      reason,
      payload: { evidenceIds: [evidenceId], candidateId: candidate?.id ?? null },
    })
  }
  refreshExpressionView(views, candidateStore, ledger, scopeId)
  return row
}

/**
 * 完整 manual dismiss：candidate 行 reject（actor='user'）+ audit + reviewStatus 同步。
 * 候选非 proposed（如已 promoted）时迁移失败 → 忽略（仅同步 reviewStatus，fail-safe）。
 * @returns {object} 更新后的证据行
 */
export function dismissEvidence(ledger, candidateStore, auditStore, views, scopeId, evidenceId, opts = {}) {
  const actor = opts.actor ?? 'user'
  const reason = opts.reason ?? 'manual-rejection'
  const candidate = findCandidateForEvidence(candidateStore, scopeId, evidenceId)
  if (candidate) {
    try {
      candidateStore.transitionCandidate(candidate.id, 'reject', { reason, actor })
    } catch {
      // 非 proposed → 候选行不动，仅同步 reviewStatus（与 M2 行为一致）
    }
  }
  const row = applyPromotionDecision(ledger, evidenceId, 'dismissed')
  if (auditStore && typeof auditStore.appendAudit === 'function') {
    auditStore.appendAudit({
      op: 'dismiss',
      targetId: candidate?.id ?? evidenceId,
      scopeId,
      actor,
      reason,
      payload: { evidenceIds: [evidenceId], candidateId: candidate?.id ?? null },
    })
  }
  return row
}

/**
 * 自动提升：policy decision=promote 时执行——candidate promote（actor='consolidation'）
 * + reviewStatus 同步 + audit（payload 含 policy 快照）+ view 重写。
 * @param {object} candidateStore
 * @param {object|null} auditStore
 * @param {object|null} views
 * @param {object} ledger
 * @param {object} candidate - 候选行（必须 proposed）
 * @param {object} policyResult - evaluateCandidate 返回 {decision, reason, policy}
 * @param {object} [opts]
 * @returns {object} 更新后的候选行
 * @throws {Error} 候选非 proposed 时抛错（transitionCandidate 的 INVALID_INPUT 语义）
 */
export function autoPromoteCandidate(candidateStore, auditStore, views, ledger, candidate, policyResult, opts = {}) {
  if (!candidate || !candidate.id) {
    throw new TypeError('autoPromote requires a candidate row with id')
  }
  if (candidate.state && candidate.state !== 'proposed') {
    throw new Error("autoPromote: candidate '" + candidate.id + "' is '" + candidate.state + "', not proposed")
  }
  const scopeId = candidate.scopeId ?? opts.scopeId ?? 'user-global'
  // B1 AUDIT_ACTORS 不含 'policy' → 自动路径 actor 用 'consolidation'
  // （审计可经 reason=policyResult.reason + payload.policy 区分自动 vs 人工）
  const actor = 'consolidation'
  const reason = policyResult?.reason ?? 'policy promote'
  const promoted = candidateStore.transitionCandidate(candidate.id, 'promote', { reason, actor })
  for (const evId of candidate.evidenceIds ?? []) {
    try {
      const row = ledger.getById(evId)
      if (row) ledger.updateMetadata(evId, { reviewStatus: 'promoted' })
    } catch {
      // 证据缺失/更新失败：候选行已提升，视图重放自足，不阻断
    }
  }
  if (auditStore && typeof auditStore.appendAudit === 'function') {
    auditStore.appendAudit({
      op: 'promote',
      targetId: candidate.id,
      scopeId,
      actor,
      reason,
      payload: {
        decision: policyResult?.decision ?? 'promote',
        policy: policyResult?.policy ?? null,
        evidenceIds: candidate.evidenceIds,
      },
    })
  }
  refreshExpressionView(views, candidateStore, ledger, scopeId)
  return promoted
}

/**
 * 回滚：只对 promoted 候选有效 → rolled_back + view 重写 + audit。
 * 非破坏性返回 {ok, reason}（服务友好；不抛错）。
 * @param {object|null} candidateStore
 * @param {object|null} auditStore
 * @param {object|null} views
 * @param {object} ledger
 * @param {string} candidateId
 * @param {object} [opts] - {actor?, reason?}
 * @returns {{ok: boolean, candidate?: object, reason?: string}}
 */
export function rollbackCandidate(candidateStore, auditStore, views, ledger, candidateId, opts = {}) {
  if (!candidateStore) return { ok: false, reason: 'candidateStore unavailable' }
  const candidate = candidateStore.getCandidate(candidateId)
  if (!candidate) return { ok: false, reason: "candidate '" + candidateId + "' not found" }
  if (candidate.state !== 'promoted') {
    return {
      ok: false,
      reason: "rollback only applies to promoted candidates, state is '" + candidate.state + "'",
    }
  }
  const scopeId = candidate.scopeId ?? 'user-global'
  const actor = opts.actor ?? 'user'
  const reason = opts.reason ?? 'rollback'
  const rolled = candidateStore.transitionCandidate(candidateId, 'rollback', { reason, actor })
  if (auditStore && typeof auditStore.appendAudit === 'function') {
    auditStore.appendAudit({
      op: 'rollback',
      targetId: candidateId,
      scopeId,
      actor,
      reason,
      payload: { evidenceIds: candidate.evidenceIds },
    })
  }
  refreshExpressionView(views, candidateStore, ledger, scopeId)
  return { ok: true, candidate: rolled }
}

/**
 * 发起一次审批请求并按 outcome 落 reviewStatus（不抛错，fail-open）。
 * B3：B3 依赖齐全时，allowed-once → candidate promote 完整路径；rejected → dismiss 完整路径；
 *      依赖缺失（M2 兼容）→ 纯 metadata 迁移。
 * @param {object} candidate - {id, content?, claimDomain?, sourceRef?}
 * @param {object} ctx - cordis Context（ctx.get('approval')）
 * @param {object} ledger
 * @param {object} agent - ApprovalRequest.agent（必填）
 * @param {object} [deps] - {candidateStore?, auditStore?, views?, scopeId?}
 * @returns {Promise<object|null>} 更新行或 null
 */
export async function requestPromotionImpl(candidate, ctx, ledger, agent, deps = {}) {
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
  if (outcome === 'allowed-once') {
    if (deps.candidateStore) {
      return promoteEvidence(deps.ledger, deps.candidateStore, deps.auditStore, deps.views, deps.scopeId, evidenceId, {
        actor: 'user',
        reason: 'manual-approval',
      })
    }
    return applyPromotionDecision(ledger, evidenceId, 'promoted')
  }
  if (outcome === 'rejected') {
    if (deps.candidateStore) {
      return dismissEvidence(deps.ledger, deps.candidateStore, deps.auditStore, deps.views, deps.scopeId, evidenceId, {
        actor: 'user',
        reason: 'manual-rejection',
      })
    }
    return applyPromotionDecision(ledger, evidenceId, 'dismissed')
  }
  ctx?.logger?.debug?.('[acp] promotion outcome ignored: ' + String(outcome))
  return null
}

/**
 * 工厂：绑定 ledger（+ M3 B3 可选依赖），返回各接口。
 * B3 依赖（candidateStore/auditStore/views）缺省 null → 保持 M2 纯 metadata 行为。
 * @param {object} deps
 * @param {object} deps.ledger - openEvidenceLedger() 返回的句柄
 * @param {object} [deps.candidateStore] - createCandidateStore 句柄（B3）
 * @param {object} [deps.auditStore] - createAuditStore 句柄（B3）
 * @param {object} [deps.views] - createViews 句柄（B3）
 * @param {string} [deps.scopeId] - 默认 'user-global'
 */
export function createExpression({ ledger, candidateStore = null, auditStore = null, views = null, scopeId = 'user-global' }) {
  const deps = { ledger, candidateStore, auditStore, views, scopeId }
  return {
    applyPromotionDecision: (evidenceId, decision) => applyPromotionDecision(ledger, evidenceId, decision),
    collectPendingPromotions: () => collectPendingPromotions(ledger),
    requestPromotion: (candidate, ctx, agent) => requestPromotionImpl(candidate, ctx, ledger, agent, deps),
    // ---- M3 B3 ----
    /** 完整 manual promote（候选行 + view + audit + reviewStatus） */
    promoteEvidence: (evidenceId, opts = {}) => promoteEvidence(ledger, candidateStore, auditStore, views, scopeId, evidenceId, opts),
    /** 完整 manual dismiss（候选 reject + audit + reviewStatus） */
    dismissEvidence: (evidenceId, opts = {}) => dismissEvidence(ledger, candidateStore, auditStore, views, scopeId, evidenceId, opts),
    /** 自动提升（policy decision=promote 执行侧） */
    autoPromote: (candidate, policyResult, opts = {}) => autoPromoteCandidate(candidateStore, auditStore, views, ledger, candidate, policyResult, opts),
    /** 回滚（只对 promoted 有效）→ {ok, candidate|reason} */
    rollback: (candidateId, opts = {}) => rollbackCandidate(candidateStore, auditStore, views, ledger, candidateId, opts),
    /** 查找引用某证据的 style 候选 */
    findCandidateForEvidence: (evidenceId) => findCandidateForEvidence(candidateStore, scopeId, evidenceId),
    /** 重建 expression view（candidate 重放 → 原子写） */
    refreshView: () => refreshExpressionView(views, candidateStore, ledger, scopeId),
  }
}
