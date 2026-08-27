// src/export-import.mjs — 全量导出 / 导入（M3 C2，JSONL）。
//
// 用途：数据迁移合并（v0.1 两库 67 条合一）、用户审计导出、跨实例备份恢复。
// 格式：JSONL，每行一条 {kind, version, ts, data}。
//   version = 1（当前格式版本）；ts = 导出批次时间戳（同批所有行相同；
//   测试/迁移校验可显式传 ts 得到确定性输出）。
//   kind ∈ evidence | observation | candidate | audit。
//
// 关键设计：
//   - exportJsonl 是全量快照（不做 scope/state 过滤、不受 query 200 行上限约束）——
//     evidence/observation/audit 直接经 ledger.db 读取全部行（store 无无界公开读 API）；
//     candidate 用 candidateStore.replayCandidates()（事件重放投影，重放自足）+ 原始事件行。
//   - importJsonl 是"原样恢复"（M3-PLAN §6.5：candidate/audit 原样）：直接 INSERT OR
//     IGNORE 写表，幂等键 = evidence contentHash / observation id / candidate id / audit id，
//     已存在一律 skip；不经 ledger.append/upsertObservation（避免导入过程产生新的
//     append/observation-upsert audit 行——否则 export→import→export 往返不幂等）。
//   - 容错：单行坏 JSON / 缺字段 / 枚举非法 → 记入 errors（{line, message}），继续处理。
//   - 单行事务：candidate（行 + 事件）跨语句写入用事务保证原子性；坏行 ROLLBACK 不残留。

import {
  AUTHORITIES, SOURCE_CLASSES, CLAIM_DOMAINS, SENSITIVITIES, SCOPES, SESSION_TYPES,
  EVIDENCE_STATES, OBSERVATION_STATES, MAX_EVIDENCE_CONTENT_CHARS, MAX_OBSERVATION_TEXT_CHARS,
} from './constants.mjs'
import { assertAuthorityConsistent } from './governance.mjs'
import { CANDIDATE_STATES, EVENT_TO_STATE } from './candidate.mjs'
import { AUDIT_OPS, AUDIT_ACTORS } from './audit.mjs'

/** 当前导出格式版本（拒绝导入未来版本，防静默错位） */
export const EXPORT_VERSION = 1

/** 合法流名（与 M3-PLAN §6.5 一致） */
export const EXPORT_STREAMS = Object.freeze(['evidence', 'observation', 'candidate', 'audit'])

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(label + ' must be one of ' + allowed.join('|') + ', got ' + JSON.stringify(value))
  }
}

function assertNumberIn(value, min, max, label) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    throw new TypeError(label + ' must be a number in [' + min + ',' + max + '], got ' + JSON.stringify(value))
  }
}

// ===================== 行 → 导出形状（与 store.mjs toX 对齐，camelCase） =====================

