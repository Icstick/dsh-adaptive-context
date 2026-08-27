// test/candidate.test.mjs — M3 B1：Candidate 生命周期（五态）+ Audit 验收测试。
// 运行：node test/candidate.test.mjs（单文件直跑，不要用 node --test 递归）
// 覆盖：CRUD / 五态迁移全路径 / 非法迁移拒绝 / 重放投影一致性（restart 模拟）/
//       audit 写入与查询 / store 写操作内置 audit / 迁移 v2→v3
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openEvidenceLedger } from '../src/store.mjs'
import { CandidateError, CANDIDATE_STATES } from '../src/candidate.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-candidate-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

function baseEv(overrides = {}) {
  return {
    sourceClass: 'user_input',
    authority: 'user_explicit',
    confidence: 1,
    durability: 0.9,
    sensitivity: 'private',
    claimDomain: 'user_fact',
    content: '项目 package manager 一律用 pnpm',
    observedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

// ===================== Candidate CRUD =====================

test('createCandidate → {id, state:proposed}，行字段完整', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'user_preference', evidenceIds: ['ev_1', 'ev_2'] })
  assert.ok(c.id.startsWith('cand_'))
  assert.equal(c.state, 'proposed')
  assert.equal(c.scopeId, 'user-global')
  assert.equal(c.domain, 'user_preference')
  assert.deepEqual(c.evidenceIds, ['ev_1', 'ev_2'])
  assert.equal(c.decisionReason, null)
  assert.equal(c.policy, null)
  assert.equal(c.createdAt > 0, true)
});

test('getCandidate：存在返回行，不存在返回 null', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'workspace', domain: 'work', evidenceIds: [] })
  assert.equal(s.getCandidate(c.id).id, c.id)
  assert.equal(s.getCandidate('cand_missing'), null)
});

test('listCandidates：scopeId / state 过滤 + limit', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const a = s.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e1'] })
  const b = s.createCandidate({ scopeId: 'workspace', domain: 'work', evidenceIds: ['e2'] })
  s.transitionCandidate(b.id, 'reject', { reason: 'no', actor: 'agent' })
  assert.equal(s.listCandidates({ scopeId: 'user-global' }).length, 1)
  assert.equal(s.listCandidates({ scopeId: 'workspace' }).length, 1)
  assert.equal(s.listCandidates({ state: 'proposed' }).length, 1)
  assert.equal(s.listCandidates({ state: 'rejected' })[0].id, b.id)
  assert.equal(s.listCandidates({ limit: 1 }).length, 1)
  // 默认 scopeId 是 user-global
  const c = s.createCandidate({ domain: 'experience', evidenceIds: ['e3'] })
  assert.equal(s.getCandidate(c.id).scopeId, 'user-global')
  void a
});

test('createCandidate 参数校验：非法 domain / scopeId / evidenceIds', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  assert.throws(() => s.createCandidate({ domain: 'nope', evidenceIds: [] }), TypeError)
  assert.throws(() => s.createCandidate({ scopeId: 'no-scope', domain: 'work', evidenceIds: [] }), TypeError)
  assert.throws(() => s.createCandidate({ domain: 'work', evidenceIds: 'not-array' }), TypeError)
});

// ===================== 五态迁移全路径 =====================

test('proposed → promote → promoted（decision_reason 写入）', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'user_fact', evidenceIds: ['e1', 'e2'] })
  const p = s.transitionCandidate(c.id, 'promote', { reason: 'manual approval passed', actor: 'user' })
  assert.equal(p.state, 'promoted')
  assert.equal(p.decisionReason, 'manual approval passed')
});

test('proposed → reject → rejected', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'experience', evidenceIds: ['e1'] })
  const r = s.transitionCandidate(c.id, 'reject', { reason: 'policy floor not met', actor: 'agent' })
  assert.equal(r.state, 'rejected')
  assert.equal(r.decisionReason, 'policy floor not met')
});

test('proposed → supersede → superseded', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e1'] })
  const r = s.transitionCandidate(c.id, 'supersede', { reason: 'superseded by newer candidate', actor: 'system' })
  assert.equal(r.state, 'superseded')
});

test('proposed → promote → rollback → rolled_back（全路径）', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'work', evidenceIds: ['e1', 'e2', 'e3'] })
  s.transitionCandidate(c.id, 'promote', { reason: 'ok', actor: 'user' })
  const r = s.transitionCandidate(c.id, 'rollback', { reason: 'user changed mind', actor: 'user' })
  assert.equal(r.state, 'rolled_back')
  assert.equal(r.decisionReason, 'user changed mind')
});

