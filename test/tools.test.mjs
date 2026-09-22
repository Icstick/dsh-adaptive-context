// test/tools.test.mjs — S1 P1 acp_query 测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { createAcpService } from '../src/service.mjs'
import { queryLedgerForTool, buildAcpQueryToolSpec } from '../src/tools.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-tools-'))
  const ledger = openEvidenceLedger({ dir })
  const acp = createAcpService({ ledger, startupRebuild: false })
  return { dir, ledger, acp }
}

const BASE = {
  sourceClass: 'user_input', sensitivity: 'public', confidence: 0.9, durability: 0.5,
  observedAt: new Date().toISOString(),
}

test('acp_query：无 query 返回最近 evidence（active 默认）', () => {
  const { ledger } = makeEnv()
  ledger.append({ ...BASE, observedAt: '2026-09-04T00:00:00.000Z', authority: 'user_explicit', claimDomain: 'user_fact', content: '用户偏好深色主题' })
  ledger.append({ ...BASE, observedAt: '2026-09-04T00:00:02.000Z', authority: 'user_explicit', claimDomain: 'user_fact', content: '用户常用 TypeScript' })
  const r = queryLedgerForTool({ ledger }, {})
  assert.equal(r.ok, true)
  assert.equal(r.evidence.length, 2)
  assert.ok(r.evidence[0].content.includes('TypeScript'))
})

test('acp_query：domain / authority 过滤生效', () => {
  const { ledger } = makeEnv()
  ledger.append({ ...BASE, authority: 'user_explicit', claimDomain: 'user_fact', content: '喜欢深色主题' })
  ledger.append({ ...BASE, sourceClass: 'user_correction', authority: 'user_correction', claimDomain: 'style', content: '回复不要用客服腔' })
  const byDomain = queryLedgerForTool({ ledger }, { domain: 'style' })
  assert.equal(byDomain.evidence.length, 1)
  assert.equal(byDomain.evidence[0].domain, 'style')
  const byAuth = queryLedgerForTool({ ledger }, { authority: 'user_correction' })
  assert.equal(byAuth.evidence.length, 1)
  assert.equal(byAuth.evidence[0].authority, 'user_correction')
})

test('acp_query：superseded 默认不可见，state=all 可见', () => {
  const { ledger } = makeEnv()
  ledger.append({ ...BASE, authority: 'user_explicit', claimDomain: 'user_fact', content: '旧结论 A' })
  ledger.append({ ...BASE, sourceClass: 'user_correction', authority: 'user_correction', claimDomain: 'user_fact', content: '新结论 B', state: 'superseded' })
  const active = queryLedgerForTool({ ledger }, {})
  assert.ok(active.evidence.every((e) => e.state === 'active'))
  const all = queryLedgerForTool({ ledger }, { state: 'all' })
  assert.equal(all.evidence.length, 2)
})

test('acp_query：observation 返回与开关', () => {
  const { ledger } = makeEnv()
  ledger.append({ ...BASE, sourceClass: 'agent_authored', authority: 'agent_inference', claimDomain: 'experience', content: '证据 1' })
  const up = ledger.upsertObservation({ subject: 'python', predicate: 'prefers', claimDomain: 'user_fact', text: '偏好类型标注', evidenceIds: [] })
  assert.equal(up.inserted, true)
  const r = queryLedgerForTool({ ledger }, {})
  assert.equal(r.observations.length, 1)
  assert.equal(r.observations[0].subject, 'python')
  const noObs = queryLedgerForTool({ ledger }, { includeObservation: false })
  assert.equal(noObs.observations.length, 0)
})

test('acp_query：content 截断与 limit 生效', () => {
  const { ledger } = makeEnv()
  for (let i = 0; i < 5; i++) {
    ledger.append({ ...BASE, sourceClass: 'agent_authored', authority: 'agent_inference', claimDomain: 'experience', content: '长内容 '.repeat(80) + '#' + i })
  }
  const r = queryLedgerForTool({ ledger }, { limit: 3 })
  assert.equal(r.evidence.length, 3)
  assert.ok(r.evidence[0].content.includes('…['))
})

