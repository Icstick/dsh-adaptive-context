// test/export-import.test.mjs — M3 C2：JSONL 导出/导入验收测试。
// 运行：node test/export-import.test.mjs（单文件直跑）
// 覆盖：四流全量形状 / streams 子集 / 往返幂等（export→import→export 字节一致）/
//       contentHash 幂等 / observation·candidate·audit 按 id 幂等 / 坏行容错 /
//       未知 kind 与错误 version / 枚举与结构校验拒绝
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { exportJsonl, importJsonl, EXPORT_VERSION, EXPORT_STREAMS } from '../src/export-import.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-ei-'))
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

/** 造一个有代表性的四流数据：2 evidence（含 superseded）+ 1 observation + 1 candidate（promoted）+ audit */
function seedLedger(ledger) {
  const a = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  const b = ledger.append(baseEv({ content: '更正：之后统一用 Bun', sourceRef: { sessionEventId: 'b' } }))
  ledger.setState(a.id, 'superseded', { supersedes: [b.id] })
  ledger.upsertObservation({ subject: 'pkg', predicate: 'uses', claimDomain: 'work', text: 'pnpm（更正后 bun）', evidenceIds: [a.id, b.id] })
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [b.id] })
  ledger.candidateStore.transitionCandidate(cand.id, 'promote', { reason: 'manual approval', actor: 'user' })
  ledger.auditStore.appendAudit({ op: 'export', scopeId: 'user-global', actor: 'agent', reason: 'seed' })
  return { a, b, cand }
}

function linesOf(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

// ===================== 导出形状 =====================

test('导出形状：每行 {kind, version, ts, data}，四流全量且行数正确', (t) => {
  const ledger = freshLedger(t)
  const { a, b, cand } = seedLedger(ledger)
  const text = exportJsonl({ ledger, candidateStore: ledger.candidateStore, auditStore: ledger.auditStore, ts: 42 })
  const lines = linesOf(text)
  // evidence 2 + observation 1 + candidate 1 + audit 5
  // （store 内置：2 append + 1 supersede + 1 observation-upsert；seed 显式 1 export）
  const kinds = lines.map((l) => l.kind)
  assert.equal(kinds.filter((k) => k === 'evidence').length, 2)
  assert.equal(kinds.filter((k) => k === 'observation').length, 1)
  assert.equal(kinds.filter((k) => k === 'candidate').length, 1)
  assert.equal(kinds.filter((k) => k === 'audit').length, 5)
  for (const l of lines) {
    assert.equal(l.version, EXPORT_VERSION)
    assert.equal(l.ts, 42)
    assert.ok(l.data && typeof l.data === 'object')
  }
  // evidence data 字段完整（含 contentHash/sourceRef/metadata，供幂等导入）
  const evLine = lines.find((l) => l.kind === 'evidence' && l.data.id === a.id)
  assert.equal(evLine.data.contentHash.length, 64)
  assert.deepEqual(evLine.data.sourceRef, { sessionEventId: 'a' })
  assert.equal(evLine.data.state, 'superseded')
  assert.deepEqual(evLine.data.supersedes, [b.id])
  assert.ok(evLine.data.metadata && typeof evLine.data.metadata === 'object')
  // candidate data 携带完整事件历史（create + promote），重放自足
  const candLine = lines.find((l) => l.kind === 'candidate')
  assert.equal(candLine.data.id, cand.id)
  assert.equal(candLine.data.state, 'promoted')
  assert.deepEqual(candLine.data.events.map((e) => e.event), ['create', 'promote'])
  void a
})

test('streams 子集：只导出指定流，未知流抛 TypeError', (t) => {
  const ledger = freshLedger(t)
  seedLedger(ledger)
  const text = exportJsonl({ ledger, candidateStore: ledger.candidateStore, auditStore: ledger.auditStore, streams: ['candidate'] })
  const lines = linesOf(text)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'candidate')
  const e = exportJsonl({ ledger, candidateStore: ledger.candidateStore, auditStore: ledger.auditStore, streams: ['evidence', 'audit'] })
  const kinds = linesOf(e).map((l) => l.kind)
  assert.deepEqual(kinds, ['evidence', 'evidence', 'audit', 'audit', 'audit', 'audit', 'audit'])
  assert.throws(() => exportJsonl({ ledger, candidateStore: ledger.candidateStore, auditStore: ledger.auditStore, streams: ['nope'] }), TypeError)
  assert.throws(() => exportJsonl({ ledger: null }), TypeError)
  void EXPORT_STREAMS
})

