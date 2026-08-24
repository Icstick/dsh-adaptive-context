// src/store.mjs — Evidence Ledger 本地 SQLite Provider。
//
// append-only：evidence 表只 INSERT / UPDATE state（不物理删除）。
// 幂等：id 由 sourceRef + contentHash 派生（evidenceIdOf），重放同一事件自然得到
// 相同 id → INSERT OR IGNORE 即幂等；重复摄入返回 inserted:false。
// Provider 不做治理裁决（那是 governance.mjs 职责），也不做派生（那是 consolidation 职责）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  SCHEMA_VERSION, EVIDENCE_STATES, AUTHORITIES, SOURCE_CLASSES,
  CLAIM_DOMAINS, SENSITIVITIES, SCOPES, SESSION_TYPES,
  evidenceIdOf, hashHex,
} from './constants.mjs'

const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS acp_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,      -- evidenceIdOf(sourceRef, contentHash)
  scope_id      TEXT NOT NULL,
  agent_key     TEXT NOT NULL DEFAULT '',
  session_type  TEXT NOT NULL,
  source_class  TEXT NOT NULL,
  authority     TEXT NOT NULL,
  confidence    REAL NOT NULL,
  durability    REAL NOT NULL,
  sensitivity   TEXT NOT NULL,
  claim_domain  TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  source_ref    TEXT NOT NULL,          -- JSON
  observed_at   TEXT NOT NULL,
  valid_from    TEXT,
  valid_until   TEXT,
  state         TEXT NOT NULL DEFAULT 'active',
  supersedes    TEXT NOT NULL DEFAULT '[]',  -- JSON array
  metadata      TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_scope_state ON evidence (scope_id, state);
CREATE INDEX IF NOT EXISTS idx_evidence_content_hash ON evidence (content_hash);
CREATE INDEX IF NOT EXISTS idx_evidence_observed_at ON evidence (observed_at);
`

function assertChoice(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`)
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.dir]       默认 $DSH_HOME 下 acp 目录
 * @returns {object} LedgerProvider 句柄
 */
