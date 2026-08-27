// src/audit.mjs — 统一审计（M3 C1）。audit 表 DDL 由 store.mjs schema v3 负责；
// 本模块只提供操作层（工厂 createAuditStore({db})）。
//
// 纪律（M3-PLAN §6.1）：
//   - store 层写操作（append / supersede / observation-upsert）由 store.mjs 内置调用本 store，
//     actor='system'；
//   - 上层写操作（promote / dismiss / rollback / export / rebuild）由调用组显式 appendAudit。
// 查询不审计（决策 6：audit 粒度不含查询）。

import { SCOPES } from './constants.mjs'

/** 审计操作枚举（M3-PLAN §6.1 C1：append|supersede|promote|dismiss|rollback|export|import|consolidate|rebuild|system）
 *  + B1 store 内置 observation-upsert */
export const AUDIT_OPS = Object.freeze([
  'append',
  'supersede',
  'observation-upsert',
  'promote',
  'dismiss',
  'rollback',
  'export',
  'import',
  'consolidate',
  'rebuild',
  'system',
])

/** 审计行为者枚举 */
export const AUDIT_ACTORS = Object.freeze([
  'agent',
  'user',
  'system',
  'consolidation',
])

function assertChoice(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(label + ' must be one of ' + allowed.join('|') + ', got ' + JSON.stringify(value))
  }
}

/**
 * 审计 store 工厂。
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db - store.mjs 打开的 DatabaseSync 句柄
 * @returns {{
 *   appendAudit: (input: {op: string, targetId?: string, scopeId?: string, actor?: string, reason?: string, payload?: object}) => number,
 *   queryAudit: (q: {op?: string, scopeId?: string, actor?: string, limit?: number}) => {items: object[], total: number},
 * }}
 */
export function createAuditStore({ db }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createAuditStore requires a DatabaseSync handle ({ db })')
  }

  const insertStmt = db.prepare(
    'INSERT INTO audit (ts, op, target_id, scope_id, actor, reason, payload)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?)'
  )

  /**
   * 写一条审计行。
   * @param {object} input
   * @param {string} input.op - AUDIT_OPS 之一
   * @param {string} [input.targetId] - 目标实体 id（evidence/candidate/observation）
   * @param {string} [input.scopeId] - SCOPES 之一，默认 'user-global'
   * @param {string} [input.actor] - AUDIT_ACTORS 之一，默认 'system'
   * @param {string} [input.reason] - 人类可读原因（可空）
   * @param {object} [input.payload] - 结构化附加信息（JSON 序列化）
   * @returns {number} 审计行 id
   */
  function appendAudit(input = {}) {
    assertChoice(input.op, AUDIT_OPS, 'audit op')
    const scopeId = input.scopeId ?? 'user-global'
    assertChoice(scopeId, SCOPES, 'scopeId')
    const actor = input.actor ?? 'system'
    assertChoice(actor, AUDIT_ACTORS, 'actor')
    if (input.reason !== undefined && typeof input.reason !== 'string') {
      throw new TypeError('audit reason must be a string')
    }
    const res = insertStmt.run(
      Date.now(),
      input.op,
      input.targetId ?? null,
      scopeId,
      actor,
      input.reason ?? '',
      input.payload === undefined ? null : JSON.stringify(input.payload),
    )
    return Number(res.lastInsertRowid)
  }

  /**
   * 查询审计（read-only）。支持 op / scopeId / actor 过滤。
   * @param {object} q
   * @returns {{items: object[], total: number}} items 按写入序倒序（最新在前）
   */
  function queryAudit(q = {}) {
    const conds = []
    const params = []
    if (q.op) { conds.push('op = ?'); params.push(q.op) }
    if (q.scopeId) { conds.push('scope_id = ?'); params.push(q.scopeId) }
    if (q.actor) { conds.push('actor = ?'); params.push(q.actor) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const limit = Math.min(q.limit ?? 50, 200)
    const rows = db.prepare('SELECT * FROM audit ' + where + ' ORDER BY id DESC LIMIT ?').all(...params, limit)
    const total = db.prepare('SELECT COUNT(*) AS c FROM audit ' + where).get(...params).c
    return { items: rows.map(toAudit), total }
  }

  return { appendAudit, queryAudit }
}

function toAudit(r) {
  return {
    id: r.id,
    ts: r.ts,
    op: r.op,
    targetId: r.target_id,
    scopeId: r.scope_id,
    actor: r.actor,
    reason: r.reason,
    payload: r.payload ? JSON.parse(r.payload) : null,
  }
}