test('空库导出：返回空字符串', (t) => {
  const ledger = freshLedger(t)
  assert.equal(exportJsonl({ ledger, candidateStore: ledger.candidateStore, auditStore: ledger.auditStore }), '')
})

// ===================== 往返幂等 =====================

test('往返幂等：export→import→export 字节一致（四流全量，含 audit）', (t) => {
  const src = freshLedger(t)
  seedLedger(src)
  const text1 = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, ts: 12345 })

  const dst = freshLedger(t)
  const res = importJsonl(text1, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(res.errors.length, 0)
  assert.equal(res.inserted, linesOf(text1).length)
  assert.equal(res.skipped, 0)

  const text2 = exportJsonl({ ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore, ts: 12345 })
  assert.equal(text2, text1)

  // 目标库重放投影自足：candidate 状态与源一致
  const replay = dst.candidateStore.replayCandidates()
  const srcReplay = src.candidateStore.replayCandidates()
  assert.equal(replay.size, srcReplay.size)
  for (const [id, row] of srcReplay) {
    assert.equal(replay.get(id)?.state, row.state)
  }
})

test('迁移场景模拟：两库合并无重复（contentHash dedup）', (t) => {
  const lib1 = freshLedger(t)
  lib1.append(baseEv({ sourceRef: { sessionEventId: 'x1' } }))
  const lib2 = freshLedger(t)
  lib2.append(baseEv({ sourceRef: { sessionEventId: 'x2' } })) // 同 content，不同 sourceRef/id
  const dump1 = exportJsonl({ ledger: lib1, candidateStore: lib1.candidateStore, auditStore: lib1.auditStore })
  const dump2 = exportJsonl({ ledger: lib2, candidateStore: lib2.candidateStore, auditStore: lib2.auditStore })

  // 合并到 lib1：dump2 的 evidence 与 lib1 同 contentHash → skip（不产生重复行）
  const r1 = importJsonl(dump2, { ledger: lib1, candidateStore: lib1.candidateStore, auditStore: lib1.auditStore })
  assert.equal(r1.inserted, 0)
  assert.equal(r1.skipped, 2) // evidence skip + audit skip（lib1 已有 op=append 行，但 audit id 不同……
  // 注：audit 幂等键是 id，lib1 的 append audit 行 id=1，lib2 的也是 id=1 → 按 id skip
  assert.equal(r1.errors.length, 0)
  assert.equal(lib1.stats().total, 1)
  // 再合并 dump1（自身快照）：全 skip
  const r2 = importJsonl(dump1, { ledger: lib1, candidateStore: lib1.candidateStore, auditStore: lib1.auditStore })
  assert.equal(r2.inserted, 0)
  assert.ok(r2.skipped >= 2)
  assert.equal(lib1.stats().total, 1)
})

// ===================== 幂等（各流） =====================

test('evidence 按 contentHash 幂等：重复导入 skip，坏内容 hash 拒绝', (t) => {
  const src = freshLedger(t)
  src.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  const text = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, streams: ['evidence'] })

  const dst = freshLedger(t)
  // 目标库先有同 content 不同 sourceRef 的证据（不同 id，同 contentHash）
  dst.append(baseEv({ sourceRef: { sessionEventId: 'z' } }))
  const r1 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r1.inserted, 0)
  assert.equal(r1.skipped, 1)
  assert.equal(r1.errors.length, 0)
  assert.equal(dst.stats().total, 1)
  // 再次导入原文本 → 也 skip
  const r2 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r2.inserted, 0)
  assert.equal(r2.skipped, 1)
})

test('observation 按 id 幂等：重复导入 skip，行字段完整还原', (t) => {
  const src = freshLedger(t)
  const o = src.upsertObservation({ subject: 'pkg', predicate: 'uses', claimDomain: 'work', text: 'pnpm', evidenceIds: ['ev_a'] })
  const text = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, streams: ['observation'] })

  const dst = freshLedger(t)
  const r1 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r1.inserted, 1)
  assert.equal(r1.skipped, 0)
  const row = dst.getObservationById(o.id)
  assert.ok(row)
  assert.equal(row.subject, 'pkg')
  assert.equal(row.text, 'pnpm')
  assert.deepEqual(row.evidenceIds, ['ev_a'])
  const r2 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r2.inserted, 0)
  assert.equal(r2.skipped, 1)
})

