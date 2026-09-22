// test/dream.test.mjs — Dreaming 第一增量：归并 / 复现计数 / 遗忘（2026-09-22）
// 验收目标：判定确定性可复现、dry-run 零写入、重跑不覆盖人的决定、绝不写 observation。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  normalizeForCluster, bigramSet, similarity, clusterObservations,
  occurrenceStats, decideState, candidateMemoryIdOf, planArchival, runDream,
} from '../src/dream.mjs'
import { parseArgs, readRows, applyPlan } from '../scripts/dream.mjs'

const OBS = (over = {}) => ({
  id: 'o1', scopeId: 'user-global', state: 'active', subject: '分支管理', predicate: '偏好',
  claimDomain: 'user_preference', text: '倾向将分支都合并到main只保留main',
  evidenceIds: ['e1'], observedAt: '2026-09-20T00:00:00.000Z', createdAt: Date.parse('2026-09-20'),
  ...over,
})
const EV = (id, sessionId, observedAt, over = {}) => ({
  id, state: 'active', sessionId, observedAt, createdAt: Date.parse(observedAt), updatedAt: Date.parse(observedAt), ...over,
})

test('normalizeForCluster / bigramSet：标点与空白不参与比较', () => {
  assert.equal(normalizeForCluster(' 分支，管理。 '), '分支管理')
  assert.equal(bigramSet('分支').size, 1)
  assert.ok(bigramSet('分支管理').has('分支'))
  assert.equal(bigramSet('').size, 0)
})

test('similarity + clusterObservations：同 subject 归簇；近似文本归簇；不同域不归簇', () => {
  const a = OBS({ id: 'o1' })
  const b = OBS({ id: 'o2', text: '倾向把分支合并到 main 只留 main' })   // 措辞近
  const c = OBS({ id: 'o3', subject: '展示偏好', claimDomain: 'style', text: '偏好简单直观的展示' })
  const d = OBS({ id: 'o4', subject: '装机', claimDomain: 'work', text: '装机相关问题暂缓处理' })
  const clusters = clusterObservations([a, b, c, d])
  assert.equal(clusters.length, 3, 'a+b 同簇，c、d 各自成簇')
  const merged = clusters.find((x) => x.observationIds.length === 2)
  assert.deepEqual(merged.observationIds, ['o1', 'o2'])
  assert.deepEqual(merged.evidenceIds, ['e1'])
  assert.equal(similarity('分支管理', '分支管理'), 1)
  assert.ok(similarity('分支管理', '装机问题') < 0.3)
})

test('clusterObservations：subject 不同但文本近似 → 走 Jaccard 路径也要归簇', () => {
  // 这正是缺口①的实战形态：同键的早就 supersede 了，留下的是「同一个意思、键不同」的孤岛
  const a = OBS({ id: 'o1', subject: '甲', predicate: 'p1', text: '倾向将分支都合并到main只保留main' })
  const b = OBS({ id: 'o2', subject: '乙', predicate: 'p2', text: '倾向将分支都合并到main只保留main啦' })
  const clusters = clusterObservations([a, b])
  assert.equal(clusters.length, 1, 'subject 不同但文本几乎相同，必须归簇')
  assert.equal(clusters[0].observationIds.length, 2)
})

test('簇代表：正文取最长成员原文；subject 取众数（不改写、不摘要）', () => {
  const short = OBS({ id: 'o1', text: '合并到main' })
  const long = OBS({ id: 'o2', text: '倾向将分支都合并到main，只保留main，删掉其余分支' })
  const [c] = clusterObservations([short, long])
  assert.equal(c.text, long.text, '代表正文 = 最长成员原文')
  assert.equal(c.subject, '分支管理')
})

test('复现计数：occurrences 取成员数；sessions/days 来自溯源证据', () => {
  const cluster = { claimDomain: 'user_preference', observationIds: ['o1', 'o2'], evidenceIds: ['e1', 'e2', 'e3'] }
  const byId = new Map([
    ['e1', EV('e1', 's1', '2026-09-20T01:00:00.000Z')],
    ['e2', EV('e2', 's1', '2026-09-20T02:00:00.000Z')],
    ['e3', EV('e3', 's2', '2026-09-21T02:00:00.000Z')],
  ])
  const st = occurrenceStats(cluster, byId)
  assert.equal(st.occurrences, 2)
  assert.deepEqual(st.sessions, ['s1', 's2'])
  assert.equal(st.days, 2)
  assert.equal(st.firstSeen, '2026-09-20T01:00:00.000Z')
  assert.equal(st.lastSeen, '2026-09-21T02:00:00.000Z')
})

test('decideState：跨 session 或跨日才 consensus；单次一律 candidate', () => {
  const c = { claimDomain: 'user_preference', observationIds: ['o1', 'o2'], evidenceIds: [] }
  assert.equal(decideState(c, { occurrences: 1, sessions: ['s1'], days: 1 }), 'candidate')
  assert.equal(decideState(c, { occurrences: 2, sessions: ['s1'], days: 1 }), 'candidate')
  assert.equal(decideState(c, { occurrences: 2, sessions: ['s1', 's2'], days: 1 }), 'consensus')
  assert.equal(decideState(c, { occurrences: 2, sessions: ['s1'], days: 2 }), 'consensus')
})

test('candidateMemoryIdOf：同输入同 id（幂等重跑），成员顺序无关', () => {
  const a = candidateMemoryIdOf({ claimDomain: 'work', subject: 's', observationIds: ['o2', 'o1'] })
  const b = candidateMemoryIdOf({ claimDomain: 'work', subject: 's', observationIds: ['o1', 'o2'] })
  assert.equal(a, b)
  assert.ok(a.startsWith('cm_'))
})

