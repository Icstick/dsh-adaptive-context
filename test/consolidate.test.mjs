// test/consolidate.test.mjs — Background consolidation（P1-4）验收测试。
// 决策 2B（节流）/ 3A（LLM 主 + 规则兜底）/ 4（observation 冲突 supersede）/ 5（style 接缝）。
// LLM 调用抽成可注入 llmCall，测试传 mock。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  createConsolidator, parseObservations, ruleObservationFor, buildConsolidationPrompt,
} from '../src/consolidate.mjs'
import { createExpression, PENDING_PROMOTION } from '../src/expression.mjs'
import { evaluateCandidate } from '../src/policy.mjs'
import { supersede } from '../src/lifecycle.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-cons-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

function baseEv(i, overrides = {}) {
  return {
    sourceClass: 'user_input',
    authority: 'user_explicit',
    confidence: 0.9,
    durability: 0.5,
    sensitivity: 'private',
    claimDomain: 'user_fact',
    content: '用户偏好 pnpm ' + i,
    observedAt: new Date(Date.UTC(2026, 7, 25, 0, 0, i)).toISOString(),
    sourceRef: { sessionEventId: 'e-' + i },
    ...overrides,
  }
}

function addEvidence(ledger, n) {
  for (let i = 1; i <= n; i++) ledger.append(baseEv(i))
}

// ===================== 决策 2B：节流 =====================

test('节流：证据 <10 且 turn <5 不触发；turn 达标触发（规则兜底）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 3)
  const c = createConsolidator({ ledger, minEvidence: 10, minTurns: 5, llmCall: null })

  assert.equal(c.shouldRun(), false)

  // turn 1..4：都不触发（证据 3 < 10 且 turn < 5）
  for (let i = 1; i <= 4; i++) {
    const r = c.enqueue()
    assert.equal(r.queued, false)
    assert.equal(r.reason, 'throttle')
    assert.equal(c.readTurnCount(), i)
  }

  // 第 5 个 turn：触发
  const r5 = c.enqueue()
  assert.equal(r5.queued, true)
  await c.awaitIdle()

  // 规则兜底：3 条证据 → 3 条 observation；turn 计数清零
  assert.equal(ledger.queryObservation({ scopeId: 'user-global' }).total, 3)
  assert.equal(c.readTurnCount(), 0)
})

test('节流：未消化证据 ≥10 立即触发（不等 turn）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 10)
  const c = createConsolidator({ ledger, minEvidence: 10, minTurns: 5, llmCall: null })

  assert.equal(c.shouldRun(), true)
  const r = c.enqueue()
  assert.equal(r.queued, true)
  await c.awaitIdle()
  assert.equal(ledger.queryObservation({}).total, 10)
})

// ===================== 队列背压 =====================

test('队列背压：已有 pending 任务时新任务丢弃', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 1)

  let release
  const gate = new Promise((res) => { release = res })
  const llmCall = async () => {
    await gate
    return JSON.stringify({ observations: [
      { subject: '包管理器', predicate: '选择', claimDomain: 'work', text: '用 pnpm', evidenceIds: ['e1'] },
    ] })
  }
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })

  const r1 = c.enqueue()
  assert.equal(r1.queued, true)
  assert.equal(c.isPending(), true)

  // 在途未完成时再次入队 → 背压丢弃
  const r2 = c.enqueue()
  assert.equal(r2.queued, false)
  assert.equal(r2.reason, 'backpressure')

  release()
  await c.awaitIdle()
  assert.equal(c.isPending(), false)
})

// ===================== 决策 3A：LLM 派生 / 规则兜底 =====================

test('LLM 成功：解析 JSON 生成 observations', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 2)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '包管理器', predicate: '选择', claimDomain: 'user_preference', text: '用户偏好 pnpm', evidenceIds: ['e1', 'e2'] },
    ],
  })
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  const r = await c.runOnce()

  assert.equal(r.observations, 1)
  const obs = ledger.queryObservation({})
  assert.equal(obs.total, 1)
  const o = obs.items[0]
  assert.equal(o.subject, '包管理器')
  assert.equal(o.claimDomain, 'user_preference')
  assert.deepEqual(o.evidenceIds, ['e1', 'e2'])
})

test('LLM 抛错：重试 1 次后丢弃该批（不落规则兜底）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 3)
  let calls = 0
  const llmCall = async () => { calls += 1; throw new Error('boom') }
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  const r = await c.runOnce()

  assert.equal(calls, 2) // 初次 + 1 次重试
  assert.equal(r.observations, 0)
  assert.equal(ledger.queryObservation({}).total, 0) // 丢弃，不产生 observation
})