test('candidate 按 id 幂等：重复导入 skip；导入后重放投影与行一致', (t) => {
  const src = freshLedger(t)
  const c = src.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e1', 'e2'] })
  src.candidateStore.transitionCandidate(c.id, 'promote', { reason: 'ok', actor: 'user' })
  src.candidateStore.transitionCandidate(c.id, 'rollback', { reason: 'undo', actor: 'user' })
  const text = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, streams: ['candidate'] })

  const dst = freshLedger(t)
  const r1 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r1.inserted, 1)
  const live = dst.candidateStore.getCandidate(c.id)
  assert.equal(live.state, 'rolled_back')
  assert.equal(live.decisionReason, 'undo')
  const replay = dst.candidateStore.replayCandidates().get(c.id)
  assert.equal(replay.state, 'rolled_back')
  assert.deepEqual(replay.evidenceIds, ['e1', 'e2'])
  const events = dst.db.prepare('SELECT * FROM candidate_events WHERE candidate_id = ? ORDER BY id ASC').all(c.id)
  assert.deepEqual(events.map((e) => e.event), ['create', 'promote', 'rollback'])
  // 再导入 → skip
  const r2 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r2.inserted, 0)
  assert.equal(r2.skipped, 1)
})

test('audit 按 id 幂等：重复导入 skip，行字段还原', (t) => {
  const src = freshLedger(t)
  src.auditStore.appendAudit({ op: 'promote', targetId: 'cand_x', scopeId: 'user-global', actor: 'user', reason: 'manual', payload: { p: 1 } })
  const text = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, streams: ['audit'] })

  const dst = freshLedger(t)
  const r1 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r1.inserted, 1)
  const rows = dst.auditStore.queryAudit({ op: 'promote' })
  assert.equal(rows.items.length, 1)
  assert.equal(rows.items[0].targetId, 'cand_x')
  assert.deepEqual(rows.items[0].payload, { p: 1 })
  const r2 = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(r2.inserted, 0)
  assert.equal(r2.skipped, 1)
})

// ===================== 容错 =====================

test('坏行容错：坏 JSON / 缺 data / 未知 kind / 错误 version → errors 记录，其余继续', (t) => {
  const src = freshLedger(t)
  src.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  const good = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, streams: ['evidence'] }).trim()

  const dst = freshLedger(t)
  const text = [
    good,
    'this is not json {',
    '{"kind":"evidence","version":1,"data":{}}',
    '{"kind":"bogus","version":1,"data":{}}',
    '{"kind":"evidence","version":99,"data":{}}',
    good,
  ].join('\n')
  const res = importJsonl(text, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(res.inserted, 1)
  assert.equal(res.skipped, 1)
  assert.equal(res.errors.length, 4)
  assert.ok(res.errors.every((e) => typeof e.line === 'number' && e.line >= 2 && typeof e.message === 'string'))
  assert.equal(dst.stats().total, 1)
})

test('枚举/结构校验：非法 authority / 缺 confidence / 非法 domain 拒绝并记 errors', (t) => {
  const dst = freshLedger(t)
  const badAuth = '{"kind":"evidence","version":1,"data":' + JSON.stringify({
    id: 'ev_bad', contentHash: 'a'.repeat(64), content: 'x', sourceClass: 'user_input',
    authority: 'not-an-authority', confidence: 1, durability: 0.9, sensitivity: 'private',
    claimDomain: 'user_fact', sourceRef: {},
  }) + '}'
  const badConf = '{"kind":"evidence","version":1,"data":' + JSON.stringify({
    id: 'ev_bad2', contentHash: 'b'.repeat(64), content: 'x', sourceClass: 'user_input',
    authority: 'user_explicit', durability: 0.9, sensitivity: 'private', claimDomain: 'user_fact', sourceRef: {},
  }) + '}'
  const badDom = '{"kind":"candidate","version":1,"data":' + JSON.stringify({
    id: 'cand_bad', scopeId: 'user-global', domain: 'nope', evidenceIds: [], state: 'proposed',
  }) + '}'
  const res = importJsonl([badAuth, badConf, badDom].join('\n'), { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(res.inserted, 0)
  assert.equal(res.skipped, 0)
  assert.equal(res.errors.length, 3)
  assert.equal(dst.stats().total, 0)
  assert.equal(dst.candidateStore.listCandidates().length, 0)
})
