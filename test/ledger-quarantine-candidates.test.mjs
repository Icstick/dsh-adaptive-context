// test/ledger-quarantine-candidates.test.mjs — 存量隔离候选清单（只读，2026-09-22）
// 验收目标：分层互斥、判定可复现、溯源链进 KEEP、模拟计数对得上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  classify, parseArgs, simulate, TIER_LABELS,
} from '../scripts/ledger-quarantine-candidates.mjs'

const EV = {
  sensitivity: 'private', confidence: 0.5, durability: 0.5,
  observedAt: '2026-09-22T00:00:00.000Z',
}
const AGENT = { ...EV, sourceClass: 'agent_authored', authority: 'single_observation', claimDomain: 'experience' }
const USER = { ...EV, sourceClass: 'user_input', authority: 'user_explicit', claimDomain: 'user_fact' }

function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-qc-'))
  return openEvidenceLedger({ dir })
}

function seed(ledger) {
  ledger.append({ ...AGENT, content: 'You are the background skill reviewer. Review the window', sourceRef: { sessionEventId: 'session-a:1' } })
  ledger.append({ ...AGENT, content: '【maid 压缩归档】## Primary Request and Intent', sourceRef: { sessionEventId: 'session-a:2' } })
  ledger.append({ ...AGENT, content: 'Background subagent abc finished', sourceRef: { sessionEventId: 'session-a:3' } })
  ledger.append({ ...AGENT, content: 'I will gather evidence from the workspace', sourceRef: { sessionEventId: 'sub-1:1' } })
  ledger.append({ ...AGENT, content: '检查完了。先给结论，再给依据。', sourceRef: { sessionEventId: 'session-a:4' } })
  // T4：同内容两条（第一条留 KEEP，第二条进 T4）
  ledger.append({ ...USER, content: '这是一条足够长的重复内容', sourceRef: { sessionEventId: 'session-a:5' } })
  ledger.append({ ...USER, content: '这是一条足够长的重复内容', sourceRef: { sessionEventId: 'session-a:6' } })
  // T5：极短用户消息
  ledger.append({ ...USER, content: '继续', sourceRef: { sessionEventId: 'session-a:7' } })
  // 溯源链：被 active observation 引用 → 必须进 KEEP
  const kept = ledger.append({ ...USER, content: '默认用 pnpm 这个约定', sourceRef: { sessionEventId: 'session-a:8' } })
  ledger.upsertObservation({
    scopeId: 'user-global', subject: '包管理', predicate: '使用',
    claimDomain: 'user_fact', text: '默认用 pnpm', evidenceIds: [kept.id],
  })
  return kept.id
}

test('parseArgs：缺省 / --dir / --out / --short-chars', () => {
  const d = parseArgs([])
  assert.ok(d.dir.endsWith('acp'))
  assert.equal(d.out, '')
  assert.equal(d.shortChars, 15)
  const a = parseArgs(['--dir', 'X:/l', '--out', 'X:/o', '--short-chars', '20'])
  assert.equal(a.dir, 'X:/l')
  assert.equal(a.out, 'X:/o')
  assert.equal(a.shortChars, 20)
})

test('classify：分层互斥，T1 优先于会话判定', () => {
  const ledger = makeLedger()
  seed(ledger)
  const rep = classify(ledger.db)

  assert.equal(rep.total, 9)
  assert.equal(rep.tiers.T1a.length, 1)
  assert.equal(rep.tiers.T1b.length, 1)
  assert.equal(rep.tiers.T1c.length, 1)
  assert.equal(rep.tiers.T2.length, 1, '裸 uuid 会话的独白')
  assert.equal(rep.tiers.T3.length, 1, 'session- 前缀会话的模型自述')
  assert.equal(rep.tiers.T4.length, 1, '重复内容的第 2 条')
  assert.equal(rep.tiers.T5.length, 1, '极短用户消息')
  assert.equal(rep.tiers.KEEP.length, 2, '重复首条 + 溯源链')

  // 分层互斥：候选总数 = 各行之和，且与 KEEP 不重叠
  const ids = Object.entries(rep.tiers).flatMap(([, rows]) => rows.map((r) => r.id))
  assert.equal(new Set(ids).size, rep.total, '每行恰好归一层')
  assert.equal(rep.candidates, 7)
})

test('classify：被 active observation 引用的证据进 KEEP（不动溯源链）', () => {
  const ledger = makeLedger()
  const keptId = seed(ledger)
  const rep = classify(ledger.db)
  assert.ok(rep.tiers.KEEP.some((r) => r.id === keptId), '溯源链上的证据不得进候选')
  assert.ok(!Object.entries(rep.tiers).some(([k, rows]) => k !== 'KEEP' && rows.some((r) => r.id === keptId)))
  assert.equal(rep.protectedCount, 1)
})

test('simulate：按层累计隔离，保留数与域分布对得上', () => {
  const ledger = makeLedger()
  seed(ledger)
  const rep = classify(ledger.db)
  const a = simulate(ledger.db, rep.tiers, ['T1a', 'T1b', 'T1c'])
  assert.equal(a.quarantined, 3)
  assert.equal(a.kept, 6)
  const d = simulate(ledger.db, rep.tiers, ['T1a', 'T1b', 'T1c', 'T2', 'T3', 'T4', 'T5'])
  assert.equal(d.quarantined, 7)
  assert.equal(d.kept, 2)
  assert.equal(d.byDomain.user_fact, 2)
})

test('TIER_LABELS 覆盖全部候选层', () => {
  const ledger = makeLedger()
  seed(ledger)
  const rep = classify(ledger.db)
  for (const k of Object.keys(rep.tiers)) {
    if (k === 'KEEP') continue
    assert.ok(TIER_LABELS[k], '缺少标签: ' + k)
  }
})