test('LLM 输出非法 JSON：重试 1 次后丢弃', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 2)
  let calls = 0
  const llmCall = async () => { calls += 1; return 'not-json' }
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  await c.runOnce()

  assert.equal(calls, 2)
  assert.equal(ledger.queryObservation({}).total, 0)
})

test('llm 缺失：走规则兜底（每证据一条 observation）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 3)
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall: null })
  await c.runOnce()

  const obs = ledger.queryObservation({})
  assert.equal(obs.total, 3)
  for (const o of obs.items) {
    assert.equal(o.predicate, 'states')
    assert.equal(o.evidenceIds.length, 1)
    assert.ok(o.subject.length <= 40)
  }
})

// ===================== 决策 4：observation 冲突 supersede + lineage =====================

test('冲突：同键新 Observation → 旧 superseded + lineage（方案甲）', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.upsertObservation({
    subject: '包管理器', predicate: '选择', claimDomain: 'user_preference', text: '用户喜欢 pnpm', evidenceIds: ['e1'],
  })
  const b = ledger.upsertObservation({
    subject: '包管理器', predicate: '选择', claimDomain: 'user_preference', text: '用户改用 Bun', evidenceIds: ['e2'],
  })

  assert.equal(a.inserted, true)
  assert.equal(b.inserted, true)
  assert.equal(b.supersededId, a.id)

  const oldRow = ledger.getObservationById(a.id)
  const newRow = ledger.getObservationById(b.id)
  assert.equal(oldRow.state, 'superseded')
  assert.equal(newRow.state, 'active')
  // 方案甲：supersedes 属于替代者一侧 → 新行 [旧 id]
  assert.deepEqual(newRow.supersedes, [a.id])
  // lineage：[最旧 ... 最新]
  assert.deepEqual(ledger.getObservationLineage(b.id), [a.id, b.id])

  // 幂等：同键同正文同证据重写不自 supersede
  const c = ledger.upsertObservation({
    subject: '包管理器', predicate: '选择', claimDomain: 'user_preference', text: '用户改用 Bun', evidenceIds: ['e2'],
  })
  assert.equal(c.inserted, false)
  assert.equal(c.id, b.id)
  assert.equal(ledger.getObservationById(a.id).state, 'superseded')
})

test('不同键（predicate/claimDomain 不同）不冲突，两条都 active', (t) => {
  const ledger = freshLedger(t)
  ledger.upsertObservation({ subject: '包管理器', predicate: '选择', claimDomain: 'user_preference', text: 'A', evidenceIds: ['e1'] })
  ledger.upsertObservation({ subject: '包管理器', predicate: '选择', claimDomain: 'work', text: 'B', evidenceIds: ['e2'] })
  const items = ledger.queryObservation({ state: 'active' }).items
  assert.equal(items.length, 2)
})

// ===================== 决策 5：style 候选 → pending_promotion 标记（2026-08-27 架构修正） =====================
// 后台任务无 agent，不能直接发面板审批；style 候选的源证据标 pending_promotion，
// 由下个 turn 的 pre-step（有 agent）发起 approval.request（expression.collectPendingPromotions）。

test('style 候选：源证据标 pending_promotion，非 style 候选不标', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 2)
  const evs = ledger.listActive('user-global') // observedAt 升序：e-1, e-2
  const id1 = evs[0].id
  const id2 = evs[1].id
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '语气', predicate: '偏好', claimDomain: 'style', text: '喜欢简洁', evidenceIds: [id1] },
      { subject: '包管理器', predicate: '选择', claimDomain: 'work', text: '用 pnpm', evidenceIds: [id2] },
    ],
  })
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  await c.runOnce()

  assert.equal(ledger.getById(id1).metadata.reviewStatus, 'pending_promotion')
  assert.equal(ledger.getById(id2).metadata?.reviewStatus, undefined)
})

test('style 候选：已标 pending 的证据不重复标；证据不存在静默跳过（fail-open）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 1)
  const id1 = ledger.listActive('user-global')[0].id
  ledger.updateMetadata(id1, { reviewStatus: 'pending_promotion' })
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '语气', predicate: '偏好', claimDomain: 'style', text: 'x', evidenceIds: [id1, 'ghost'] },
    ],
  })
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  const r = await c.runOnce() // 不应抛
  assert.equal(r.observations, 1)
  assert.equal(ledger.getById(id1).metadata.reviewStatus, 'pending_promotion') // 不重复标也不清
})

// ===================== 纯函数：解析 / 规则兜底 / prompt =====================

test('parseObservations：容忍 markdown fence + 前后杂文，过滤非法条目', () => {
  const raw = 'Here is the result:\n```json\n{"observations":[{"subject":"a","predicate":"b","claimDomain":"work","text":"c","evidenceIds":["e1"]},{"subject":"","predicate":"","claimDomain":"bad","text":"","evidenceIds":[]}]}\n```'
  const r = parseObservations(raw)
  assert.equal(r.ok, true)
  assert.equal(r.observations.length, 1) // 非法条目被过滤
  assert.equal(r.observations[0].subject, 'a')
  assert.equal(parseObservations('nope').ok, false)
  assert.equal(parseObservations('').ok, false)
})

