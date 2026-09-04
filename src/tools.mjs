// src/tools.mjs — acp_query：模型面只读查询工具（S1 P1，2026-09-04，rc.1 工具范式）
// ------------------------------------------------------------------
// 设计依据：B9 v0.3 P1（对话即界面：AI 查 = acp_query；只读无审批、可审计）。
// 语义：查询面宽于注入面——evidence 直查 ledger（不过 readGuard），authority 行内标注；
// superseded/quarantined 默认不可见（state=all 可含）。读审计 op=model_query。
// 工具范式：host dsh-tools 0.1.2-rc.1（parameters JSON DSL + output.schema/render + execute）。
// 2026-09-04 修复：ACP repo 曾解析到自身 node_modules 的 rc.8 dsh-tools（旧 handler 范式）
// → register 静默无效。现 repo @deepseek-ai 符号链接 host（对齐 rc.1），本文件按 rc.1 范式。
// ------------------------------------------------------------------
import { defineTool } from '@deepseek-ai/dsh-tools'

const TRIM_CHARS = 320
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20

const clip = (s, n = TRIM_CHARS) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…[' + t.length + ']' : t
}

const EVIDENCE_ITEM = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    domain: { type: 'string' },
    authority: { type: 'string' },
    state: { type: 'string' },
    sessionId: { type: 'string' },
    observedAt: { type: 'string' },
    content: { type: 'string', required: true },
  },
}
const OBS_ITEM = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    subject: { type: 'string' },
    predicate: { type: 'string' },
    domain: { type: 'string' },
    state: { type: 'string' },
    observedAt: { type: 'string' },
    text: { type: 'string', required: true },
    evidenceCount: { type: 'integer' },
  },
}
const OK_BRANCH = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    scopeId: { type: 'string', required: true },
    evidenceCount: { type: 'integer', required: true },
    observationCount: { type: 'integer', required: true },
    note: { type: 'string', required: true },
    evidence: { type: 'array', items: EVIDENCE_ITEM, required: true },
    observations: { type: 'array', items: OBS_ITEM, required: true },
  },
}
const ERR_BRANCH = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    scopeId: { type: 'string', required: true },
    error: { type: 'string', required: true },
    evidence: { type: 'array', items: EVIDENCE_ITEM, required: true },
    observations: { type: 'array', items: OBS_ITEM, required: true },
  },
}
const OUTPUT_SCHEMA = { oneOf: [OK_BRANCH, ERR_BRANCH] }

/**
 * 查询 ACP ledger（evidence + observation）。纯函数，可测。
 * @param {object} deps - { ledger（必），auditStore? }
 * @param {object} input - { query?, domain?, authority?, state?, limit?, includeObservation? }
 */
export function queryLedgerForTool(deps, input = {}) {
  const scopeId = input.scopeId ?? 'user-global'
  const limit = Math.min(Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : DEFAULT_LIMIT, MAX_LIMIT)
  const ledger = deps && deps.ledger
  if (!ledger || typeof ledger.query !== 'function') {
    return { ok: false, scopeId, error: 'ledger unavailable', evidence: [], observations: [] }
  }
  const q = { scopeId, limit, state: input.state === 'all' ? undefined : (input.state ?? 'active') }
  if (typeof input.domain === 'string' && input.domain) q.claimDomain = input.domain
  if (typeof input.authority === 'string' && input.authority) q.authority = input.authority
  if (typeof input.query === 'string' && input.query.trim()) q.contentAnySubstr = substrs(input.query.trim())
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

/** 内容 OR 召回子串（与 service.recallSubstrings 同效的轻量版，避免 import 环）。 */
function substrs(text) {
  const t = String(text || '').trim()
  if (!t) return undefined
  const parts = [t]
  const cjk = t.match(/[\u4e00-\u9fa5]{2,}/g)
  if (cjk) {
    for (const seg of cjk) {
      for (let i = 0; i + 2 <= seg.length; i++) parts.push(seg.slice(i, i + 2))
    }
  }
  return [...new Set(parts)].slice(0, 24)
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
 * 纯工具 spec（rc.1 范式 options，不经 defineTool 也可测）。
 * @param {object} deps - { ledger, auditStore?, scopeId? }
 */
export function buildAcpQueryToolSpec(deps = {}) {
  const scopeId = deps.scopeId ?? 'user-global'
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  return {
    name: 'acp_query',
    description:
      '查询跨会话证据账本（ACP ledger）：evidence（带权威分级的事实/偏好/纠正/经验）与 observation（蒸馏结论）。'
      + '只读、无审批、有审计。Use when 需要回忆用户偏好/纠正/历史决策/项目经验，或核对某结论是否已记录、被 supersede 撤销。',
    parameters: {
      query: { type: 'string', description: '检索词：内容子串/关键词（中文整串或短词均 OR 召回）。可选——不填返回最近记录。' },
      domain: { type: 'string', description: '按 claimDomain 过滤（user_fact/style/user_correction/experience/…）。可选。' },
      authority: { type: 'string', description: '按 authority 过滤（user_explicit/user_correction/system_policy/agent_inference/…）。可选。' },
      state: { type: 'string', description: '证据状态：active（默认）/all（含 superseded 等）。' },
      limit: { type: 'number', description: '返回条数上限（1-20，默认 8）。' },
      includeObservation: { type: 'boolean', description: '同时返回 observation（默认 true）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute(args) {
      const res = queryLedgerForTool(deps, { ...(args || {}), scopeId })
      auditQuery(deps, { ...(args || {}), scopeId }, res)
      return Promise.resolve(res)
    },
  }
}

/** 宿主注册工厂（rc.1 defineTool）。 */
export function makeAcpQueryTool(deps = {}) {
  return defineTool(buildAcpQueryToolSpec(deps))
}
