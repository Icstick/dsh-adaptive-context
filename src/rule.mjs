// src/rule.mjs — 反馈通道规则存储层（T4 M4.1，2026-09-07）。
// rule 表 DDL 由 store.mjs schema v6 负责；本模块提供操作层（工厂 createRuleStore({db})）。
//
// 语义（对应 docs/t4-feedback-channel-impl-2026-09-07.md Q1(a)）：
// - 规则 = 一等持久对象（独立表），与 evidence 互链（evidence_ids）；authority/claimDomain 契约冻结。
// - 状态机：draft（沉淀草案）--approve--> active；draft --reject--> rejected；
//   draft/active --supersede--> superseded（修订 = 新行 supersedes 旧行，链式回溯）。
// - 审计由上层调用组显式 appendAudit（rule_drafted/rule_approved/rule_rejected/rule_superseded），
//   与 promote/dismiss 惯例一致（audit.mjs 注释）。
// - 规则正文 ≤200 字（铁律候选 ≤2 行）；domain 自由文本 ≤24（视图按域分文件）。

import { hashHex } from './constants.mjs'

/** Rule 状态机 */
export const RULE_STATES = Object.freeze([
  'draft',       // 沉淀草案（未审批）
  'active',      // 审批通过（注入/查询资格）
  'rejected',    // 审批拒绝（终态）
  'superseded',  // 被新规则替代（终态，不物理删除）
])

/** 状态迁移：state → 允许事件列表（空 = 终态） */
export const RULE_TRANSITIONS = Object.freeze({
  draft: ['approve', 'reject', 'supersede'],
  active: ['supersede'],
  rejected: [],
  superseded: [],
})

/** 事件 → 目标状态 */
export const RULE_EVENT_TO_STATE = Object.freeze({
  approve: 'active',
  reject: 'rejected',
  supersede: 'superseded',
})

/** 长度上限（对齐 views/rules 目录可读性） */
export const RULE_TEXT_MAX_CHARS = 200
export const RULE_TITLE_MAX_CHARS = 60
export const RULE_DOMAIN_MAX_CHARS = 24

export class RuleError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'RuleError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message) {
  throw new RuleError(code, message)
}

function assertChoice(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(label + ' must be one of ' + allowed.join('|') + ', got ' + JSON.stringify(value))
  }
}

/** 确定性 id：同 scope+domain+text → 同 id（幂等） */
export function ruleIdOf(scopeId, domain, text) {
  return 'rule_' + hashHex(String(scopeId ?? 'user-global') + '|' + String(domain) + '|' + String(text)).slice(0, 24)
}

function toRule(r) {
  return {
    id: r.id,
    scopeId: r.scope_id,
    domain: r.domain,
    title: r.title,
    text: r.text,
    gates: JSON.parse(r.gates),
    evidenceIds: JSON.parse(r.evidence_ids),
    supersedes: r.supersedes,
    state: r.state,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    activeFrom: r.active_from,
    activeUntil: r.active_until,
  }
}

/**
 * Rule store 工厂。
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @returns {{
 *   createRule: (input: object) => {inserted: boolean, row: object},
 *   transitionRule: (id: string, event: string, opts?: object) => object,
 *   getRule: (id: string) => object | null,
 *   queryRules: (q?: object) => {items: object[], total: number},
 *   getRuleLineage: (id: string) => string[],
 * }}
 */
