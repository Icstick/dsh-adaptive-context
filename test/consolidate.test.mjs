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
import { SCHEMA_VERSION } from '../src/constants.mjs'
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

// ===================== P0 源头过滤（2026-09-09） =====================

test('源头过滤：agent_authored/experience 不进蒸馏队列，用户证据照常', async (t) => {
  const ledger = freshLedger(t)
  for (let i = 1; i <= 3; i++) {
    ledger.append(baseEv(i, {
      sourceClass: 'agent_authored',
      authority: 'single_observation',
      claimDomain: 'experience',
      content: '任务全绿 ' + i,
    }))
  }
  ledger.append(baseEv(9, {
    sourceClass: 'user_input',
    authority: 'user_explicit',
    claimDomain: 'user_preference',
    content: '用户偏好 Bun',
  }))

  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall: null })
  const pending = c.undigestedEvidence()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].claimDomain, 'user_preference')
})

test('源头过滤可关闭：skipAgentExperience=false 时动作流水照常进队列', async (t) => {
  const ledger = freshLedger(t)
  ledger.append(baseEv(1, {
    sourceClass: 'agent_authored',
    authority: 'single_observation',
    claimDomain: 'experience',
  }))
  const c = createConsolidator({
    ledger, minEvidence: 1, minTurns: 100, llmCall: null, skipAgentExperience: false,
  })
  assert.equal(c.undigestedEvidence().length, 1)
})

test('源头过滤：批内只剩动作流水时不产生 LLM 调用', async (t) => {
  const ledger = freshLedger(t)
  ledger.append(baseEv(1, {
    sourceClass: 'agent_authored',
    authority: 'single_observation',
    claimDomain: 'experience',
  }))
  let calls = 0
  const c = createConsolidator({
    ledger, minEvidence: 1, minTurns: 100,
    llmCall: async () => { calls += 1; return '{"observations":[]}' },
  })
  const r = await c.runOnce()
  assert.equal(calls, 0)
  assert.equal(r.digested, 0)
  assert.equal(ledger.queryObservation({}).total, 0)
})

test('源头过滤：agent_authored 的非 experience 证据仍会蒸馏', async (t) => {
  const ledger = freshLedger(t)
  ledger.append(baseEv(1, {
    sourceClass: 'agent_authored',
    authority: 'agent_inference',
    claimDomain: 'external_fact',
    content: '官方文档称 X 已废弃',
  }))
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall: null })
  assert.equal(c.undigestedEvidence().length, 1)
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

test('parseObservations：显式空数组 = 合法空产（P1-4 回归：动作流水批契约）', () => {
  const empty = parseObservations('{"observations":[]}')
  assert.equal(empty.ok, true)
  assert.equal(empty.observations.length, 0)
  // markdown fence 包裹的空数组同样合法
  assert.equal(parseObservations('```json\n{"observations":[]}\n```').ok, true)
  // 非空数组但条目全部字段非法 → 偏离 schema 契约，仍判失败（保留重试）
  const garbage = parseObservations('{"observations":[{"subject":"","predicate":"","claimDomain":"bad","text":""}]}')
  assert.equal(garbage.ok, false)
  // 混合：部分合法 → 保留合法条目
  const mixed = parseObservations('{"observations":[{"subject":"a","predicate":"b","claimDomain":"work","text":"c"},{"subject":"","predicate":"x"}]}')
  assert.equal(mixed.ok, true)
  assert.equal(mixed.observations.length, 1)
})

