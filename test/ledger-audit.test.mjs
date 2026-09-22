// test/ledger-audit.test.mjs — 只读账本体检（scripts/ledger-audit.mjs）
// 验收目标：口径正确（机器消息分类 / 蒸馏跳过 / 召回窗 / 归段）+ 缺省参数可用。
// 守护点：本脚本是**只读**的——测试里不做任何断言之外的写入，且 auditLedger 只收 db 句柄。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { auditLedger, render, parseArgs, PRODUCTION_QUOTA } from '../scripts/ledger-audit.mjs'

function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-audit-'))
  return { dir, ledger: openEvidenceLedger({ dir }) }
}

const EV = {
  sensitivity: 'private', confidence: 0.5, durability: 0.5,
  observedAt: '2026-09-22T00:00:00.000Z',
}

function seed(ledger) {
  // 真实用户消息（可蒸馏、可注入）
  ledger.append({ ...EV, sourceClass: 'user_input', authority: 'user_explicit', claimDomain: 'user_fact', content: '先完整看代码详细调研一下' })
  // 三类机器消息
  ledger.append({ ...EV, sourceClass: 'agent_authored', authority: 'single_observation', claimDomain: 'experience', content: '【maid 压缩归档】摘要正文' })
  ledger.append({ ...EV, sourceClass: 'agent_authored', authority: 'agent_inference', claimDomain: 'experience', content: 'You are the background skill reviewer. Review the conversation window' })
  ledger.append({ ...EV, sourceClass: 'agent_authored', authority: 'single_observation', claimDomain: 'experience', content: '85 rules / 72 check types，全绿。' })
  ledger.setMeta('consolidation_watermark_ts', '2026-01-01T00:00:00.000Z')
}

test('parseArgs：缺省 / --dir / --quota 合并 / --json', () => {
  const d = parseArgs([])
  assert.equal(d.recall, 20)
  assert.equal(d.json, false)
  assert.deepEqual(d.quota, PRODUCTION_QUOTA)

  const a = parseArgs(['--dir', 'X:/ledger', '--json', '--recall', '5', '--quota', '{"memory":999}'])
  assert.equal(a.dir, 'X:/ledger')
  assert.equal(a.json, true)
  assert.equal(a.recall, 5)
  assert.equal(a.quota.memory, 999)
  assert.equal(a.quota.user_model, PRODUCTION_QUOTA.user_model, '未覆盖的键保持生产缺省')

  // 非法 quota JSON 不炸，回落生产缺省
  assert.deepEqual(parseArgs(['--quota', '{oops']).quota, PRODUCTION_QUOTA)
})

test('auditLedger：规模 / 机器消息分类 / 可注入性', () => {
  const { ledger } = makeLedger()
  seed(ledger)
  const rep = auditLedger(ledger.db, parseArgs([]))

  assert.equal(rep.scale.total, 4)
  assert.equal(rep.scale.active, 4)

  const byKey = Object.fromEntries(rep.machine.map((m) => [m.key, m]))
  assert.equal(byKey['skill-reviewer'].n, 1)
  assert.equal(byKey['skill-reviewer'].injectable, false, 'agent_inference 过不了读矩阵')
  assert.equal(byKey['maid-archive'].n, 1)
  assert.equal(byKey['maid-archive'].injectable, true, 'single_observation/experience 可注入')
  assert.equal(byKey['bg-subagent'].n, 0)
})

test('auditLedger：蒸馏队列按 skip 过滤（agent_authored + experience 永久跳过）', () => {
  const { ledger } = makeLedger()
  seed(ledger)
  const rep = auditLedger(ledger.db, parseArgs([]))

  assert.equal(rep.distill.watermark, '2026-01-01T00:00:00.000Z')
  assert.equal(rep.distill.skippedTotal, 3, '三条机器消息全部是 agent_authored + experience')
  assert.equal(rep.distill.queue, 1, '只有真实用户消息进队列')
})