test('planArchival：只列清单不改状态；TTL 边界按 updated_at 判定', () => {
  const now = Date.parse('2026-09-22T00:00:00.000Z')
  const old = now - 100 * 86400000
  const fresh = now - 10 * 86400000
  const plan = planArchival({
    now,
    ttlDays: 90,
    observations: [
      { id: 'o_old', state: 'superseded', createdAt: old },
      { id: 'o_new', state: 'superseded', createdAt: fresh },
      { id: 'o_act', state: 'active', createdAt: old },
    ],
    evidence: [
      { id: 'e_old', state: 'quarantined', updatedAt: old },
      { id: 'e_new', state: 'quarantined', updatedAt: fresh },
      { id: 'e_act', state: 'active', updatedAt: old },
    ],
  })
  assert.deepEqual(plan.observations, ['o_old'])
  assert.deepEqual(plan.evidence, ['e_old'])
  assert.equal(plan.stats.staleObservations, 1)
})

test('runDream：端到端纯函数——不落库、结果可复现', () => {
  const observations = [
    OBS({ id: 'o1', evidenceIds: ['e1'] }),
    OBS({ id: 'o2', evidenceIds: ['e2'], observedAt: '2026-09-21T00:00:00.000Z' }),
    OBS({ id: 'o9', subject: '无关', claimDomain: 'work', text: '完全不同的另一件事', evidenceIds: ['e9'] }),
  ]
  const evidence = [EV('e1', 's1', '2026-09-20T00:00:00.000Z'), EV('e2', 's2', '2026-09-21T00:00:00.000Z'), EV('e9', 's3', '2026-09-21T00:00:00.000Z')]
  const p1 = runDream({ observations, evidence })
  const p2 = runDream({ observations: observations.slice().reverse(), evidence })
  assert.equal(p1.candidates.length, 2)
  assert.deepEqual(p1.candidates.map((c) => c.id).sort(), p2.candidates.map((c) => c.id).sort(), '顺序无关')
  const merged = p1.candidates.find((c) => c.observationIds.length === 2)
  assert.equal(merged.state, 'consensus', '跨两个 session → consensus')
  assert.equal(p1.stats.consensus, 1)
  assert.equal(p1.stats.candidate, 1)
})

test('parseArgs：默认 dry-run；--apply / --ttl-days / --json', () => {
  assert.equal(parseArgs(['--dir', 'X:/l']).apply, false)
  assert.equal(parseArgs([]).ttlDays, 90)
  assert.equal(parseArgs(['--ttl-days', '30']).ttlDays, 30)
  assert.equal(parseArgs(['--apply']).apply, true)
})

test('落库端到端：dry-run 零写入；apply 只写候选池与台账，observation 一条不动', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dream-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = openEvidenceLedger({ dir })
  const EV2 = { sensitivity: 'private', confidence: 0.9, durability: 0.5, sourceClass: 'user_input', authority: 'user_explicit', claimDomain: 'user_preference' }
  const e1 = ledger.append({ ...EV2, content: '倾向将分支合并到main', observedAt: '2026-09-20T00:00:00.000Z', sourceRef: { sessionEventId: 's1:1' } })
  const e2 = ledger.append({ ...EV2, content: '倾向把分支都合并到 main', observedAt: '2026-09-21T00:00:00.000Z', sourceRef: { sessionEventId: 's2:1' } })
  // 注意：同 (subject, predicate) 会触发 observation 的 supersede——那是既有的冲突逻辑。
  // 归并要解决的是**键不同**的孤岛，所以这里刻意给不同 predicate。
  ledger.upsertObservation({ scopeId: 'user-global', subject: '分支管理', predicate: '偏好', claimDomain: 'user_preference', text: '倾向将分支都合并到main只保留main', evidenceIds: [e1.id], observedAt: '2026-09-20T00:00:00.000Z' })
  ledger.upsertObservation({ scopeId: 'user-global', subject: '分支管理', predicate: '工作习惯', claimDomain: 'user_preference', text: '倾向把分支都合并到main只保留main吧', evidenceIds: [e2.id], observedAt: '2026-09-21T00:00:00.000Z' })
  assert.equal(ledger.queryObservation({ state: 'active' }).total, 2, '两条都必须 active（键不同）')

  const rows = readRows(ledger)
  const plan = runDream(rows)
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.candidates[0].state, 'consensus', '跨 s1/s2 两个 session')

  // dry-run：不落库
  // （applyPlan 才是写入口；这里断言还没写）
  assert.equal(ledger.queryCandidateMemory({}).total, 0)

  const res = applyPlan(ledger, plan)
  assert.equal(res.inserted, 1)
  assert.equal(ledger.queryCandidateMemory({}).total, 1)
  assert.equal(ledger.listDreamRuns().length, 1)
  assert.equal(ledger.auditStore.queryAudit({ op: 'dream' }).items.length, 1)

  // 重跑：幂等（更新而非新增）
  const res2 = applyPlan(ledger, plan)
  assert.equal(res2.inserted, 0)
  assert.equal(res2.updated, 1)
  assert.equal(ledger.queryCandidateMemory({}).total, 1)

  // 人的决定不被重跑覆盖
  ledger.db.prepare("UPDATE candidate_memory SET state='approved'").run()
  applyPlan(ledger, plan)
  assert.equal(ledger.queryCandidateMemory({ state: 'approved' }).total, 1, 'approved 必须保住')

  // observation 一条不动（物理分离）
  assert.equal(ledger.queryObservation({}).total, 2)
  ledger.close()
})
