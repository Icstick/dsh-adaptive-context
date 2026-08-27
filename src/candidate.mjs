// src/candidate.mjs — Candidate 生命周期（M3 B1）：五态状态机 + 事件重放投影。
// candidate 表 + candidate_events 表 DDL 由 store.mjs schema v3 负责；本模块只提供操作层
// （工厂 createCandidateStore({db})，由 openEvidenceLedger 或 index 装配时传入 db 句柄）。
//
// 状态机（五态）：
//   proposed --promote--> promoted --rollback--> rolled_back
//   proposed --reject--> rejected
//   proposed --supersede--> superseded
// 其余迁移一律拒绝（CandidateError INVALID_INPUT）。状态 = candidate_events 重放投影
// （create 事件携带静态属性 scopeId/domain/evidenceIds/policy，重放完全自足，restart 一致）。

import { SCOPES, CLAIM_DOMAINS, ERROR_CODES, hashHex } from './constants.mjs'
import { AUDIT_ACTORS } from './audit.mjs'

/** Candidate 五态（M3-PLAN §6.1 / B1） */
export const CANDIDATE_STATES = Object.freeze([
  'proposed',
  'promoted',
  'rejected',
  'superseded',
  'rolled_back',
])

/** candidate_events 全部事件（create 由 createCandidate 写入；其余为迁移事件） */
export const CANDIDATE_EVENTS = Object.freeze(['create', 'promote', 'reject', 'rollback', 'supersede'])

/** 可显式触发的迁移事件（transitionCandidate 的 event 白名单） */
export const TRANSITION_EVENTS = Object.freeze(['promote', 'reject', 'rollback', 'supersede'])

/** 状态机：state → 允许的事件列表（空数组 = 终态，只能被替代/回滚的语义由上游新候选表达） */
export const TRANSITIONS = Object.freeze({
  proposed: ['promote', 'reject', 'supersede'],
  promoted: ['rollback'],
  rejected: [],
  superseded: [],
  rolled_back: [],
})

/** 事件 → 目标状态 */
export const EVENT_TO_STATE = Object.freeze({
  create: 'proposed',
  promote: 'promoted',
  reject: 'rejected',
  rollback: 'rolled_back',
  supersede: 'superseded',
})

/** 结构化错误：code 取 constants.ERROR_CODES（INVALID_INPUT / NOT_FOUND） */
export class CandidateError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'CandidateError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message) {
  throw new CandidateError(code, message)
}

function assertChoice(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(label + ' must be one of ' + allowed.join('|') + ', got ' + JSON.stringify(value))
  }
}

/**
 * Candidate store 工厂。
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db - store.mjs 打开的 DatabaseSync 句柄
 * @returns {{
 *   createCandidate: (input: {scopeId?: string, domain: string, evidenceIds: string[], policy?: object}) => object,
 *   transitionCandidate: (id: string, event: string, opts: {reason?: string, actor?: string}) => object,
 *   listCandidates: (q: {scopeId?: string, state?: string, limit?: number}) => object[],
 *   getCandidate: (id: string) => object | null,
 *   replayCandidates: () => Map<string, object>,
 * }}
 */