export function createRuleStore({ db }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createRuleStore requires a DatabaseSync handle ({ db })')
  }

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO rule (id, scope_id, domain, title, text, gates, evidence_ids, supersedes, state, source, created_at, updated_at, active_from, active_until)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const getStmt = db.prepare('SELECT * FROM rule WHERE id = ?')
  const updateStateStmt = db.prepare('UPDATE rule SET state = ?, updated_at = ?, active_from = ?, active_until = ? WHERE id = ?')

  /** 建规则（幂等：同 id 已存在 → inserted=false 返回现有行） */
  function createRule(input = {}) {
    const scopeId = input.scopeId ?? 'user-global'
    const domain = String(input.domain ?? '').trim()
    const title = String(input.title ?? '').trim()
    const text = String(input.text ?? '').trim()
    if (!domain || domain.length > RULE_DOMAIN_MAX_CHARS) {
      fail('INVALID_INPUT', 'domain 必须为非空且 ≤' + RULE_DOMAIN_MAX_CHARS + ' 字符')
    }
    if (!title || title.length > RULE_TITLE_MAX_CHARS) {
      fail('INVALID_INPUT', 'title 必须为非空且 ≤' + RULE_TITLE_MAX_CHARS + ' 字符')
    }
    if (!text || text.length > RULE_TEXT_MAX_CHARS) {
      fail('INVALID_INPUT', 'text 必须为非空且 ≤' + RULE_TEXT_MAX_CHARS + ' 字符（铁律候选）')
    }
    const state = input.state ?? 'draft'
    assertChoice(state, RULE_STATES, 'rule state')
    const gates = Array.isArray(input.gates) ? input.gates.map((g) => String(g).trim()).filter(Boolean) : []
    const evidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.map((e) => String(e)) : []
    const supersedes = String(input.supersedes ?? '').trim()
    if (supersedes) {
      const prev = getStmt.get(supersedes)
      if (!prev) fail('NOT_FOUND', 'supersedes 指向的 rule 不存在: ' + supersedes)
      // 修订语义（方案甲同 observation）：新行指向直接前驱，任何 state 均可被修订替代
      // （draft 改稿 → 新 draft supersedes 旧 draft；审批后修订 → 新 active supersedes active；
      //   草案也可升级替代旧草案）。绕审批的风险由 M4.3 审批接线把关，不在此层强约束。
    }
    const now = input.createdAt ?? Date.now()
    const id = ruleIdOf(scopeId, domain, text)
    const res = insertStmt.run(
      id, scopeId, domain, title, text,
      JSON.stringify(gates), JSON.stringify(evidenceIds), supersedes,
      state, input.source ?? 'consolidation', now, now,
      state === 'active' ? (input.activeFrom ?? now) : null,
      null,
    )
    return { inserted: res.changes > 0, row: toRule(getStmt.get(id)) }
  }

  /** 状态迁移（draft--approve/reject-->…；active--supersede-->） */
  function transitionRule(id, event, opts = {}) {
    const existing = getStmt.get(id)
    if (!existing) fail('NOT_FOUND', 'rule not found: ' + id)
    const allowed = RULE_TRANSITIONS[existing.state]
    if (!allowed || !allowed.includes(event)) {
      fail('INVALID_INPUT', 'transition ' + event + ' not allowed from state ' + existing.state)
    }
    const now = opts.now ?? Date.now()
    const next = RULE_EVENT_TO_STATE[event]
    const activeFrom = event === 'approve' ? now : existing.active_from
    const activeUntil = (event === 'reject' || event === 'supersede') ? now : existing.active_until
    updateStateStmt.run(next, now, activeFrom, activeUntil, id)
    return toRule(getStmt.get(id))
  }

  function getRule(id) {
    const r = getStmt.get(String(id ?? ''))
    return r ? toRule(r) : null
  }

  /** 查询：scope/state/domain 过滤 + limit（默认 100） */
  function queryRules(q = {}) {
    const conds = ['scope_id = ?']
    const params = [q.scopeId ?? 'user-global']
    if (q.state) { conds.push('state = ?'); params.push(q.state) }
    if (q.domain) { conds.push('domain = ?'); params.push(q.domain) }
    const where = conds.join(' AND ')
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500)
    const rows = db.prepare('SELECT * FROM rule WHERE ' + where + ' ORDER BY created_at DESC LIMIT ?').all(...params, limit)
    const total = db.prepare('SELECT COUNT(*) n FROM rule WHERE ' + where).get(...params).n
    return { items: rows.map(toRule), total }
  }

  /** 演进链：[最旧 ... 最新]（沿 supersedes 直接前驱回溯） */
  function getRuleLineage(id) {
    if (!getRule(id)) fail('NOT_FOUND', 'rule not found: ' + id)
    const collected = []
    const seen = new Set()
    const walk = (rid) => {
      if (seen.has(rid)) return
      seen.add(rid)
      const cur = getRule(rid)
      if (cur.supersedes) walk(cur.supersedes)
      collected.push(rid)
    }
    walk(id)
    return collected
  }

  return { createRule, transitionRule, getRule, queryRules, getRuleLineage }
}
