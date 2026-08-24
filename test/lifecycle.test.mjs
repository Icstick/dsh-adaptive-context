// test/lifecycle.test.mjs — lifecycle.mjs 验收测试（state 迁移 + getLineage 回溯）
// 运行：node test/lifecycle.test.mjs（不要用 node --test，DSH 沙箱拦 runner 的 spawn）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { supersede, quarantine, redact, rollback, getLineage, LifecycleError } from '../src/lifecycle.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-lifecycle-'))
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
    ...overrides,
  }
}

test('supersede：user_correction 新证据可 supersede 旧证据，旧证据 state 变 superseded', (t) => {
  const ledger = freshLedger(t)
  const old = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  const nu = ledger.append(baseEv({
    sourceClass: 'user_correction',
    authority: 'user_correction',
    content: '更正：项目 package manager 一律用 yarn',
    sourceRef: { sessionEventId: 'b' },
  }))
  supersede(old.id, nu.id, { ledger })

  const a = ledger.getById(old.id)
  const b = ledger.getById(nu.id)
  assert.equal(a.state, 'superseded')
  assert.equal(b.state, 'active')
  // 新证据记录直接前驱（方案甲）
  assert.deepEqual(b.supersedes, [old.id])
  // append-only：两条都还在
  assert.equal(ledger.stats().total, 2)
})

test('supersede 拒绝：external_information 新证据不能 supersede（抛结构化 DENIED）', (t) => {
  const ledger = freshLedger(t)
  const old = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  const nu = ledger.append(baseEv({
    sourceClass: 'external_tool',
    authority: 'external_information',
    claimDomain: 'external_fact',
    content: '某博客称用户正在用 bun',
    sourceRef: { sessionEventId: 'b' },
  }))

  assert.throws(
    () => supersede(old.id, nu.id, { ledger }),
    (e) => e instanceof LifecycleError && e.code === 'DENIED',
  )
  // 拒绝后无任何变更
  assert.equal(ledger.getById(old.id).state, 'active')
  assert.deepEqual(ledger.getById(nu.id).supersedes, [])
})

test('getLineage：E1(pnpm)→E2(yarn)→E3(bun) 链返回 [E1,E2,E3]（按时间序）', (t) => {
  const ledger = freshLedger(t)
  const E1 = ledger.append(baseEv({ content: '用 pnpm', observedAt: '2026-08-25T00:00:00.000Z', sourceRef: { sessionEventId: 'e1' } }))
  const E2 = ledger.append(baseEv({ content: '用 yarn', observedAt: '2026-08-26T00:00:00.000Z', sourceRef: { sessionEventId: 'e2' } }))
  const E3 = ledger.append(baseEv({ content: '用 Bun', observedAt: '2026-08-27T00:00:00.000Z', sourceRef: { sessionEventId: 'e3' } }))

  supersede(E1.id, E2.id, { ledger })
  supersede(E2.id, E3.id, { ledger })

  assert.deepEqual(getLineage(E3.id, { ledger }), [E1.id, E2.id, E3.id])
  // 无前驱的证据 lineage 只含自己
  assert.deepEqual(getLineage(E1.id, { ledger }), [E1.id])
  // 链中间证据：从 E2 往回 = [E1, E2]
  assert.deepEqual(getLineage(E2.id, { ledger }), [E1.id, E2.id])
})

test('rollback：superseded 恢复 active、可再次被查询、替代关系撤销', (t) => {
  const ledger = freshLedger(t)
  const old = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  const nu = ledger.append(baseEv({
    sourceClass: 'user_correction',
    authority: 'user_correction',
    content: '更正：用 yarn',
    sourceRef: { sessionEventId: 'b' },
  }))
  supersede(old.id, nu.id, { ledger })
  assert.equal(ledger.getById(old.id).state, 'superseded')
  assert.deepEqual(ledger.getById(nu.id).supersedes, [old.id])

  rollback(old.id, { ledger })

  const back = ledger.getById(old.id)
  assert.equal(back.state, 'active')
  assert.equal(back.content, '项目 package manager 一律用 pnpm') // 可再次被查询，内容完整
  // 替代关系撤销：nu 不再声称替代 old
  assert.deepEqual(ledger.getById(nu.id).supersedes, [])
  // 恢复后 getLineage 不再把 old 挂在 nu 的链上
  assert.deepEqual(getLineage(nu.id, { ledger }), [nu.id])
})

test('quarantine：置 quarantined 且 reason 写入 metadata.reviewStatus', (t) => {
  const ledger = freshLedger(t)
  const ev = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  quarantine(ev.id, { ledger, reason: 'prompt-injection pattern detected' })

  const row = ledger.getById(ev.id)
  assert.equal(row.state, 'quarantined')
  assert.equal(row.metadata.reviewStatus, 'prompt-injection pattern detected')
  // 未提供的键不写
  assert.equal(row.metadata.ttlDays, undefined)
})

test('quarantine 保留已有 metadata 其他固定键', (t) => {
  const ledger = freshLedger(t)
  const ev = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' }, metadata: { sourceVersion: 'v0.1' } }))
  quarantine(ev.id, { ledger, reason: 'needs_review' })

  const row = ledger.getById(ev.id)
  assert.equal(row.state, 'quarantined')
  assert.equal(row.metadata.sourceVersion, 'v0.1') // 原键保留
  assert.equal(row.metadata.reviewStatus, 'needs_review')
})

test('redact：置 redacted，内容保留不删除', (t) => {
  const ledger = freshLedger(t)
  const ev = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  redact(ev.id, { ledger })

  const row = ledger.getById(ev.id)
  assert.equal(row.state, 'redacted')
  assert.equal(row.content, '项目 package manager 一律用 pnpm')
})

test('错误：supersede 不存在的证据 → NOT_FOUND', (t) => {
  const ledger = freshLedger(t)
  const nu = ledger.append(baseEv({ sourceRef: { sessionEventId: 'b' } }))
  assert.throws(
    () => supersede('ev_missing', nu.id, { ledger }),
    (e) => e instanceof LifecycleError && e.code === 'NOT_FOUND',
  )
})

test('错误：rollback active 证据 → INVALID_INPUT', (t) => {
  const ledger = freshLedger(t)
  const ev = ledger.append(baseEv({ sourceRef: { sessionEventId: 'a' } }))
  assert.throws(
    () => rollback(ev.id, { ledger }),
    (e) => e instanceof LifecycleError && e.code === 'INVALID_INPUT',
  )
})