function rowToEvidence(r) {
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

function rowToObservation(r) {
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

function rowToAudit(r) {
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

function safeJson(text) {
  try { return text ? JSON.parse(text) : null } catch { return null }
}

/**
 * 导出 JSONL 全量快照。
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的 Provider（含 db / candidateStore / auditStore）
 * @param {object} [opts.candidateStore] - 缺省取 ledger.candidateStore
 * @param {object} [opts.auditStore] - 缺省取 ledger.auditStore
 * @param {string[]} [opts.streams] - ['evidence','observation','candidate','audit'] 子集，缺省全量
 * @param {number} [opts.ts] - 导出批次时间戳（缺省 Date.now()）；显式传入可获得确定性输出
 * @returns {string} JSONL 文本（非空时末尾带换行；空库返回 ''）
 */
export function exportJsonl(opts = {}) {
  const ledger = opts.ledger
  if (!ledger || typeof ledger.db?.prepare !== 'function') {
    throw new TypeError('exportJsonl requires { ledger } (openEvidenceLedger handle)')
  }
  const candidateStore = opts.candidateStore ?? ledger.candidateStore
  const auditStore = opts.auditStore ?? ledger.auditStore
  const kinds = opts.streams ?? EXPORT_STREAMS
  const stamp = opts.ts ?? Date.now()
  const lines = []
  for (const kind of kinds) {
    if (!EXPORT_STREAMS.includes(kind)) {
      throw new TypeError('unknown stream ' + JSON.stringify(kind) + ' (allowed: ' + EXPORT_STREAMS.join('|') + ')')
    }
    for (const data of readStream(kind, { ledger, candidateStore, auditStore })) {
      lines.push(JSON.stringify({ kind, version: EXPORT_VERSION, ts: stamp, data }))
    }
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

function readStream(kind, deps) {
  switch (kind) {
    case 'evidence':
      return deps.ledger.db.prepare('SELECT * FROM evidence ORDER BY created_at ASC, id ASC').all().map(rowToEvidence)
    case 'observation':
      return deps.ledger.db.prepare('SELECT * FROM observation ORDER BY created_at ASC, id ASC').all().map(rowToObservation)
    case 'audit':
      return deps.ledger.db.prepare('SELECT * FROM audit ORDER BY id ASC').all().map(rowToAudit)
    case 'candidate':
      return readCandidates(deps)
    default:
      throw new TypeError('unknown stream ' + JSON.stringify(kind))
  }
}

/** candidate：事件重放投影（restart 一致）+ 完整事件历史（导入后重放自足） */
function readCandidates(deps) {
  const replay = deps.candidateStore?.replayCandidates?.() ?? new Map()
  const events = deps.ledger.db.prepare('SELECT * FROM candidate_events ORDER BY id ASC').all()
  const eventsByCandidate = new Map()
  for (const ev of events) {
    if (!eventsByCandidate.has(ev.candidate_id)) eventsByCandidate.set(ev.candidate_id, [])
    eventsByCandidate.get(ev.candidate_id).push({
      candidateId: ev.candidate_id,
      ts: ev.ts,
      event: ev.event,
      reason: ev.reason,
      actor: ev.actor,
      payload: safeJson(ev.payload),
    })
  }
  const rows = [...replay.values()]
  rows.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows.map((c) => ({ ...c, events: eventsByCandidate.get(c.id) ?? [] }))
}

// ===================== 导入 =====================

/**
 * 导入 JSONL（幂等 + 容错）。
 * @param {string} text - JSONL 文本
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的 Provider
 * @param {object} [opts.candidateStore] - 缺省取 ledger.candidateStore
 * @param {object} [opts.auditStore] - 缺省取 ledger.auditStore
 * @returns {{inserted: number, skipped: number, errors: {line: number, message: string}[]}}
 *   inserted = 实际写入行数；skipped = 幂等跳过行数；errors = 坏行记录（不中断）
 */
export function importJsonl(text, opts = {}) {
  const ledger = opts.ledger
  if (!ledger || typeof ledger.db?.prepare !== 'function') {
    throw new TypeError('importJsonl requires { ledger } (openEvidenceLedger handle)')
  }
  const deps = {
    ledger,
    candidateStore: opts.candidateStore ?? ledger.candidateStore,
    auditStore: opts.auditStore ?? ledger.auditStore,
  }
  const result = { inserted: 0, skipped: 0, errors: [] }
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('line is not a JSON object')
      }
      if (obj.version !== EXPORT_VERSION) {
        throw new Error('unsupported export version ' + JSON.stringify(obj.version) + ' (expected ' + EXPORT_VERSION + ')')
      }
      const outcome = importLine(obj, deps)
      if (outcome === 'inserted') result.inserted++
      else if (outcome === 'skipped') result.skipped++
    } catch (err) {
      result.errors.push({ line: i + 1, message: err && err.message ? err.message : String(err) })
    }
  }
  return result
}

function importLine(obj, deps) {
  const data = obj.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('data must be an object')
  }
  switch (obj.kind) {
    case 'evidence': return importEvidence(data, deps)
    case 'observation': return importObservation(data, deps)
    case 'candidate': return importCandidate(data, deps)
    case 'audit': return importAudit(data, deps)
    default: throw new Error('unknown kind ' + JSON.stringify(String(obj.kind)))
  }
}

const EVIDENCE_COLS = [
  'id', 'scope_id', 'agent_key', 'session_type', 'source_class', 'authority', 'confidence',
  'durability', 'sensitivity', 'claim_domain', 'content', 'content_hash', 'source_ref',
  'observed_at', 'valid_from', 'valid_until', 'state', 'supersedes', 'metadata', 'created_at', 'updated_at',
]

function importEvidence(data, deps) {
  const { ledger } = deps
  if (typeof data.id !== 'string' || data.id.length === 0) throw new Error('evidence.id must be a non-empty string')
  if (typeof data.contentHash !== 'string' || data.contentHash.length !== 64) {
    throw new Error('evidence.contentHash must be a sha256 hex string')
  }
  if (typeof data.content !== 'string' || data.content.length === 0) {
    throw new Error('evidence.content must be a non-empty string')
  }
  if (data.content.length > MAX_EVIDENCE_CONTENT_CHARS) {
    throw new Error('evidence.content exceeds ' + MAX_EVIDENCE_CONTENT_CHARS + ' chars')
  }
  assertEnum(data.sourceClass, SOURCE_CLASSES, 'evidence.sourceClass')
  assertEnum(data.authority, AUTHORITIES, 'evidence.authority')
  assertEnum(data.claimDomain, CLAIM_DOMAINS, 'evidence.claimDomain')
  assertEnum(data.sensitivity, SENSITIVITIES, 'evidence.sensitivity')
  assertEnum(data.scopeId ?? 'user-global', SCOPES, 'evidence.scopeId')
  assertEnum(data.sessionType ?? 'root', SESSION_TYPES, 'evidence.sessionType')
  assertEnum(data.state ?? 'active', EVIDENCE_STATES, 'evidence.state')
  assertNumberIn(data.confidence, 0, 1, 'evidence.confidence')
  assertNumberIn(data.durability, 0, 1, 'evidence.durability')
  // 与写路径同规则：authority 与 sourceClass 一致性（导入也过同一治理校验）
  assertAuthorityConsistent(data.sourceClass, data.authority)

  // 幂等键 = contentHash（M3-PLAN C2：contentHash dedup；同内容不同 sourceRef 也 skip）
  const hit = ledger.db.prepare('SELECT id FROM evidence WHERE content_hash = ? LIMIT 1').get(data.contentHash)
  if (hit) return 'skipped'

  const now = Date.now()
  const res = ledger.db.prepare(
    'INSERT OR IGNORE INTO evidence (' + EVIDENCE_COLS.join(',') + ') VALUES (' +
    EVIDENCE_COLS.map(() => '?').join(',') + ')'
  ).run(
    data.id,
    data.scopeId ?? 'user-global',
    data.agentKey ?? '',
    data.sessionType ?? 'root',
    data.sourceClass,
    data.authority,
    data.confidence,
    data.durability,
    data.sensitivity,
    data.claimDomain,
    data.content,
    data.contentHash,
    JSON.stringify(data.sourceRef ?? {}),
    data.observedAt ?? new Date().toISOString(),
    data.validFrom ?? null,
    data.validUntil ?? null,
    data.state ?? 'active',
    JSON.stringify(data.supersedes ?? []),
    JSON.stringify(data.metadata ?? {}),
    data.createdAt ?? now,
    data.updatedAt ?? now,
  )
  return Number(res.changes) > 0 ? 'inserted' : 'skipped'
}

const OBSERVATION_COLS = [
  'id', 'scope_id', 'subject', 'predicate', 'claim_domain', 'text',
  'evidence_ids', 'supersedes', 'state', 'observed_at', 'created_at',
]

function importObservation(data, deps) {
  const { ledger } = deps
  if (typeof data.id !== 'string' || data.id.length === 0) throw new Error('observation.id must be a non-empty string')
  if (typeof data.subject !== 'string' || data.subject.length === 0) throw new Error('observation.subject must be non-empty')
  if (typeof data.predicate !== 'string' || data.predicate.length === 0) throw new Error('observation.predicate must be non-empty')
  if (typeof data.text !== 'string' || data.text.length === 0) throw new Error('observation.text must be non-empty')
  if (data.text.length > MAX_OBSERVATION_TEXT_CHARS) {
    throw new Error('observation.text exceeds ' + MAX_OBSERVATION_TEXT_CHARS + ' chars')
  }
  assertEnum(data.claimDomain, CLAIM_DOMAINS, 'observation.claimDomain')
  assertEnum(data.scopeId ?? 'user-global', SCOPES, 'observation.scopeId')
  assertEnum(data.state ?? 'active', OBSERVATION_STATES, 'observation.state')

  // 幂等键 = id（store.upsertObservation 的 id 语义：同键+同正文+同证据自然幂等）
  const hit = ledger.db.prepare('SELECT id FROM observation WHERE id = ?').get(data.id)
  if (hit) return 'skipped'

  const res = ledger.db.prepare(
    'INSERT OR IGNORE INTO observation (' + OBSERVATION_COLS.join(',') + ') VALUES (' +
    OBSERVATION_COLS.map(() => '?').join(',') + ')'
  ).run(
    data.id,
    data.scopeId ?? 'user-global',
    data.subject,
    data.predicate,
    data.claimDomain,
    data.text,
    JSON.stringify(Array.isArray(data.evidenceIds) ? data.evidenceIds : []),
    JSON.stringify(Array.isArray(data.supersedes) ? data.supersedes : []),
    data.state ?? 'active',
    data.observedAt ?? new Date().toISOString(),
    data.createdAt ?? Date.now(),
  )
  return Number(res.changes) > 0 ? 'inserted' : 'skipped'
}

const CANDIDATE_COLS = [
  'id', 'scope_id', 'domain', 'evidence_ids', 'state', 'policy', 'decision_reason', 'created_at', 'updated_at',
]
const CANDIDATE_EVENT_COLS = ['candidate_id', 'ts', 'event', 'reason', 'actor', 'payload']

function importCandidate(data, deps) {
  const { ledger } = deps
  if (typeof data.id !== 'string' || data.id.length === 0) throw new Error('candidate.id must be a non-empty string')
  if (!Array.isArray(data.evidenceIds)) throw new Error('candidate.evidenceIds must be an array')
  assertEnum(data.scopeId ?? 'user-global', SCOPES, 'candidate.scopeId')
  assertEnum(data.domain, CLAIM_DOMAINS, 'candidate.domain')
  assertEnum(data.state ?? 'proposed', CANDIDATE_STATES, 'candidate.state')

  const hit = ledger.db.prepare('SELECT id FROM candidate WHERE id = ?').get(data.id)
  if (hit) return 'skipped'

  // 事件历史：缺 create 事件则合成（重放投影自足的前提），再校验重放终态与行 state 一致
  let events = Array.isArray(data.events) ? data.events.filter((e) => e && typeof e === 'object') : []
  if (!events.some((e) => e.event === 'create')) {
    events = [{
      candidateId: data.id,
      ts: data.createdAt ?? Date.now(),
      event: 'create',
      reason: 'candidate created',
      actor: 'system',
      payload: { scopeId: data.scopeId ?? 'user-global', domain: data.domain, evidenceIds: data.evidenceIds, policy: data.policy ?? null },
    }, ...events]
  }
  let replayedState = 'proposed'
  for (const ev of events) {
    if (ev.event === 'create') continue
    const next = EVENT_TO_STATE[ev.event]
    if (next) replayedState = next
  }
  const rowState = data.state ?? 'proposed'
  if (replayedState !== rowState) {
    throw new Error("candidate '" + data.id + "' events replay to state '" + replayedState + "' but row state is '" + rowState + "'")
  }

  const now = Date.now()
  const db = ledger.db
  db.exec('BEGIN IMMEDIATE')
  try {
    const res = db.prepare(
      'INSERT OR IGNORE INTO candidate (' + CANDIDATE_COLS.join(',') + ') VALUES (' +
      CANDIDATE_COLS.map(() => '?').join(',') + ')'
    ).run(
      data.id,
      data.scopeId ?? 'user-global',
      data.domain,
      JSON.stringify(data.evidenceIds),
      rowState,
      data.policy === undefined || data.policy === null ? null : JSON.stringify(data.policy),
      data.decisionReason ?? null,
      data.createdAt ?? now,
      data.updatedAt ?? now,
    )
    if (Number(res.changes) === 0) {
      db.exec('ROLLBACK')
      return 'skipped'
    }
    const insertEvent = db.prepare(
      'INSERT OR IGNORE INTO candidate_events (' + CANDIDATE_EVENT_COLS.join(',') + ') VALUES (' +
      CANDIDATE_EVENT_COLS.map(() => '?').join(',') + ')'
    )
    for (const ev of events) {
      insertEvent.run(
        ev.candidateId ?? data.id,
        typeof ev.ts === 'number' ? ev.ts : Date.now(),
        typeof ev.event === 'string' ? ev.event : 'create',
        typeof ev.reason === 'string' ? ev.reason : '',
        typeof ev.actor === 'string' ? ev.actor : 'system',
        ev.payload === undefined || ev.payload === null ? null : JSON.stringify(ev.payload),
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return 'inserted'
}

const AUDIT_COLS = ['id', 'ts', 'op', 'target_id', 'scope_id', 'actor', 'reason', 'payload']

function importAudit(data, deps) {
  const { ledger } = deps
  if (typeof data.id !== 'number' || !Number.isInteger(data.id) || data.id <= 0) {
    throw new Error('audit.id must be a positive integer')
  }
  assertEnum(data.op, AUDIT_OPS, 'audit.op')
  assertEnum(data.scopeId ?? 'user-global', SCOPES, 'audit.scopeId')
  assertEnum(data.actor ?? 'system', AUDIT_ACTORS, 'audit.actor')

  // 幂等键 = id
  const hit = ledger.db.prepare('SELECT id FROM audit WHERE id = ?').get(data.id)
  if (hit) return 'skipped'

  const res = ledger.db.prepare(
    'INSERT OR IGNORE INTO audit (' + AUDIT_COLS.join(',') + ') VALUES (' +
    AUDIT_COLS.map(() => '?').join(',') + ')'
  ).run(
    data.id,
    typeof data.ts === 'number' ? data.ts : Date.now(),
    data.op,
    data.targetId ?? null,
    data.scopeId ?? 'user-global',
    data.actor ?? 'system',
    data.reason ?? '',
    data.payload === undefined || data.payload === null ? null : JSON.stringify(data.payload),
  )
  return Number(res.changes) > 0 ? 'inserted' : 'skipped'
}
