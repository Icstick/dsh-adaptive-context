// src/tools.mjs — acp_query：模型面只读查询工具（S1 P1，2026-09-04）
// ------------------------------------------------------------------
// 设计依据：B9 v0.3 P1（对话即界面：AI 查 = acp_query；只读无审批、可审计）。
// 语义：查询面比注入面宽——evidence 直查 ledger（不过 readGuard 注入过滤，
// 权威分级以行内标注交给模型判断）；superseded/quarantined 默认不可见。
// 读审计：每次查询 append audit（op=model_query, actor=model）。
// buildAcpQueryToolSpec 为纯 spec（可独立测试）；makeAcpQueryTool 供宿主注册（defineTool 需宿主环境）。
// ------------------------------------------------------------------
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { recallSubstrings } from './service.mjs'

const TRIM_CHARS = 320
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

const clip = (s, n = TRIM_CHARS) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…[' + t.length + ']' : t
}

/**
 * 查询 ACP ledger（evidence + observation）。纯函数，可测。
 * @param {object} deps - { ledger（必），auditStore? }
 * @param {object} input - { query?, domain?, authority?, state?, limit?, includeObservation? }
 * @returns {object} { ok, scopeId, evidenceCount, observationCount, evidence: [], observations: [] }
 */
export function queryLedgerForTool(deps, input = {}) {
  const scopeId = input.scopeId ?? 'user-global'
  const limit = Math.min(Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : DEFAULT_LIMIT, MAX_LIMIT)
  const ledger = deps && deps.ledger
  if (!ledger || typeof ledger.query !== 'function') {
    return { ok: false, scopeId, error: 'ledger unavailable', evidence: [], observations: [] }
  }
  const q = {
    scopeId,
    limit,
    // 'all' → 不过滤 state；默认仅 active（superseded/quarantined 不可见）
    state: input.state === 'all' ? undefined : (input.state ?? 'active'),
  }
  if (typeof input.domain === 'string' && input.domain) q.claimDomain = input.domain
  if (typeof input.authority === 'string' && input.authority) q.authority = input.authority
  if (typeof input.query === 'string' && input.query.trim()) {
    q.contentAnySubstr = recallSubstrings(input.query.trim())
  }

  let rows = []
  try {
    const res = ledger.query(q)
    rows = Array.isArray(res.items) ? res.items : []
  } catch (err) {
    return { ok: false, scopeId, error: String((err && err.message) || err), evidence: [], observations: [] }
  }
  const evidence = rows.slice(0, limit).map((ev) => ({
    id: ev.id,
    domain: ev.claimDomain ?? null,
    authority: ev.authority ?? null,
    state: ev.state ?? null,
    sessionId: ev.sessionId ?? null,
    observedAt: ev.observedAt ?? null,
    content: clip(ev.content),
  }))

  let observations = []
  if (input.includeObservation !== false && ledger && typeof ledger.listObservations === 'function') {
    try {
      const obs = ledger.listObservations(scopeId) || []
      observations = obs
        .filter((o) => o && typeof o.text === 'string' && o.text.length > 0)
        .slice(0, limit)
        .map((o) => ({
          id: o.id,
          subject: o.subject ?? null,
          predicate: o.predicate ?? null,
          domain: o.claimDomain ?? null,
          state: o.state ?? null,
          observedAt: o.observedAt ?? null,
          text: clip(o.text),
          evidenceCount: Array.isArray(o.evidenceIds) ? o.evidenceIds.length : 0,
        }))
    } catch { /* observation 查询失败不影响 evidence */ }
  }

  return {
    ok: true,
    scopeId,
    evidenceCount: evidence.length,
    observationCount: observations.length,
    evidence,
    observations,
    note: '只读查询（无审批）；authority 分级在行内；superseded/quarantined 默认不可见（state=all 可含）。',
  }
}

/** 记录读审计（best-effort，失败静默）。 */
function auditQuery(deps, input, counts) {
  try {
    const store = deps && deps.auditStore
    if (store && typeof store.appendAudit === 'function') {
      store.appendAudit({
        op: 'model_query',
        targetId: '',
        scopeId: input.scopeId ?? 'user-global',
        actor: 'model',
        reason: 'acp_query tool',
        payload: JSON.stringify({
          q: String(input.query ?? '').slice(0, 120),
          evidence: counts.evidenceCount,
          observations: counts.observationCount,
        }),
      })
    }
  } catch { /* 读审计失败不影响查询 */ }
}

/**
 * 纯工具 spec（不经 defineTool，可独立测试）。
 * @param {object} deps - { ledger, auditStore?, scopeId? }
 */
export function buildAcpQueryToolSpec(deps = {}) {
  const scopeId = deps.scopeId ?? 'user-global'
  return {
    name: 'acp_query',
    description:
      '查询跨会话证据账本（ACP ledger）：evidence（带权威分级的事实/偏好/纠正/经验）与 observation（蒸馏结论）。'
      + '只读、无审批、有审计。Use when 需要回忆用户偏好/纠正/历史决策/项目经验，或核对某结论是否已记录、被 supersede 撤销。',
    schema: Schema.object({
      query: Schema.string().description('检索词：内容子串/关键词（中文整串或短词均 OR 召回）。可选——不填返回最近记录。'),
      domain: Schema.string().description('按 claimDomain 过滤（user_fact/style/user_correction/experience/…）。可选。'),
      authority: Schema.string().description('按 authority 过滤（user_explicit/user_correction/system_policy/agent_inference/…）。可选。'),
      state: Schema.string().description('证据状态：active（默认）/all（含 superseded 等）。'),
      limit: Schema.number().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      includeObservation: Schema.boolean().description('同时返回 observation（默认 true）。'),
    }),
    async handler(input) {
      const res = queryLedgerForTool(deps, { ...(input || {}), scopeId })
      auditQuery(deps, { ...(input || {}), scopeId }, res)
      return { result: res }
    },
  }
}

/**
 * 宿主注册工厂（defineTool 需要宿主 render 环境）。
 * @param {object} deps - { ledger, auditStore?, scopeId? }
 */
export function makeAcpQueryTool(deps = {}) {
  return defineTool(buildAcpQueryToolSpec(deps))
}