test('auditLedger：召回窗 + 注入分档（读矩阵过滤后归段）', () => {
  const { ledger } = makeLedger()
  seed(ledger)
  ledger.upsertObservation({ scopeId: 'user-global', subject: '用户', predicate: '偏好', claimDomain: 'user_preference', text: '偏好简单直观的展示', evidenceIds: [] })

  const rep = auditLedger(ledger.db, parseArgs([]))
  assert.equal(rep.injection.pool, 4)
  assert.equal(rep.injection.eligible, 3, 'agent_inference 一条被读矩阵挡掉')
  assert.equal(rep.injection.afterContentDedup, 3)

  const sec = Object.fromEntries(rep.injection.sections.map((s) => [s.section, s]))
  assert.equal(sec.user_model.n, 1)
  assert.equal(sec.memory.n, 2)
  assert.equal(sec.memory.quota, PRODUCTION_QUOTA.memory)
  assert.equal(rep.observation.byState.find((o) => o.state === 'active').n, 1)
})

test('render：产出人可读摘要且含关键段', () => {
  const { ledger } = makeLedger()
  seed(ledger)
  const text = render(auditLedger(ledger.db, parseArgs([])))
  for (const head of ['=== ACP 账本体检（只读） ===', '[规模]', '[摄入面]', '[蒸馏]', '[召回窗]', '[注入分档]', '[observation]', '[候选池]', '[冷存清单]']) {
    assert.ok(text.includes(head), '缺少段落 ' + head)
  }
  assert.ok(text.includes('background skill reviewer'))
})

test('候选池一节：schema v7 有池时报状态/域/可导出域/跑批台账', (t) => {
  const { ledger } = makeLedger()
  t.after(() => ledger.close())
  ledger.upsertCandidateMemory({ id: 'cm_w', claimDomain: 'work', subject: 's1', text: 'a', evidenceIds: ['e1'], occurrences: 2 })
  ledger.upsertCandidateMemory({ id: 'cm_p', claimDomain: 'user_preference', subject: 's2', text: 'b', evidenceIds: ['e2'], occurrences: 1, state: 'approved' })
  ledger.upsertCandidateMemory({ id: 'cm_f', claimDomain: 'external_fact', subject: 's3', text: 'c', evidenceIds: ['e3'], occurrences: 1, state: 'approved' })
  ledger.recordDreamRun({ scanned: 3, clustered: 3, promoted: 1, archived: 0, note: 't' })

  const rep = auditLedger(ledger.db, parseArgs([]))
  assert.equal(rep.dream.hasPool, true)
  assert.deepEqual(rep.dream.byState.map((x) => x.state).sort(), ['approved', 'candidate'])
  assert.equal(rep.dream.exportable.n, 2, 'work + external_fact')
  assert.equal(rep.dream.approvedExportable.n, 1, '画像域那条不算可导出')
  assert.equal(rep.dream.multiMember.n, 1)
  assert.equal(rep.dream.runs.length, 1)
})

test('候选池一节：旧库（无 candidate_memory）如实报「无」而不是崩', (t) => {
  const { ledger } = makeLedger()
  t.after(() => ledger.close())
  ledger.db.exec('DROP TABLE candidate_memory')
  const rep = auditLedger(ledger.db, parseArgs([]))
  assert.equal(rep.dream.hasPool, false)
  assert.ok(render(rep).includes('没有 candidate_memory'))
})

test('冷存一节：复用 planArchival 的判据（不另写一套阈值）', (t) => {
  const { ledger } = makeLedger()
  t.after(() => ledger.close())
  const rep = auditLedger(ledger.db, parseArgs([]))
  assert.equal(rep.coldStore.stats.ttlDays, 90)
  assert.equal(rep.coldStore.stats.staleObservations, 0)
  assert.equal(rep.coldStore.stats.staleEvidence, 0)
})
