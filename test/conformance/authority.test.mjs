// test/conformance/authority.test.mjs — 契约测试：authority 一致性 + metadata 键集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../../src/store.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-auth-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

const base = (over = {}) => ({
  sourceClass: 'user_input', authority: 'user_explicit',
  confidence: 1, durability: 0.9, sensitivity: 'private',
  claimDomain: 'user_fact', content: 'x', sourceRef: { sessionEventId: 'a' },
  ...over,
})

test('矛盾组合拒绝：external_tool + user_explicit', (t) => {
  const ledger = fresh(t)
  assert.throws(() => ledger.append(base({
    sourceClass: 'external_tool', authority: 'user_explicit',
  })), /inconsistent with sourceClass/)
})

test('metadata 未知键拒绝', (t) => {
  const ledger = fresh(t)
  assert.throws(() => ledger.append(base({ metadata: { evil: 'x' } })), /not allowed/)
})

test('metadata 固定键放行', (t) => {
  const ledger = fresh(t)
  const r = ledger.append(base({ metadata: { ttlDays: 30, reviewStatus: 'needs_review', scenarioTags: ['test'], sourceVersion: '0.1' } }))
  assert.equal(r.inserted, true)
  const row = ledger.getById(r.id)
  assert.deepEqual(row.metadata, { ttlDays: 30, reviewStatus: 'needs_review', scenarioTags: ['test'], sourceVersion: '0.1' })
})

test('agent_authored 子规则映射合法', (t) => {
  const ledger = fresh(t)
  const r = ledger.append(base({
    sourceClass: 'agent_authored', authority: 'single_observation', claimDomain: 'experience',
  }))
  assert.equal(r.inserted, true)
})