test('ruleObservationFor：subject=内容前 40 字符，text 截断 500', () => {
  const ev = { id: 'e1', claimDomain: 'work', content: 'x'.repeat(100) }
  const o = ruleObservationFor(ev)
  assert.equal(o.subject.length, 40)
  assert.equal(o.predicate, 'states')
  assert.equal(o.text.length, 100) // ≤500，未超
  assert.deepEqual(o.evidenceIds, ['e1'])
})

test('buildConsolidationPrompt：system 含 JSON 契约，user 含证据 JSON', () => {
  const { system, userText } = buildConsolidationPrompt([{ id: 'e1', claimDomain: 'work', content: '用 pnpm' }])
  assert.ok(system.includes('observations'))
  assert.ok(system.includes('claimDomain'))
  assert.ok(userText.includes('e1'))
  assert.ok(userText.includes('用 pnpm'))
})

// ===================== schema v2 迁移 =====================

test('schema v2：旧库（版本 1、无 observation 表）打开自动迁移且不破坏 evidence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-mig-'))
  try {
    // 造一个完整 v2 库并插入一条证据，然后退化为 v1（删 observation、版本回 1）
    const seed = openEvidenceLedger({ dir })
    seed.append({
      sourceClass: 'user_input', authority: 'user_explicit', confidence: 0.9, durability: 0.5,
      sensitivity: 'private', claimDomain: 'user_fact', content: '旧证据', sourceRef: { sessionEventId: 'old' },
    })
    seed.close()
    const raw = new DatabaseSync(path.join(dir, 'acp-ledger.db'))
    raw.exec('DROP TABLE observation')
    raw.exec("UPDATE acp_meta SET value = '1' WHERE key = 'schema_version'")
    raw.close()

    // 重新打开 → 迁移到当前版本（v3）
    const ledger = openEvidenceLedger({ dir })
    try {
      assert.equal(
        ledger.db.prepare("SELECT value FROM acp_meta WHERE key = 'schema_version'").get().value,
        '3',
      )
      assert.ok(ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation'").get())
      const items = ledger.query({ scopeId: 'user-global' }).items
      assert.equal(items.length, 1)
      assert.equal(items[0].content, '旧证据')
    } finally {
      ledger.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===================== M3 B3：style 候选 → policy（guarded auto promotion） =====================
// 依赖 B2 evaluateCandidate + B1 candidate/audit store；无依赖时维持 M2 行为（仅 pending）。

/** style 域证据（同会话，observedAt=now → policy 新鲜度/同会话达标） */
function styleEv(ledger, i, overrides = {}) {
  const res = ledger.append({
    sourceClass: 'user_input',
    authority: 'user_explicit',
    confidence: 0.9,
    durability: 0.5,
    sensitivity: 'private',
    claimDomain: 'style',
    content: '风格偏好 ' + i,
    observedAt: new Date().toISOString(),
    sourceRef: { sessionId: 'sess-b3', messageId: 'm' + i },
    ...overrides,
  })
  return ledger.getById(res.id)
}

/** 带 B3 依赖的 consolidator（policyEvaluate 包装 + autoPromote 桥到 expression） */
function b3Consolidator(ledger, policyConfig = {}, extra = {}) {
  const expression = createExpression({
    ledger,
    candidateStore: ledger.candidateStore,
    auditStore: ledger.auditStore,
    views: null,
    scopeId: 'user-global',
  })
  return createConsolidator({
    ledger,
    minEvidence: 1,
    minTurns: 100,
    llmCall: null,
    candidateStore: ledger.candidateStore,
    auditStore: ledger.auditStore,
    policyEvaluate: (args) => evaluateCandidate({ ...args, config: policyConfig }),
    autoPromote: (cand, res) => expression.autoPromote(cand, res),
    ...extra,
  })
}

test('B3 style：policy 达标（2 STRONG 同会话 + autoPromote）→ 自动 promote（候选行+reviewStatus+audit）', async (t) => {
  const ledger = freshLedger(t)
  const a = styleEv(ledger, 1)
  const b = styleEv(ledger, 2)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: '先结论后展开', evidenceIds: [a.id, b.id] },
    ],
  })
  const c = b3Consolidator(ledger, { autoPromote: true }, { llmCall })
  const r = await c.runOnce()
  assert.equal(r.observations, 1)

  const cands = ledger.candidateStore.listCandidates({ scopeId: 'user-global' })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].state, 'promoted')
  assert.equal(cands[0].domain, 'style')
  // reviewStatus 同步（不再 pending）
  assert.equal(ledger.getById(a.id).metadata.reviewStatus, 'promoted')
  assert.equal(ledger.getById(b.id).metadata.reviewStatus, 'promoted')
  // audit：op=promote, actor=consolidation，payload 含 policy 快照
  const audit = ledger.auditStore.queryAudit({ op: 'promote', actor: 'consolidation' })
  assert.equal(audit.items.length, 1)
  assert.ok(audit.items[0].payload.policy)
  assert.equal(audit.items[0].payload.policy.autoPromote, true)
})