test('非法迁移拒绝：五态矩阵', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const mk = (domain = 'work') => s.createCandidate({ scopeId: 'user-global', domain, evidenceIds: ['e1'] })

  // 已 promoted 不能再次 promote / reject / supersede
  const p = mk()
  s.transitionCandidate(p.id, 'promote', { reason: 'x', actor: 'user' })
  assert.throws(() => s.transitionCandidate(p.id, 'promote', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')
  assert.throws(() => s.transitionCandidate(p.id, 'reject', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')
  assert.throws(() => s.transitionCandidate(p.id, 'supersede', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')

  // promoted 只能 rollback
  const r = s.transitionCandidate(p.id, 'rollback', { reason: 'undo', actor: 'user' })
  assert.equal(r.state, 'rolled_back')
  // 终态 rolled_back 上任何迁移都拒绝
  for (const ev of ['promote', 'reject', 'rollback', 'supersede']) {
    assert.throws(() => s.transitionCandidate(p.id, ev, { reason: 'x', actor: 'user' }),
      (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')
  }

  // proposed 不能 rollback（从未 promoted）
  const pr = mk('style')
  assert.throws(() => s.transitionCandidate(pr.id, 'rollback', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')

  // rejected 终态
  const rj = mk()
  s.transitionCandidate(rj.id, 'reject', { reason: 'x', actor: 'agent' })
  assert.throws(() => s.transitionCandidate(rj.id, 'promote', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')

  // superseded 终态
  const ss = mk()
  s.transitionCandidate(ss.id, 'supersede', { reason: 'x', actor: 'system' })
  assert.throws(() => s.transitionCandidate(ss.id, 'promote', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')
});

test('非法迁移拒绝：未知事件 / 不存在候选 / 非法 actor', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'work', evidenceIds: ['e1'] })
  assert.throws(() => s.transitionCandidate(c.id, 'explode', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')
  assert.throws(() => s.transitionCandidate('cand_missing', 'promote', { reason: 'x', actor: 'user' }),
    (e) => e instanceof CandidateError && e.code === 'NOT_FOUND')
  assert.throws(() => s.transitionCandidate(c.id, 'promote', { reason: 'x', actor: 'robot' }),
    (e) => e instanceof CandidateError && e.code === 'INVALID_INPUT')
});

test('事件 append-only：每次迁移产生一行 candidate_events', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'work', evidenceIds: ['e1'] })
  s.transitionCandidate(c.id, 'promote', { reason: 'ok', actor: 'user' })
  s.transitionCandidate(c.id, 'rollback', { reason: 'undo', actor: 'user' })
  const events = ledger.db.prepare('SELECT * FROM candidate_events WHERE candidate_id = ? ORDER BY id ASC').all(c.id)
  assert.equal(events.length, 3) // create + promote + rollback
  assert.deepEqual(events.map((e) => e.event), ['create', 'promote', 'rollback'])
  assert.equal(events[2].reason, 'undo')
  assert.equal(events[1].actor, 'user')
});

// ===================== 重放投影一致性 =====================

test('replayCandidates：多候选混合状态投影与实时行一致', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const a = s.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e1'] })
  const b = s.createCandidate({ scopeId: 'workspace', domain: 'work', evidenceIds: ['e2', 'e3'] })
  s.transitionCandidate(a.id, 'promote', { reason: 'ok', actor: 'user' })
  s.transitionCandidate(b.id, 'reject', { reason: 'weak evidence', actor: 'agent' })

  const replay = s.replayCandidates()
  assert.ok(replay instanceof Map)
  assert.equal(replay.size, 2)
  assert.equal(replay.get(a.id).state, 'promoted')
  assert.equal(replay.get(b.id).state, 'rejected')
  assert.equal(replay.get(a.id).scopeId, 'user-global')
  assert.equal(replay.get(b.id).scopeId, 'workspace')
  assert.deepEqual(replay.get(b.id).evidenceIds, ['e2', 'e3'])
  assert.equal(replay.get(b.id).decisionReason, 'weak evidence')
  // 与实时投影一致
  assert.equal(replay.get(a.id).state, s.getCandidate(a.id).state)
  assert.equal(replay.get(b.id).state, s.getCandidate(b.id).state)
});

test('重放投影：restart 模拟（关库重开 → 状态一致）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-candidate-restart-'))
  try {
    let ledger = openEvidenceLedger({ dir })
    let s = ledger.candidateStore
    const c = s.createCandidate({ scopeId: 'user-global', domain: 'user_preference', evidenceIds: ['ev_1', 'ev_2'] })
    s.transitionCandidate(c.id, 'promote', { reason: 'manual approval', actor: 'user' })
    s.transitionCandidate(c.id, 'rollback', { reason: 'user changed mind', actor: 'user' })
    ledger.close()

    // 模拟 restart：重新打开同一库
    ledger = openEvidenceLedger({ dir })
    s = ledger.candidateStore
    const replay = s.replayCandidates()
    const live = s.getCandidate(c.id)
    assert.equal(replay.get(c.id).state, 'rolled_back')
    assert.equal(replay.get(c.id).state, live.state)
    assert.equal(replay.get(c.id).decisionReason, 'user changed mind')
    assert.equal(replay.get(c.id).decisionReason, live.decisionReason)
    assert.deepEqual(replay.get(c.id).evidenceIds, ['ev_1', 'ev_2'])
    assert.deepEqual(replay.get(c.id).evidenceIds, live.evidenceIds)
    assert.equal(replay.get(c.id).updatedAt, live.updatedAt)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
});

test('重放投影：悬挂事件（无 create 前驱）容忍跳过', (t) => {
  const ledger = freshLedger(t)
  const s = ledger.candidateStore
  const c = s.createCandidate({ scopeId: 'user-global', domain: 'work', evidenceIds: ['e1'] })
  // 手工塞一条无 create 前驱的事件
  ledger.db.prepare('INSERT INTO candidate_events (candidate_id, ts, event, reason, actor, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cand_orphan', Date.now(), 'promote', 'orphan', 'system', null)
  const replay = s.replayCandidates()
  assert.equal(replay.has('cand_orphan'), false)
  assert.equal(replay.get(c.id).state, 'proposed')
});

// ===================== Audit =====================

test('audit：appendAudit / queryAudit 基本读写与过滤', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.auditStore
  const id1 = a.appendAudit({ op: 'promote', targetId: 'cand_x', scopeId: 'user-global', actor: 'user', reason: 'manual approval', payload: { path: 'expression' } })
  a.appendAudit({ op: 'rollback', targetId: 'cand_x', scopeId: 'workspace', actor: 'user', reason: 'wrong promotion' })
  a.appendAudit({ op: 'export', scopeId: 'user-global', actor: 'agent' })
  assert.ok(typeof id1 === 'number' && id1 > 0)

  const byOp = a.queryAudit({ op: 'promote' })
  assert.equal(byOp.total, 1)
  assert.equal(byOp.items[0].op, 'promote')
  assert.equal(byOp.items[0].targetId, 'cand_x')
  assert.equal(byOp.items[0].actor, 'user')
  assert.equal(byOp.items[0].reason, 'manual approval')
  assert.deepEqual(byOp.items[0].payload, { path: 'expression' })
  assert.ok(byOp.items[0].ts > 0)

  assert.equal(a.queryAudit({ scopeId: 'workspace' }).items.length, 1)
  assert.equal(a.queryAudit({ actor: 'agent' }).items.length, 1)
  const lim = a.queryAudit({ limit: 2 })
  assert.equal(lim.items.length, 2)
  assert.equal(lim.total, 3)
  // 最新在前
  assert.equal(lim.items[0].op, 'export')
});

test('audit：非法 op / actor / scopeId 拒绝', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.auditStore
  assert.throws(() => a.appendAudit({ op: 'nope', scopeId: 'user-global', actor: 'system' }), TypeError)
  assert.throws(() => a.appendAudit({ op: 'append', scopeId: 'user-global', actor: 'robot' }), TypeError)
  assert.throws(() => a.appendAudit({ op: 'append', scopeId: 'no-such-scope', actor: 'system' }), TypeError)
});

test('store 内置 audit：append → op=append（重复 append 不重复记）', (t) => {
  const ledger = freshLedger(t)
  const ev = baseEv({ sourceRef: { sessionEventId: 'a' } })
  const r1 = ledger.append(ev)
  ledger.append(ev) // 幂等 no-op，不产生 audit
  const rows = ledger.auditStore.queryAudit({ op: 'append' })
  assert.equal(rows.items.length, 1)
  assert.equal(rows.items[0].actor, 'system')
  assert.equal(rows.items[0].targetId, r1.id)
  assert.equal(rows.items[0].scopeId, 'user-global')
  assert.equal(rows.items[0].payload.contentHash.length, 64)
});

test('store 内置 audit：setState superseded → op=supersede（其余状态不记）', (t) => {
  const ledger = freshLedger(t)
  const old = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  ledger.setState(old.id, 'superseded', { supersedes: ['ev_other'] })
  const rows = ledger.auditStore.queryAudit({ op: 'supersede' })
  assert.equal(rows.items.length, 1)
  assert.equal(rows.items[0].targetId, old.id)
  assert.equal(rows.items[0].actor, 'system')
  assert.deepEqual(rows.items[0].payload.supersedes, ['ev_other'])
  // quarantine 不产生 supersede audit
  const q = ledger.append(baseEv({ sourceRef: { sessionEventId: 'q' } }))
  ledger.setState(q.id, 'quarantined')
  assert.equal(ledger.auditStore.queryAudit({ op: 'supersede' }).items.length, 1)
});

test('store 内置 audit：upsertObservation → op=observation-upsert（幂等不重复记，冲突记录 supersededId）', (t) => {
  const ledger = freshLedger(t)
  const inp = { subject: 'pkg', predicate: 'uses', claimDomain: 'work', text: 'pnpm', evidenceIds: ['ev_1'] }
  const r1 = ledger.upsertObservation(inp)
  assert.equal(r1.inserted, true)
  ledger.upsertObservation(inp) // 幂等
  const rows = ledger.auditStore.queryAudit({ op: 'observation-upsert' })
  assert.equal(rows.items.length, 1)
  assert.equal(rows.items[0].targetId, r1.id)
  assert.equal(rows.items[0].actor, 'system')
  // 冲突 supersede 路径
  const r2 = ledger.upsertObservation({ ...inp, text: 'bun' })
  assert.equal(r2.supersededId, r1.id)
  const rows2 = ledger.auditStore.queryAudit({ op: 'observation-upsert' })
  assert.equal(rows2.items.length, 2)
  assert.equal(rows2.items[0].payload.supersededId, r1.id)
});

// ===================== 迁移 v2 → v3 =====================

const V2_EVIDENCE_SQL = [
  'CREATE TABLE acp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);'
  , 'CREATE TABLE evidence ('
  , "  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT '',"
  , '  session_type TEXT NOT NULL, source_class TEXT NOT NULL, authority TEXT NOT NULL,'
  , '  confidence REAL NOT NULL, durability REAL NOT NULL, sensitivity TEXT NOT NULL,'
  , '  claim_domain TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,'
  , '  source_ref TEXT NOT NULL, observed_at TEXT NOT NULL, valid_from TEXT, valid_until TEXT,'
  , "  state TEXT NOT NULL DEFAULT 'active', supersedes TEXT NOT NULL DEFAULT '[]',"
  , "  metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL"
  , ');'
  , 'CREATE TABLE observation ('
  , '  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL,'
  , "  claim_domain TEXT NOT NULL, text TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]',"
  , "  supersedes TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'active',"
  , '  observed_at TEXT NOT NULL, created_at INTEGER NOT NULL'
  , ');'
  , "INSERT INTO acp_meta (key, value) VALUES ('schema_version', '2');"
].join('\n')

test('迁移 v2→v3：旧库打开后三表存在、schema_version=3、旧数据保留、写操作可用且产生 audit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-candidate-migrate-'))
  try {
    // 手工构造 v2 库（schema v2 原样：acp_meta + evidence + observation）
    const v2db = new DatabaseSync(path.join(dir, 'acp-ledger.db'))
    v2db.exec(V2_EVIDENCE_SQL)
    const now = Date.now()
    v2db.prepare(
      'INSERT INTO evidence (id, scope_id, agent_key, session_type, source_class, authority, confidence, durability,' +
      ' sensitivity, claim_domain, content, content_hash, source_ref, observed_at, state, supersedes, metadata, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ev_v2', 'user-global', '', 'root', 'user_input', 'user_explicit', 1, 0.9, 'private', 'user_fact',
      '迁移前旧证据', 'deadbeef', '{}', '2026-08-01T00:00:00.000Z', 'active', '[]', '{}', now, now)
    v2db.close()

    // 用新代码打开：迁移应发生
    const ledger = openEvidenceLedger({ dir })
    assert.equal(ledger.getMeta('schema_version'), '3')

    // 三表存在
    const tables = ledger.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('candidate','candidate_events','audit')")
      .all().map((r) => r.name).sort()
    assert.deepEqual(tables, ['audit', 'candidate', 'candidate_events'])

    // 旧数据保留且可读
    const old = ledger.getById('ev_v2')
    assert.ok(old)
    assert.equal(old.content, '迁移前旧证据')
    assert.equal(old.state, 'active')

    // 写操作可用且内置 audit
    const res = ledger.append(baseEv({ content: '迁移后新证据', sourceRef: { sessionEventId: 'm1' } }))
    assert.equal(res.inserted, true)
    assert.equal(ledger.auditStore.queryAudit({ op: 'append' }).items.length, 1)

    // candidate 表可用（DDL 有效）
    const c = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'work', evidenceIds: ['ev_v2'] })
    assert.equal(c.state, 'proposed')
    assert.equal(ledger.candidateStore.listCandidates().length, 1)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
});

test('新库：schema_version 直接为 3，三表存在（CANDIDATE_STATES 导出正确）', (t) => {
  const ledger = freshLedger(t)
  assert.equal(ledger.getMeta('schema_version'), '3')
  const tables = ledger.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('candidate','candidate_events','audit')")
    .all().map((r) => r.name).sort()
  assert.deepEqual(tables, ['audit', 'candidate', 'candidate_events'])
  assert.deepEqual(CANDIDATE_STATES, ['proposed', 'promoted', 'rejected', 'superseded', 'rolled_back'])
});
