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
  SCHEMA_VERSION, EVIDENCE_STATES, OBSERVATION_STATES, AUTHORITIES, SOURCE_CLASSES,
  CLAIM_DOMAINS, SENSITIVITIES, SCOPES, SESSION_TYPES,
  MAX_OBSERVATION_TEXT_CHARS,
  evidenceIdOf, hashHex,
} from './constants.mjs'
import { assertAuthorityConsistent } from './governance.mjs'

const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;'

/** metadata 固定键集（2026-08-25 决策）：写路径只接受这些键 */
const METADATA_ALLOWED_KEYS = new Set([
  'ttlDays',
  'reviewStatus',
  'scenarioTags',
  'sourceVersion',
])

function assertMetadataKeys(metadata) {
  if (!metadata) return {}
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('metadata must be an object')
  }
  for (const key of Object.keys(metadata)) {
    if (!METADATA_ALLOWED_KEYS.has(key)) {
      throw new TypeError(`metadata key '${key}' not allowed (allowed: ${[...METADATA_ALLOWED_KEYS].join(', ')})`)
    }
  }
  return metadata
}


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

CREATE TABLE IF NOT EXISTS observation (
  id            TEXT PRIMARY KEY,
  scope_id      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  claim_domain  TEXT NOT NULL,
  text          TEXT NOT NULL,
  evidence_ids  TEXT NOT NULL DEFAULT '[]',  -- JSON array
  supersedes    TEXT NOT NULL DEFAULT '[]',  -- JSON array（方案甲：直接前驱）
  state         TEXT NOT NULL DEFAULT 'active',
  observed_at   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observation_scope ON observation (scope_id);
CREATE INDEX IF NOT EXISTS idx_observation_claim_domain ON observation (claim_domain);
CREATE INDEX IF NOT EXISTS idx_observation_key ON observation (scope_id, subject, predicate, claim_domain);
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
  const existingVersion = existing ? Number(existing.value) : 0
  if (existingVersion > SCHEMA_VERSION) {
    db.close()
    throw new Error(`ACP ledger schema mismatch: db=${existing.value} expected=${SCHEMA_VERSION}`)
  }
  if (existingVersion !== SCHEMA_VERSION) {
    // 迁移：v1 → v2 只新增 observation 表（SCHEMA 已 CREATE TABLE IF NOT EXISTS），
    // 不破坏 evidence 表；新库亦走此路径写入当前版本号。
    db.prepare('INSERT OR REPLACE INTO acp_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
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
    // authority 与 sourceClass 一致性校验（2026-08-25 决策）
    assertAuthorityConsistent(input.sourceClass, input.authority)
    // metadata 固定键集校验
    assertMetadataKeys(input.metadata)

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
   * 局部更新 metadata（固定键集校验后合并，2026-08-25 决策）。
   * @param {string} id
   * @param {object} patch - metadata 增量（只允许 METADATA_ALLOWED_KEYS 内键）
   * @returns {object} 更新后的证据行
   */
  function updateMetadata(id, patch) {
    assertMetadataKeys(patch)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    if (!row) throw new Error(`evidence '${id}' not found`)
    const merged = { ...JSON.parse(row.metadata), ...patch }
    db.prepare('UPDATE evidence SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), Date.now(), id)
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
    if (Array.isArray(q.contentAnySubstr) && q.contentAnySubstr.length > 0) {
      // OR 语义召回：任一子串命中即候选（CJK bigram / token 召回用）
      const ors = q.contentAnySubstr.map(() => "content LIKE ? ESCAPE '\\'")
      conds.push('(' + ors.join(' OR ') + ')')
      for (const sub of q.contentAnySubstr) params.push(`%${escapeLike(sub)}%`)
    }
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

  // ===================== meta 水位（consolidation 节流用） =====================

  function getMeta(key) {
    const r = db.prepare('SELECT value FROM acp_meta WHERE key = ?').get(key)
    return r ? r.value : null
  }

  function setMeta(key, value) {
    db.prepare('INSERT OR REPLACE INTO acp_meta (key, value) VALUES (?, ?)').run(key, String(value))
  }

  // ===================== Observation（可版本化派生认知） =====================
  // 冲突检测键 = scope_id + subject + predicate + claim_domain。
  // 冲突 supersede 语义（方案甲，CONTRACTS.md §8）：
  //   同键新 Observation 写入 → 旧行 state='superseded'，新行 supersedes=[旧 id]。
  //   supersedes 属于替代者一侧——"新 observation 替代了谁"，不是被替代者记新 id。
  //   getObservationLineage(id) 沿 supersedes 回溯得到 [最旧 ... 最新]。

  const insertObservationStmt = db.prepare(`
    INSERT OR IGNORE INTO observation (
      id, scope_id, subject, predicate, claim_domain, text, evidence_ids, supersedes, state, observed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  /** 稳定派生 id：同键 + 同正文 + 同证据集重派生天然幂等（重复写不产生新行） */
  function observationIdOf({ scopeId, subject, predicate, claimDomain, text, evidenceIds }) {
    return 'obs_' + hashHex([
      scopeId, subject, predicate, claimDomain, text, JSON.stringify(evidenceIds ?? []),
    ].join('|')).slice(0, 24)
  }

  /**
   * 写入/更新一条 Observation（冲突 supersede）。
   * @param {object} input - { scopeId?, subject, predicate, claimDomain, text, evidenceIds?, id?, observedAt? }
   * @returns {{inserted: boolean, id: string, row: object|null, supersededId: string|null}}
   */
  function upsertObservation(input) {
    assertChoice(input.claimDomain, CLAIM_DOMAINS, 'claimDomain')
    const scopeId = input.scopeId ?? 'user-global'
    assertChoice(scopeId, SCOPES, 'scopeId')
    if (input.state && !OBSERVATION_STATES.includes(input.state)) {
      throw new TypeError(`observation state must be one of ${OBSERVATION_STATES.join('|')}`)
    }
    const subject = String(input.subject ?? '').trim()
    const predicate = String(input.predicate ?? '').trim()
    if (!subject || !predicate) {
      throw new TypeError('observation subject and predicate must be non-empty')
    }
    let text = String(input.text ?? '')
    if (!text) throw new TypeError('observation text must be non-empty')
    if (text.length > MAX_OBSERVATION_TEXT_CHARS) text = text.slice(0, MAX_OBSERVATION_TEXT_CHARS)
    const claimDomain = input.claimDomain
    const evidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : []
    const id = input.id ?? observationIdOf({ scopeId, subject, predicate, claimDomain, text, evidenceIds })

    // 幂等：同 id（同键+同正文+同证据）重写直接返回，不自 supersede
    const byId = db.prepare('SELECT * FROM observation WHERE id = ?').get(id)
    if (byId) return { inserted: false, id, row: toObservation(byId), supersededId: null }

    // 冲突：同键且 active 的旧行
    const conflict = db.prepare(`
      SELECT id FROM observation
      WHERE scope_id = ? AND subject = ? AND predicate = ? AND claim_domain = ? AND state = 'active'
    `).get(scopeId, subject, predicate, claimDomain)

    let supersedes = []
    let supersededId = null
    if (conflict) {
      db.prepare(`UPDATE observation SET state = 'superseded' WHERE id = ?`).run(conflict.id)
      supersedes = [conflict.id]
      supersededId = conflict.id
    }

    insertObservationStmt.run(
      id, scopeId, subject, predicate, claimDomain, text,
      JSON.stringify(evidenceIds), JSON.stringify(supersedes), 'active',
      input.observedAt ?? new Date().toISOString(), Date.now(),
    )
    return { inserted: true, id, row: getObservationById(id), supersededId }
  }

  function getObservationById(id) {
    const r = db.prepare('SELECT * FROM observation WHERE id = ?').get(id)
    return r ? toObservation(r) : null
  }

  /**
   * 查询 Observation（read-only）。支持 scope/state/claimDomain/subject/predicate 过滤。
   * @param {object} q
   * @returns {{items: object[], total: number}}
   */
  function queryObservation(q = {}) {
    const conds = []
    const params = []
    if (q.scopeId) { conds.push('scope_id = ?'); params.push(q.scopeId) }
    if (q.state) { conds.push('state = ?'); params.push(q.state) }
    if (q.claimDomain) { conds.push('claim_domain = ?'); params.push(q.claimDomain) }
    if (q.subject) { conds.push('subject = ?'); params.push(q.subject) }
    if (q.predicate) { conds.push('predicate = ?'); params.push(q.predicate) }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
    const limit = Math.min(q.limit ?? 50, 200)
    const rows = db.prepare(`SELECT * FROM observation ${where} ORDER BY created_at ASC LIMIT ?`).all(...params, limit)
    const total = db.prepare(`SELECT COUNT(*) AS c FROM observation ${where}`).get(...params).c
    return { items: rows.map(toObservation), total }
  }

  /** 全部 active Observation（供快照/导出） */
  function listObservations(scopeId) {
    const rows = scopeId
      ? db.prepare('SELECT * FROM observation WHERE state = ? AND scope_id = ? ORDER BY created_at ASC').all('active', scopeId)
      : db.prepare('SELECT * FROM observation WHERE state = ? ORDER BY created_at ASC').all('active')
    return rows.map(toObservation)
  }

  /** 演进历史：[最旧 ... 最新]（沿 supersedes 直接前驱回溯，含 id 自己） */
  function getObservationLineage(id) {
    if (!getObservationById(id)) throw new Error(`observation '${id}' not found`)
    const collected = []
    const seen = new Set()
    const walk = (obs) => {
      if (seen.has(obs.id)) return
      seen.add(obs.id)
      for (const prevId of obs.supersedes ?? []) {
        const prev = getObservationById(prevId)
        if (!prev) continue // 悬挂引用容忍
        walk(prev)
      }
      collected.push(obs.id)
    }
    walk(getObservationById(id))
    const createdAt = new Map(collected.map((oid) => [oid, getObservationById(oid).createdAt]))
    return collected.slice().sort((a, b) => createdAt.get(a) - createdAt.get(b))
  }

  let closed = false
  function close() {
    if (closed) return // 幂等：重复 close 是 no-op
    closed = true
    db.close()
  }

  return {
    db, dbPath,
    append, getById, setState, updateMetadata, query, byContentHash, listActive, stats,
    getMeta, setMeta,
    upsertObservation, getObservationById, queryObservation, listObservations, getObservationLineage,
    close,
  }
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

function toObservation(r) {
  return {
    id: r.id,
    scopeId: r.scope_id,
    subject: r.subject,
    predicate: r.predicate,
    claimDomain: r.claim_domain,
    text: r.text,
    evidenceIds: JSON.parse(r.evidence_ids),
    supersedes: JSON.parse(r.supersedes),
    state: r.state,
    observedAt: r.observed_at,
    createdAt: r.created_at,
  }
}