export function openEvidenceLedger(opts = {}) {
  const dir = opts.dir ?? path.join(process.env.DSH_HOME || '', 'acp')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, opts.dbName ?? 'acp-ledger.db')
  const db = new DatabaseSync(dbPath)
  db.exec(PRAGMAS)
  db.exec(SCHEMA)
  const existing = db.prepare('SELECT value FROM acp_meta WHERE key = ?').get('schema_version')
  if (existing && Number(existing.value) !== SCHEMA_VERSION) {
    db.close()
    throw new Error(`ACP ledger schema mismatch: db=${existing.value} expected=${SCHEMA_VERSION}`)
  }
  if (!existing) {
    db.prepare('INSERT OR IGNORE INTO acp_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO evidence (
      id, scope_id, agent_key, session_type, source_class, authority,
      confidence, durability, sensitivity, claim_domain, content, content_hash,
      source_ref, observed_at, valid_from, valid_until, state, supersedes, metadata,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const updateStateStmt = db.prepare('UPDATE evidence SET state = ?, updated_at = ? WHERE id = ?')
  const updateSupersedesStmt = db.prepare('UPDATE evidence SET supersedes = ?, state = ?, updated_at = ? WHERE id = ?')

  /**
   * 追加一条 Evidence（幂等）。
   * @param {object} input
   * @returns {{inserted: boolean, id: string, row?: object}}
   */
  function append(input) {
    // --- validate（先 validate 后 write，DSH 插件核心规则）---
    assertChoice(input.sourceClass, SOURCE_CLASSES, 'sourceClass')
    assertChoice(input.authority, AUTHORITIES, 'authority')
    assertChoice(input.sensitivity, SENSITIVITIES, 'sensitivity')
    assertChoice(input.claimDomain, CLAIM_DOMAINS, 'claimDomain')
    assertChoice(input.scopeId ?? 'user-global', SCOPES, 'scopeId')
    assertChoice(input.sessionType ?? 'root', SESSION_TYPES, 'sessionType')
    if (input.state && !EVIDENCE_STATES.includes(input.state)) {
      throw new TypeError(`state must be one of ${EVIDENCE_STATES.join('|')}`)
    }
    if (typeof input.content !== 'string' || input.content.length === 0) {
      throw new TypeError('content must be a non-empty string')
    }
    if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
      throw new TypeError('confidence must be in [0, 1]')
    }
    if (typeof input.durability !== 'number' || input.durability < 0 || input.durability > 1) {
      throw new TypeError('durability must be in [0, 1]')
    }

    const contentHash = input.contentHash ?? hashHex(input.content)
    const sourceRef = input.sourceRef ?? {}
    const id = input.id ?? evidenceIdOf({ sourceRef, contentHash })
    const now = Date.now()
    const state = input.state ?? 'active'

    insertStmt.run(
      id,
      input.scopeId ?? 'user-global',
      input.agentKey ?? '',
      input.sessionType ?? 'root',
      input.sourceClass,
      input.authority,
      input.confidence,
      input.durability,
      input.sensitivity,
      input.claimDomain,
      input.content,
      contentHash,
      JSON.stringify(sourceRef),
      input.observedAt ?? new Date().toISOString(),
      input.validFrom ?? null,
      input.validUntil ?? null,
      state,
      JSON.stringify(input.supersedes ?? []),
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    )

    const changes = db.prepare('SELECT changes() AS c').get().c
    const inserted = changes > 0
    const row = inserted ? getById(id) : null
    return { inserted, id, row }
  }

  function getById(id) {
    const r = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    return r ? toEvidence(r) : null
  }

  /** 状态迁移（supersede / quarantine / redact / 恢复 active） */
  function setState(id, state, opts = {}) {
    assertChoice(state, EVIDENCE_STATES, 'state')
    updateStateStmt.run(state, Date.now(), id)
    if (opts.supersedes) {
      updateSupersedesStmt.run(JSON.stringify(opts.supersedes), state, Date.now(), id)
    }
    return getById(id)
  }

  /**
   * 查询（read-only）。支持 scope/state/claimDomain/authority/sourceClass 过滤 + 子串。
   * @param {object} q
   * @returns {{items: object[], total: number}}
   */
  function query(q = {}) {
    const conds = []
    const params = []
    if (q.scopeId) { conds.push('scope_id = ?'); params.push(q.scopeId) }
    if (q.agentKey !== undefined) { conds.push('agent_key = ?'); params.push(q.agentKey) }
    if (q.state) { conds.push('state = ?'); params.push(q.state) }
    if (q.claimDomain) { conds.push('claim_domain = ?'); params.push(q.claimDomain) }
    if (q.authority) { conds.push('authority = ?'); params.push(q.authority) }
    if (q.sourceClass) { conds.push('source_class = ?'); params.push(q.sourceClass) }
    if (q.contentSubstr) { conds.push('content LIKE ? ESCAPE \'\\\''); params.push(`%${escapeLike(q.contentSubstr)}%`) }
    if (q.validAt) { conds.push('(valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?)'); params.push(q.validAt, q.validAt) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const limit = Math.min(q.limit ?? 50, 200)
    const rows = db.prepare(`SELECT * FROM evidence ${where} ORDER BY observed_at DESC LIMIT ?`).all(...params, limit)
    const total = db.prepare(`SELECT COUNT(*) AS c FROM evidence ${where}`).get(...params).c
    return { items: rows.map(toEvidence), total }
  }

  /** 去重候选：同 contentHash 的已有证据（供 idempotency 审计） */
  function byContentHash(contentHash) {
    return db.prepare('SELECT * FROM evidence WHERE content_hash = ?').all(contentHash).map(toEvidence)
  }

  /** 全部 active 证据（供快照/导出） */
  function listActive(scopeId) {
    const rows = scopeId
      ? db.prepare('SELECT * FROM evidence WHERE state = ? AND scope_id = ? ORDER BY observed_at DESC').all('active', scopeId)
      : db.prepare('SELECT * FROM evidence WHERE state = ? ORDER BY observed_at DESC').all('active')
    return rows.map(toEvidence)
  }

  function stats() {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN state = 'quarantined' THEN 1 ELSE 0 END) AS quarantined,
             SUM(CASE WHEN state = 'superseded' THEN 1 ELSE 0 END) AS superseded
      FROM evidence
    `).get()
    return { total: r.total ?? 0, active: r.active ?? 0, quarantined: r.quarantined ?? 0, superseded: r.superseded ?? 0 }
  }

  function close() { db.close() }

  return { db, dbPath, append, getById, setState, query, byContentHash, listActive, stats, close }
}

function toEvidence(r) {
  return {
    id: r.id,
    scopeId: r.scope_id,
    agentKey: r.agent_key,
    sessionType: r.session_type,
    sourceClass: r.source_class,
    authority: r.authority,
    confidence: r.confidence,
    durability: r.durability,
    sensitivity: r.sensitivity,
    claimDomain: r.claim_domain,
    content: r.content,
    contentHash: r.content_hash,
    sourceRef: JSON.parse(r.source_ref),
    observedAt: r.observed_at,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    state: r.state,
    supersedes: JSON.parse(r.supersedes),
    metadata: JSON.parse(r.metadata),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}