test('acp_query：service recall 路径（readGuard）', () => {
  const { ledger } = makeEnv()
  ledger.append({ ...BASE, authority: 'user_explicit', claimDomain: 'user_fact', content: '用户偏好伏特加口味' })
  const r = queryLedgerForTool({ ledger }, { query: '伏特加' })
  assert.equal(r.evidence.length, 1)
})

test('buildAcpQueryToolSpec：rc.1 形状 + execute + 读审计', async () => {
  const { ledger } = makeEnv()
  ledger.append({ ...BASE, authority: 'user_explicit', claimDomain: 'user_fact', content: '审计测试内容' })
  const tool = buildAcpQueryToolSpec({ ledger, auditStore: ledger.auditStore, scopeId: 'user-global' })
  assert.equal(tool.name, 'acp_query')
  assert.ok(tool.parameters && tool.output && typeof tool.execute === 'function')
  const res = await tool.execute({ query: '审计测试' }, {})
  assert.equal(res.ok, true)
  assert.equal(res.evidence.length, 1)
  const audit = ledger.auditStore.queryAudit({ op: 'model_query' })
  assert.ok(Array.isArray(audit.items) && audit.items.length >= 1, 'audit 应记录 model_query（枚举扩展后真落账）')
  assert.equal(audit.items[0].actor, 'model')
  assert.equal(audit.items[0].op, 'model_query')
})

// ---------------------------------------------------------------
// 2026-09-22（W 机账本审计 §五）：observation 面回归。
// listObservations 是 created_at ASC 快照口径，工具面曾直接 slice →
// 永远返回最老的 N 条，最新蒸馏结论不可见。
// ---------------------------------------------------------------
test('acp_query：observation 按 observedAt 倒序（最新优先）', () => {
  const { ledger } = makeEnv()
  const base = { claimDomain: 'user_fact', evidenceIds: [] }
  ledger.upsertObservation({ ...base, subject: '旧', predicate: 'states', text: '最老的一条', observedAt: '2026-09-17T01:00:00.000Z' })
  ledger.upsertObservation({ ...base, subject: '中', predicate: 'states', text: '中间的一条', observedAt: '2026-09-20T01:00:00.000Z' })
  ledger.upsertObservation({ ...base, subject: '新', predicate: 'states', text: '最新的一条', observedAt: '2026-09-22T01:00:00.000Z' })

  const all = queryLedgerForTool({ ledger }, {})
  assert.equal(all.observations.length, 3)
  assert.deepEqual(all.observations.map((o) => o.subject), ['新', '中', '旧'])

  // limit 截断必须留下最新的一条，而不是最老的一条（旧行为的直接反例）
  const one = queryLedgerForTool({ ledger }, { limit: 1 })
  assert.equal(one.observations.length, 1)
  assert.equal(one.observations[0].subject, '新')
})

test('acp_query：同 observedAt 时 observation 顺序确定（按 id 兜底）', () => {
  const { ledger } = makeEnv()
  const at = '2026-09-22T02:00:00.000Z'
  const base = { claimDomain: 'work', evidenceIds: [], observedAt: at }
  ledger.upsertObservation({ ...base, subject: 'A', predicate: 'states', text: 'A 条' })
  ledger.upsertObservation({ ...base, subject: 'B', predicate: 'states', text: 'B 条' })
  const first = queryLedgerForTool({ ledger }, {}).observations.map((o) => o.id)
  const second = queryLedgerForTool({ ledger }, {}).observations.map((o) => o.id)
  assert.deepEqual(first, second, '两次查询顺序应稳定')
  assert.deepEqual(first, [...first].sort((x, y) => y.localeCompare(x)), '同 observedAt 时按 id 倒序兜底')
})

