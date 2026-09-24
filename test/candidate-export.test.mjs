// test/candidate-export.test.mjs — 候选只读导出（4.3 · ACP-B18，2026-09-24）
// 验收目标：格式正确、**只读**（导出前后账本计数不变）、幂等、空表安全、不带正文。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { parseArgs, toExportRecord, buildExport } from '../scripts/candidate-export.mjs'

test('parseArgs：默认 state=proposed / limit=200；--out 与 --json 识别', () => {
  const a = parseArgs([])
  assert.equal(a.state, 'proposed')
  assert.equal(a.limit, 200)
  assert.equal(a.out, '')
  assert.equal(a.json, false)
  const b = parseArgs(['--state', 'approved', '--limit', '5', '--out', 'x.jsonl', '--json'])
  assert.equal(b.state, 'approved')
  assert.equal(b.limit, 5)
  assert.equal(b.out, 'x.jsonl')
  assert.equal(b.json, true)
})

test('toExportRecord：字段齐全 + hint 前缀为 [acp:<id>] + 不携带任何正文', () => {
  const r = toExportRecord({
    id: 'cand_ab12', domain: 'work', state: 'proposed',
    evidenceIds: ['e1', 'e2'], createdAt: 1, updatedAt: 2, policy: null,
  })
  assert.equal(r.id, 'cand_ab12')
  assert.equal(r.evidenceCount, 2)
  assert.deepEqual(r.evidenceIds, ['e1', 'e2'])
  assert.equal(r.hint, '[acp:cand_ab12] work · 证据 2 条 · proposed')
  assert.equal(r.state, 'proposed')
  for (const k of ['text', 'body', 'summary', 'content']) {
    assert.ok(!(k in r), '不得携带正文类字段: ' + k)
  }
})

test('toExportRecord：evidenceIds 缺失 / 非数组 / null 时安全降级为 []', () => {
  assert.deepEqual(toExportRecord({ id: 'c', domain: 'work' }).evidenceIds, [])
  assert.deepEqual(toExportRecord({ id: 'c', domain: 'work', evidenceIds: null }).evidenceIds, [])
  assert.deepEqual(toExportRecord({ id: 'c', domain: 'work', evidenceIds: 'e1,e2' }).evidenceIds, [])
  assert.equal(toExportRecord({ id: 'c', domain: 'work' }).state, 'proposed')
})

test('buildExport：非数组输入返回空数组（空表 / 空候选池安全）', () => {
  assert.deepEqual(buildExport(undefined), [])
  assert.deepEqual(buildExport(null), [])
  assert.deepEqual(buildExport([]), [])
})

test('端到端：导出真实候选 —— 只读（计数不变）+ 幂等 + id 可回指', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-candexp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = openEvidenceLedger({ dir })
  const c1 = ledger.candidateStore.createCandidate({ domain: 'work', evidenceIds: ['e1', 'e2'] })
  const c2 = ledger.candidateStore.createCandidate({ domain: 'external_fact', evidenceIds: ['e3'] })

  const before = ledger.candidateStore.replayCandidates().size
  const rows = ledger.candidateStore.listCandidates({ state: 'proposed', limit: 50 })
  const recs = buildExport(rows)

  assert.equal(recs.length, 2)
  assert.deepEqual(recs.map((r) => r.id).sort(), [c1.id, c2.id].sort())
  assert.ok(recs.every((r) => r.evidenceCount === 2 || r.evidenceCount === 1))

  // 幂等：同一批行再转一次，逐字节相同（对应 §7 验收「重复拉取 N 次条数不变」的 ACP 侧那一半）
  assert.equal(JSON.stringify(buildExport(rows)), JSON.stringify(recs))

  // 只读：导出路径不产生任何写入 —— 行数、事件重放结果都不变
  assert.equal(ledger.candidateStore.replayCandidates().size, before)
  assert.equal(ledger.candidateStore.listCandidates({ limit: 50 }).length, 2)
  ledger.close()
})

test('只读再确认：导出后 candidate_events 不增（append-only 未被触碰）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-candexp2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = openEvidenceLedger({ dir })
  ledger.candidateStore.createCandidate({ domain: 'work', evidenceIds: ['e1'] })
  const n1 = ledger.candidateStore.replayCandidates().size
  const a = buildExport(ledger.candidateStore.listCandidates({ limit: 50 }))
  const b = buildExport(ledger.candidateStore.listCandidates({ limit: 50 }))
  assert.equal(ledger.candidateStore.replayCandidates().size, n1)
  assert.deepEqual(a, b)
  ledger.close()
})
