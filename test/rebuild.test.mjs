// test/rebuild.test.mjs — M3 C3：Materialized View 重建 / 校验验收测试。
// 运行：node test/rebuild.test.mjs（单文件直跑）
// 覆盖：重放一致性（promoted 筛选 + 稳定排序）/ 未构建视图 / checksum 失配恢复 /
//       篡改恢复 / 未知视图 / rebuild 确定性（同状态同 checksum）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { rebuildView, verifyView, VIEW_NAMES } from '../src/rebuild.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-rb-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

function deps(ledger) {
  return { ledger, candidateStore: ledger.candidateStore, auditStore: ledger.auditStore }
}

/** 造 3 个候选：1 promoted + 1 rejected + 1 rolled_back，返回各 id */
function seedCandidates(ledger) {
  const s = ledger.candidateStore
  const ok = s.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e1', 'e2'] })
  const no = s.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e3'] })
  const rb = s.createCandidate({ scopeId: 'workspace', domain: 'work', evidenceIds: ['e4'] })
  s.transitionCandidate(ok.id, 'promote', { reason: 'manual approval', actor: 'user' })
  s.transitionCandidate(no.id, 'reject', { reason: 'weak evidence', actor: 'agent' })
  s.transitionCandidate(rb.id, 'promote', { reason: 'ok', actor: 'user' })
  s.transitionCandidate(rb.id, 'rollback', { reason: 'user changed mind', actor: 'user' })
  return { ok, no, rb }
}

test('rebuildView expression：只物化 promoted 候选，内容与重放一致，checksum 存 meta', (t) => {
  const ledger = freshLedger(t)
  const { ok, no, rb } = seedCandidates(ledger)
  const r = rebuildView('expression', deps(ledger))
  assert.equal(r.ok, true)
  assert.equal(typeof r.checksum, 'string')
  assert.equal(r.checksum.length, 64)

  // 物化产物（meta）只含 promoted：ok 在，no（rejected）/ rb（rolled_back）不在
  const content = JSON.parse(ledger.getMeta('view:expression'))
  assert.equal(content.length, 1)
  assert.equal(content[0].id, ok.id)
  assert.equal(content[0].domain, 'style')
  assert.deepEqual(content[0].evidenceIds, ['e1', 'e2'])
  assert.equal(content[0].decisionReason, 'manual approval')
  // 存储 checksum 与产物一致
  assert.equal(ledger.getMeta('view:expression:checksum'), r.checksum)
  void no; void rb
})

test('verifyView：rebuild 后通过；未构建时 ok:false', (t) => {
  const ledger = freshLedger(t)
  // 未构建
  const before = verifyView('expression', deps(ledger))
  assert.equal(before.ok, false)
  assert.equal(before.checksum, null)
  // 构建后通过
  seedCandidates(ledger)
  rebuildView('expression', deps(ledger))
  const v = verifyView('expression', deps(ledger))
  assert.equal(v.ok, true)
  assert.equal(typeof v.checksum, 'string')
  assert.equal(v.checksum, ledger.getMeta('view:expression:checksum'))
})

test('重放一致性：candidate 事件变化后 verify 失配 → rebuild → 恢复通过', (t) => {
  const ledger = freshLedger(t)
  const { ok } = seedCandidates(ledger)
  rebuildView('expression', deps(ledger))
  assert.equal(verifyView('expression', deps(ledger)).ok, true)

  // 新 promote 一个候选（未经 rebuild）：重放内容变化 → checksum 陈旧
  const extra = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: ['e9'] })
  ledger.candidateStore.transitionCandidate(extra.id, 'promote', { reason: 'later', actor: 'user' })
  const stale = verifyView('expression', deps(ledger))
  assert.equal(stale.ok, false)
  assert.ok(stale.reason.includes('stale'))

  // 重建恢复
  const rb = rebuildView('expression', deps(ledger))
  assert.equal(rb.ok, true)
  assert.equal(verifyView('expression', deps(ledger)).ok, true)
  const content = JSON.parse(ledger.getMeta('view:expression'))
  assert.equal(content.length, 2)
  assert.ok(content.some((c) => c.id === ok.id))
  assert.ok(content.some((c) => c.id === extra.id))
})

test('篡改恢复：物化产物被改 → verify 失配 → rebuild → 恢复通过', (t) => {
  const ledger = freshLedger(t)
  seedCandidates(ledger)
  rebuildView('expression', deps(ledger))
  assert.equal(verifyView('expression', deps(ledger)).ok, true)

  // 篡改物化产物（checksum 不动）
  ledger.setMeta('view:expression', '[{"id":"cand_tampered"}]')
  const tampered = verifyView('expression', deps(ledger))
  assert.equal(tampered.ok, false)
  assert.ok(tampered.reason.includes('tampered'))

  const rb = rebuildView('expression', deps(ledger))
  assert.equal(rb.ok, true)
  const v = verifyView('expression', deps(ledger))
  assert.equal(v.ok, true)
  const content = JSON.parse(ledger.getMeta('view:expression'))
  assert.equal(content.length, 1) // 恢复为真相源内容
  assert.equal(content[0].decisionReason, 'manual approval')
})

test('rebuild 确定性：同状态重复 rebuild 得相同 checksum；空视图（无 promoted）也确定', (t) => {
  const ledger = freshLedger(t)
  seedCandidates(ledger)
  const r1 = rebuildView('expression', deps(ledger))
  const r2 = rebuildView('expression', deps(ledger))
  assert.equal(r1.checksum, r2.checksum)
  assert.equal(verifyView('expression', deps(ledger)).ok, true)

  // 空库：无候选 → 视图为空数组，checksum 确定
  const empty = freshLedger(t)
  const e1 = rebuildView('expression', deps(empty))
  const e2 = rebuildView('expression', deps(empty))
  assert.equal(e1.ok, true)
  assert.equal(e1.checksum, e2.checksum)
  assert.equal(empty.getMeta('view:expression'), '[]')
  assert.equal(verifyView('expression', deps(empty)).ok, true)
})

test('未知视图 / 缺依赖：ok:false 且 reason 明确，不抛异常', (t) => {
  const ledger = freshLedger(t)
  assert.equal(rebuildView('nope', deps(ledger)).ok, false)
  assert.equal(verifyView('nope', deps(ledger)).ok, false)
  assert.equal(rebuildView('expression', {}).ok, false)
  assert.equal(verifyView('expression', { ledger }).ok, false)
  assert.equal(rebuildView('expression', { candidateStore: ledger.candidateStore }).ok, false)
  assert.deepEqual(VIEW_NAMES, ['expression'])
})