test('LLM 返回显式空数组：合法空产 → 消化该批并推进水位（P1-4 回归）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 2)
  let calls = 0
  const llmCall = async () => { calls += 1; return '{"observations":[]}' }
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  const r = await c.runOnce()
  assert.equal(r.ran, true)
  assert.equal(r.digested, 2)                    // 批被消化（旧实现卡死在此）
  assert.equal(r.observations, 0)                // 无 observation 产出
  assert.equal(calls, 1)                         // 无重试
  assert.equal(c.undigestedEvidence().length, 0) // 水位推进 → 无积压
  assert.equal(ledger.queryObservation({ scopeId: 'user-global' }).total, 0)
  // 空账再跑：不再消耗 LLM
  const r2 = await c.runOnce()
  assert.equal(r2.digested, 0)
  assert.equal(calls, 1)
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

test('buildConsolidationPrompt：P3 修复后输出硬约束（≤120 字符、整批 ≤3 条、禁逐条复制）', () => {
  const { system, userText } = buildConsolidationPrompt(
    Array.from({ length: 4 }, (_, i) => ({ id: 'e' + i, claimDomain: 'work', content: '内容'.repeat(500) })),
  )
  assert.ok(system.includes('AT MOST 3 observations'))
  assert.ok(system.includes('120 characters'))
  assert.ok(system.includes('do not copy evidence text verbatim'))
  assert.ok(userText.includes('[truncated'))
  const e0 = userText.indexOf('e0')
  assert.ok(e0 >= 0)
  const tail = userText.slice(e0, e0 + 900)
  assert.ok(!tail.includes('内容'.repeat(500).slice(0, 700)), '输入必须被截短')
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

    // 重新打开 → 迁移到当前版本（v4）
    const ledger = openEvidenceLedger({ dir })
    try {
      assert.equal(
        ledger.db.prepare("SELECT value FROM acp_meta WHERE key = 'schema_version'").get().value,
        String(SCHEMA_VERSION),
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

// ===================== T2.5（2026-09-07）：动作流水转写禁令与硬过滤 =====================

test('buildConsolidationPrompt：system 含流水账禁令与空输出许可（T2.5）', () => {
  const { system } = buildConsolidationPrompt([{ id: 'e1', claimDomain: 'user_fact', content: '用户说继续' }])
  assert.ok(system.includes('NEVER emit action transcripts'), '禁流水转写')
  assert.ok(system.includes('{"observations":[]}'), '纯流水批允许空输出')
})

test('runOnce：LLM 产出流水形态（用户+询问）→ 落库前硬过滤，不写 observation', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 2)
  const llmCall = async () => JSON.stringify({
    observations: [
      { subject: '用户', predicate: '询问', claimDomain: 'user_fact', text: '用户询问消化进度', evidenceIds: ['e1', 'e2'] },
      { subject: '包管理器', predicate: '偏好', claimDomain: 'user_preference', text: '用户偏好 pnpm', evidenceIds: ['e1', 'e2'] },
    ],
  })
  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 100, llmCall })
  const r = await c.runOnce()
  assert.equal(r.observations, 1, '只写非流水 1 条')
  const obs = ledger.queryObservation({})
  assert.equal(obs.total, 1)
  assert.equal(obs.items[0].subject, '包管理器')
})
// ===================== 失败计数复位（2026-09-10） =====================

test('consolidation 成功后 fail_count 归零并写 audit（不再只增不减）', async (t) => {
  const ledger = freshLedger(t)
  addEvidence(ledger, 3)

  const audits = []
  const auditStore = { appendAudit: (row) => audits.push(row) }
  // 第 1 次调用返回不可解析输出 → 2 次尝试都失败 → 记录一次失败
  // 第 2 次起返回合法 observation JSON → 成功
  let calls = 0
  const llmCall = async () => {
    calls += 1
    if (calls <= 2) return '这不是 JSON'
    // 契约：必须是 { observations: [...] }，裸数组会被 parseObservations 判为非法
    return JSON.stringify({ observations: [{ subject: '用户', predicate: '偏好', claimDomain: 'user_fact', text: '用户偏好 pnpm' }] })
  }

  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 99, llmCall, auditStore })

  const r1 = await c.runOnce()
  assert.equal(r1.reason, 'llm_failed')
  assert.equal(ledger.getMeta('consolidation_fail_count'), '1')
  assert.ok(ledger.getMeta('consolidation_last_failure'), 'last_failure 应写入')

  const r2 = await c.runOnce()
  assert.equal(r2.reason, undefined)
  assert.ok(r2.digested >= 1, '第二批应消化成功')
  assert.equal(r2.failuresBefore, 1, '返回值应带上成功前的连续失败次数')
  assert.equal(ledger.getMeta('consolidation_fail_count'), '0', '成功后必须归零')
  assert.equal(ledger.getMeta('consolidation_last_failure'), '', '成功后应清除 last_failure')

  const okAudit = audits.find((a) => a.reason === 'consolidation ok; watermark advanced')
  assert.ok(okAudit, '成功应写 audit，否则历史里只剩失败行')
  assert.equal(okAudit.payload.failuresBefore, 1)
})

console.log('\nAll consolidation tests passed.')