export function createCandidateStore({ db }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createCandidateStore requires a DatabaseSync handle ({ db })')
  }

  const insertCandidateStmt = db.prepare(
    'INSERT INTO candidate (id, scope_id, domain, evidence_ids, state, policy, decision_reason, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const insertEventStmt = db.prepare(
    'INSERT INTO candidate_events (candidate_id, ts, event, reason, actor, payload)' +
    ' VALUES (?, ?, ?, ?, ?, ?)'
  )
  const updateCandidateStmt = db.prepare(
    'UPDATE candidate SET state = ?, decision_reason = ?, updated_at = ? WHERE id = ?'
  )

  /**
   * 创建候选：写 candidate 行（state='proposed'）+ create 事件（重放投影的起点）。
   * @param {object} input
   * @param {string} [input.scopeId] - SCOPES 之一，默认 'user-global'
   * @param {string} input.domain - CLAIM_DOMAINS 之一
   * @param {string[]} input.evidenceIds - 候选依据的证据 id 列表
   * @param {object} [input.policy] - B2 评估快照（创建时通常为 null，评估后由上游补充）
   * @returns {object} 完整候选行（含 state:'proposed'）
   */
  function createCandidate(input = {}) {
    const scopeId = input.scopeId ?? 'user-global'
    assertChoice(scopeId, SCOPES, 'scopeId')
    assertChoice(input.domain, CLAIM_DOMAINS, 'domain')
    if (!Array.isArray(input.evidenceIds)) {
      throw new TypeError('evidenceIds must be an array of evidence ids')
    }
    const evidenceIds = input.evidenceIds.map(String)
    const id = 'cand_' + hashHex(
      [scopeId, input.domain, evidenceIds.join(','), String(Date.now()), String(Math.random())].join('|')
    ).slice(0, 16)
    const now = Date.now()
    const policy = input.policy === undefined ? null : input.policy

    db.exec('BEGIN IMMEDIATE')
    try {
      insertCandidateStmt.run(
        id, scopeId, input.domain, JSON.stringify(evidenceIds), 'proposed',
        policy === null ? null : JSON.stringify(policy), null, now, now,
      )
      insertEventStmt.run(id, now, 'create', 'candidate created', 'system', JSON.stringify({
        scopeId, domain: input.domain, evidenceIds, policy,
      }))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return getCandidate(id)
  }

  /**
   * 状态迁移：写一条 candidate_events（append-only）+ 更新 candidate 行（投影）。
   * 非法迁移（含终态上的任何迁移）抛 CandidateError INVALID_INPUT。
   * @param {string} id - 候选 id
   * @param {string} event - TRANSITION_EVENTS 之一（promote|reject|rollback|supersede）
   * @param {object} [opts]
   * @param {string} [opts.reason] - 决策原因（写入 decision_reason，可审计）
   * @param {string} [opts.actor] - AUDIT_ACTORS 之一，默认 'system'
   * @returns {object} 更新后的候选行
   * @throws {CandidateError} INVALID_INPUT / NOT_FOUND
   */
  function transitionCandidate(id, event, opts = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      fail(ERROR_CODES.INVALID_INPUT, 'transitionCandidate: id must be a non-empty string')
    }
    if (!TRANSITION_EVENTS.includes(event)) {
      fail(ERROR_CODES.INVALID_INPUT,
        'transitionCandidate: event must be one of ' + TRANSITION_EVENTS.join('|') + ', got ' + JSON.stringify(event))
    }
    const row = getCandidate(id)
    if (!row) fail(ERROR_CODES.NOT_FOUND, "candidate '" + id + "' not found")
    const allowed = TRANSITIONS[row.state] ?? []
    if (!allowed.includes(event)) {
      fail(ERROR_CODES.INVALID_INPUT,
        "illegal transition: candidate '" + id + "' is '" + row.state + "', cannot apply event '" + event
        + "' (allowed: " + (allowed.length ? allowed.join('|') : 'none') + ')')
    }
    const actor = opts.actor ?? 'system'
    if (!AUDIT_ACTORS.includes(actor)) {
      fail(ERROR_CODES.INVALID_INPUT, 'actor must be one of ' + AUDIT_ACTORS.join('|'))
    }
    if (opts.reason !== undefined && typeof opts.reason !== 'string') {
      fail(ERROR_CODES.INVALID_INPUT, 'reason must be a string')
    }
    const now = Date.now()
    const nextState = EVENT_TO_STATE[event]

    db.exec('BEGIN IMMEDIATE')
    try {
      insertEventStmt.run(id, now, event, opts.reason ?? '', actor, null)
      updateCandidateStmt.run(nextState, opts.reason ?? null, now, id)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return getCandidate(id)
  }

  /** 按 id 读候选（实时投影行）；不存在返回 null */
  function getCandidate(id) {
    const r = db.prepare('SELECT * FROM candidate WHERE id = ?').get(id)
    return r ? toCandidate(r) : null
  }

  /**
   * 列出候选（read-only）。支持 scopeId / state 过滤，按创建时间倒序。
   * @returns {object[]} 候选行数组
   */
  function listCandidates(q = {}) {
    const conds = []
    const params = []
    if (q.scopeId) { conds.push('scope_id = ?'); params.push(q.scopeId) }
    if (q.state) { conds.push('state = ?'); params.push(q.state) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const limit = Math.min(q.limit ?? 50, 200)
    return db.prepare('SELECT * FROM candidate ' + where + ' ORDER BY created_at DESC, id ASC LIMIT ?')
      .all(...params, limit).map(toCandidate)
  }

  /**
   * 重放投影：完全从 candidate_events 重建 Map<id, 候选行>（状态 = 事件重放）。
   * - create 事件携带静态属性（scopeId/domain/evidenceIds/policy），重放自足；
   * - 后续事件按写入序（id 升序）应用 EVENT_TO_STATE；最后一个事件决定终态；
   * - 悬挂事件（无 create 前驱）容忍跳过；非 JSON payload 容忍为 null。
   * @returns {Map<string, object>} candidate_id → 候选行
   */
  function replayCandidates() {
    const events = db.prepare('SELECT * FROM candidate_events ORDER BY id ASC').all()
    const map = new Map()
    for (const ev of events) {
      if (ev.event === 'create') {
        let payload = null
        try { payload = ev.payload ? JSON.parse(ev.payload) : null } catch { payload = null }
        const p = payload ?? {}
        map.set(ev.candidate_id, {
          id: ev.candidate_id,
          scopeId: p.scopeId ?? null,
          domain: p.domain ?? null,
          evidenceIds: Array.isArray(p.evidenceIds) ? p.evidenceIds : [],
          policy: p.policy ?? null,
          state: 'proposed',
          decisionReason: null,
          createdAt: ev.ts,
          updatedAt: ev.ts,
        })
      } else {
        const row = map.get(ev.candidate_id)
        if (!row) continue // 悬挂事件容忍
        const next = EVENT_TO_STATE[ev.event]
        if (next) row.state = next
        row.decisionReason = ev.reason || null
        row.updatedAt = ev.ts
      }
    }
    return map
  }

  return { createCandidate, transitionCandidate, listCandidates, getCandidate, replayCandidates }
}

function toCandidate(r) {
  return {
    id: r.id,
    scopeId: r.scope_id,
    domain: r.domain,
    evidenceIds: JSON.parse(r.evidence_ids),
    state: r.state,
    policy: r.policy ? JSON.parse(r.policy) : null,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