test('B3 style：autoPromote 未开启（默认）→ policy hold → 维持 pending_promotion（manual 路径）', async (t) => {
  const ledger = freshLedger(t)
  const a = styleEv(ledger, 1)
  const b = styleEv(ledger, 2)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: '先结论后展开', evidenceIds: [a.id, b.id] },
    ],
  })
  const c = b3Consolidator(ledger, {}, { llmCall })
  await c.runOnce()

  const cands = ledger.candidateStore.listCandidates({ scopeId: 'user-global' })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].state, 'proposed')
  assert.equal(ledger.getById(a.id).metadata.reviewStatus, PENDING_PROMOTION)
  assert.equal(ledger.getById(b.id).metadata.reviewStatus, PENDING_PROMOTION)
  assert.equal(ledger.auditStore.queryAudit({ op: 'promote' }).total, 0)
})

test('B3 style：存在冲突候选（同 scope+domain proposed）→ 达标也 hold → pending', async (t) => {
  const ledger = freshLedger(t)
  const other = ledger.append({
    sourceClass: 'user_input', authority: 'user_explicit', confidence: 0.9, durability: 0.5,
    sensitivity: 'private', claimDomain: 'style', content: '旧候选主张', sourceRef: { sessionId: 'sess-other' },
  })
  ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ledger.getById(other.id).id] })

  const a = styleEv(ledger, 1)
  const b = styleEv(ledger, 2)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: '新主张', evidenceIds: [a.id, b.id] },
    ],
  })
  const c = b3Consolidator(ledger, { autoPromote: true }, { llmCall })
  await c.runOnce()

  const cands = ledger.candidateStore.listCandidates({ scopeId: 'user-global' })
  assert.equal(cands.length, 2)
  const mine = cands.find((x) => x.evidenceIds.includes(a.id))
  assert.equal(mine.state, 'proposed') // 冲突候选 → hold → 留人工
  assert.equal(ledger.getById(a.id).metadata.reviewStatus, PENDING_PROMOTION)
})

test('B3 style：同键 superseded 旧证据 → 标 opposes → policy hold → pending', async (t) => {
  const ledger = freshLedger(t)
  const a = styleEv(ledger, 1, { content: '喜欢 verbose 风格', sourceRef: { sessionId: 'sess-b3', messageId: 'old' } })
  const b = styleEv(ledger, 2, { content: '改为简洁风格' })
  supersede(a.id, b.id, { ledger }) // b.supersedes=[a]，a.state=superseded
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: '简洁风格', evidenceIds: [b.id] },
    ],
  })
  const c = b3Consolidator(ledger, { autoPromote: true }, { llmCall })
  await c.runOnce()

  const cand = ledger.candidateStore.listCandidates({ scopeId: 'user-global' })[0]
  assert.equal(cand.state, 'proposed') // 反对证据 → hold → 留人工
  assert.equal(ledger.getById(b.id).metadata.reviewStatus, PENDING_PROMOTION)
})

test('B3 style：同证据集批量重复产出 → 复用候选不新建（候选去重）', async (t) => {
  const ledger = freshLedger(t)
  const a = styleEv(ledger, 1)
  const b = styleEv(ledger, 2)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: 'x1', evidenceIds: [a.id, b.id] },
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: 'x2', evidenceIds: [a.id, b.id] },
    ],
  })
  const c = b3Consolidator(ledger, { autoPromote: true }, { llmCall })
  await c.runOnce()

  const cands = ledger.candidateStore.listCandidates({ scopeId: 'user-global' })
  assert.equal(cands.length, 1) // 复用，不新建
  assert.equal(cands[0].state, 'promoted')
})

test('B3 style：无 B3 依赖 → 维持 M2 行为（仅 pending，不建候选）', async (t) => {
  const ledger = freshLedger(t)
  const a = styleEv(ledger, 1)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '回答风格', predicate: '偏好', claimDomain: 'style', text: 'x', evidenceIds: [a.id] },
    ],
  })
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  await c.runOnce()
  assert.equal(ledger.getById(a.id).metadata.reviewStatus, PENDING_PROMOTION)
  assert.equal(ledger.candidateStore.listCandidates({}).length, 0)
})
