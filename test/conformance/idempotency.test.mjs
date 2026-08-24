// test/conformance/idempotency.test.mjs — 契约测试：Evidence 幂等
// KPI：重放后重复 Evidence = 0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../../src/store.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-conf-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

const ev = (over = {}) => ({
  sourceClass: 'user_input', authority: 'user_explicit',
  confidence: 1, durability: 0.9, sensitivity: 'private',
  claimDomain: 'user_fact',
  content: '重放测试内容',
  sourceRef: { sessionEventId: 'evt-1' },
  ...over,
})

test('重放 3 次 = 1 条（KPI: 重复 Evidence 0）', (t) => {
  const ledger = fresh(t)
  const results = [1, 2, 3].map(() => ledger.append(ev()))
  assert.deepEqual(results.map(r => r.inserted), [true, false, false])
  assert.equal(ledger.stats().total, 1)
})

test('不同会话事件但相同内容 = 独立证据（不是误去重）', (t) => {
  const ledger = fresh(t)
  const a = ledger.append(ev({ sourceRef: { sessionEventId: 'a' } }))
  const b = ledger.append(ev({ sourceRef: { sessionEventId: 'b' } }))
  assert.equal(a.inserted, true); assert.equal(b.inserted, true)
  assert.notEqual(a.id, b.id)
})
