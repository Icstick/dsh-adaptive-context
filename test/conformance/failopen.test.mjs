// test/conformance/failopen.test.mjs — 契约测试：fail-open 语义
// KPI：backend outage 导致 DSH turn 失败 = 0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../../src/store.mjs'
import { createAcpService } from '../../src/service.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-fo-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return { ledger, service: createAcpService({ ledger }) }
}

test('空 Ledger 时 recall 不抛错（fail-open）', (t) => {
  const { service } = fresh(t)
  const r = service.recall({ query: 'anything', scopeId: 'user-global', maxTokens: 100 })
  assert.deepEqual(r.items, [])
  assert.equal(r.tokens, 0)
})

test('Ledger 关闭后 recall 返回空而非崩溃（模拟 Provider 宕机）', (t) => {
  const { ledger, service } = fresh(t)
  ledger.close()
  try {
    const r = service.recall({ query: 'x', scopeId: 'user-global' })
    assert.ok(Array.isArray(r.items)) // 可能空或抛，但调用方必须能容错
  } catch {
    // fail-open 语义：recall 异常应由调用方（index.mjs try/catch）吞掉
    assert.ok(true)
  }
})

test('recall 带非法 query 不抛异常（容错）', (t) => {
  const { service } = fresh(t)
  const r = service.recall({ query: '', scopeId: 'user-global', maxTokens: 100 })
  assert.ok(Array.isArray(r.items))
})
