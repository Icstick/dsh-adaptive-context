// test/expression.test.mjs — T6 Expression manual promotion（P1-6 / 决策 5B=approval 审批门）。
// 验收 oracle：
//   1) applyPromotionDecision：promoted/dismissed → metadata.reviewStatus；不存在 id 抛错
//   2) requestPromotion：mock approval（带 request）→ 发起调用；outcome 回调 → reviewStatus 正确迁移
//   3) approval 不可用（ctx.get 返回 undefined）→ 静默跳过不抛错
//   4) 现有测试保持全绿（本文件不触碰其他模块行为）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  applyPromotionDecision,
  createExpression,
  buildPromotionRequest,
  collectPendingPromotions,
  PENDING_PROMOTION,
  PROMOTION_TOOL_NAME,
  REVIEW_STATUSES,
} from '../src/expression.mjs'
import { createViews } from '../src/views.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-expr-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return { ledger }
}

/** style 域候选证据（candidate→confirmed 手动路径的目标） */
function seedStyleEvidence(ledger, content = '回答风格：先给结论，再给理由') {
  const res = ledger.append({
    sourceClass: 'user_input',
    authority: 'user_explicit',
    confidence: 1,
    durability: 0.7,
    sensitivity: 'private',
    claimDomain: 'style',
    content,
    sourceRef: { sessionEventId: 'expr-1', messageId: 'm1' },
  })
  // append 返回 {inserted, id, row}；测试需要完整证据行
  return ledger.getById(res.id)
}

/** 最小 cordis-like ctx：显式 get 拿 approval（proxy 铁律：不隐式 ctx.approval） */
function mockCtx(approval) {
  return {
    get: (name) => (name === 'approval' ? approval : undefined),
    logger: { debug: () => {}, warn: () => {} },
  }
}

/** mock agent（ApprovalRequest.agent 必填；pre-step payload.agent 形状） */
function mockAgent() {
  return { id: 'agent-1', session: { id: 'session-1' } }
}

// ── oracle 1：applyPromotionDecision ────────────────────────────────────────

test('applyPromotionDecision：promoted → metadata.reviewStatus=promoted', (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const row = applyPromotionDecision(ledger, ev.id, 'promoted')
  assert.equal(row.metadata.reviewStatus, 'promoted')
  // append-only：证据行本身不被改写
  assert.equal(row.id, ev.id)
  assert.equal(row.state, 'active')
  assert.equal(row.content, ev.content)
  assert.equal(row.claimDomain, 'style')
})

test('applyPromotionDecision：dismissed → metadata.reviewStatus=dismissed', (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const row = applyPromotionDecision(ledger, ev.id, 'dismissed')
  assert.equal(row.metadata.reviewStatus, 'dismissed')
})

test('applyPromotionDecision：evidenceId 不存在抛错', (t) => {
  const { ledger } = fresh(t)
  assert.throws(() => applyPromotionDecision(ledger, 'no-such-evidence', 'promoted'), /not found/)
})

test('applyPromotionDecision：非法 decision 抛 TypeError', (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  assert.throws(() => applyPromotionDecision(ledger, ev.id, 'maybe'), TypeError)
})

// ── oracle 2：requestPromotion 走 approval 审批门 ───────────────────────────

test('requestPromotion：approval 发起调用，allowed-once 回调 → reviewStatus=promoted', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const calls = []
  const approval = {
    request: async (req) => { calls.push(req); return 'allowed-once' },
  }
  const row = await expression.requestPromotion(
    { id: ev.id, content: ev.content, claimDomain: ev.claimDomain, sourceRef: ev.sourceRef },
    mockCtx(approval),
    mockAgent(),
  )
  assert.equal(row.metadata.reviewStatus, 'promoted')
  // 发起调用：载荷带 agent + toolName + 证据内容 + source 溯源
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent.id, 'agent-1')
  assert.equal(calls[0].toolName, PROMOTION_TOOL_NAME)
  assert.ok(calls[0].reason.includes(ev.id))
  assert.ok(calls[0].reason.includes(ev.content))
  assert.ok(calls[0].reason.includes('style'))
})

test('requestPromotion：rejected 回调 → reviewStatus=dismissed', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'rejected' }
  const row = await expression.requestPromotion(
    { id: ev.id, content: ev.content, claimDomain: ev.claimDomain },
    mockCtx(approval),
    mockAgent(),
  )
  assert.equal(row.metadata.reviewStatus, 'dismissed')
})

test('requestPromotion：审批服务故障（request 抛错）→ fail-open 不抛错', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const approval = { request: async () => { throw new Error('approval backend down') } }
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(approval), mockAgent())
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('requestPromotion：未知 outcome（如 unavailable）→ 不改 reviewStatus', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'unavailable' }
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(approval), mockAgent())
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

// ── oracle 3：approval 不可用 → 静默跳过 ───────────────────────────────────

test('requestPromotion：ctx.get 返回 undefined → 静默跳过不抛错', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(undefined), mockAgent())
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('requestPromotion：approval 存在但无 request 方法 → 静默跳过不抛错', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx({ config: {} }), mockAgent())
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('requestPromotion：无 agent → 静默跳过不抛错（ApprovalRequest.agent 必填）', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const called = []
  const approval = { request: async (req) => { called.push(req); return 'allowed-once' } }
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(approval), undefined)
  assert.equal(res, null)
  assert.equal(called.length, 0)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('collectPendingPromotions：只收集 active + pending_promotion 证据', (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const other = ledger.append({
    sourceClass: 'user_input', authority: 'user_explicit', confidence: 1, durability: 0.5,
    sensitivity: 'private', claimDomain: 'user_fact', content: '普通事实', sourceRef: { sessionEventId: 'x2' },
  })
  assert.equal(collectPendingPromotions(ledger).length, 0)
  ledger.updateMetadata(ev.id, { reviewStatus: PENDING_PROMOTION })
  const pending = collectPendingPromotions(ledger)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, ev.id)
  assert.equal(pending[0].metadata.reviewStatus, PENDING_PROMOTION)
  // 非 pending 证据不进入
  assert.equal(ledger.getById(other.id).metadata?.reviewStatus, undefined)
})

test('完整链路：pending 候选 → approval 审批 → promoted（pre-step 触发模式）', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  ledger.updateMetadata(ev.id, { reviewStatus: PENDING_PROMOTION })
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'allowed-once' }
  const pending = expression.collectPendingPromotions()
  assert.equal(pending.length, 1)
  const row = await expression.requestPromotion(
    { id: pending[0].id, content: pending[0].content, claimDomain: pending[0].claimDomain, sourceRef: pending[0].sourceRef },
    mockCtx(approval),
    mockAgent(),
  )
  assert.equal(row.metadata.reviewStatus, 'promoted')
  // 审批后不再是 pending
  assert.equal(collectPendingPromotions(ledger).length, 0)
})

test('requestPromotion：candidate 无 id → 静默跳过不抛错', async (t) => {
  const { ledger } = fresh(t)
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'allowed-once' }
  const res = await expression.requestPromotion({ content: '无 id 候选' }, mockCtx(approval), mockAgent())
  assert.equal(res, null)
})

// ── 契约辅助 ───────────────────────────────────────────────────────────────

test('buildPromotionRequest：载荷含 agent + 证据内容 + source 溯源（DSH ApprovalRequest 契约）', () => {
  const req = buildPromotionRequest({
    id: 'ev_1',
    content: '先给结论',
    claimDomain: 'style',
    sourceRef: { sessionEventId: 'x' },
  }, { id: 'agent-9' })
  assert.equal(req.toolName, 'acp.promotion')
  assert.equal(req.agent.id, 'agent-9')
  assert.ok(req.reason.includes('ev_1'))
  assert.ok(req.reason.includes('先给结论'))
  assert.ok(req.reason.includes('"sessionEventId":"x"'))
  assert.ok(req.reason.includes('promoted | dismissed'))
})

test('REVIEW_STATUSES 固定为 promoted|dismissed', () => {
  assert.deepEqual(REVIEW_STATUSES, ['promoted', 'dismissed'])
})

// ── index.mjs 桥接缝（源码契约，防回归）───────────────────────────────────
test('index.mjs：acp 桥含 requestPromotion 且 inject 不加 approval', () => {
  const src = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('requestPromotion'))
  // 桥必须兼容两参调用（C 组接缝）
  assert.ok(src.includes('requestPromotion: (candidate, ctxArg) => expression.requestPromotion'))
  // inject 行不含 approval（approval 走 withService 可选模式；T4 起含 'llm'）
  const injectLine = src.match(/export const inject = (\[[^\]]*\])/)?.[1] ?? ''
  assert.ok(!injectLine.includes('approval'))
  assert.ok(injectLine.includes('llm'))
})

// ── M3 B3：manual 审批 → candidate promote + view + audit ─────────────────

/** 带 B3 依赖的 expression（candidateStore/auditStore/views） */
function b3Expression(t) {
  const { ledger } = fresh(t)
  const vdir = mkdtempSync(path.join(tmpdir(), 'acp-expr-view-'))
  t.after(() => rmSync(vdir, { recursive: true, force: true }))
  const views = createViews({ dir: vdir, ledger, candidateStore: ledger.candidateStore, scopeId: 'user-global' })
  const expression = createExpression({
    ledger,
    candidateStore: ledger.candidateStore,
    auditStore: ledger.auditStore,
    views,
    scopeId: 'user-global',
  })
  return { ledger, views, expression }
}

test('B3 manual：allowed-once → candidate promote + view 重写 + audit(actor=user) + reviewStatus', async (t) => {
  const { ledger, views, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  // 模拟 consolidation：已建候选 + 标 pending
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev.id] })
  ledger.updateMetadata(ev.id, { reviewStatus: PENDING_PROMOTION })

  const approval = { request: async () => 'allowed-once' }
  const row = await expression.requestPromotion(
    { id: ev.id, content: ev.content, claimDomain: ev.claimDomain, sourceRef: ev.sourceRef },
    mockCtx(approval),
    mockAgent(),
  )
  // reviewStatus 同步（保留现有行为）
  assert.equal(row.metadata.reviewStatus, 'promoted')
  // candidate 行 promote（reason=manual-approval）
  const updated = ledger.candidateStore.getCandidate(cand.id)
  assert.equal(updated.state, 'promoted')
  assert.equal(updated.decisionReason, 'manual-approval')
  // view 重写：含该候选的行
  const viewRows = views.readExpression()
  assert.equal(viewRows.length, 1)
  assert.equal(viewRows[0].candidateId, cand.id)
  assert.equal(viewRows[0].content, ev.content)
  // audit：op=promote, actor=user
  const audit = ledger.auditStore.queryAudit({ op: 'promote' })
  assert.ok(audit.items.some((a) => a.targetId === cand.id && a.actor === 'user' && a.reason === 'manual-approval'))
  // 视图与重放一致
  assert.equal(views.verifyExpression().ok, true)
})

test('B3 manual：rejected → candidate reject + audit(actor=user) + reviewStatus=dismissed', async (t) => {
  const { ledger, views, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev.id] })
  ledger.updateMetadata(ev.id, { reviewStatus: PENDING_PROMOTION })

  const approval = { request: async () => 'rejected' }
  const row = await expression.requestPromotion(
    { id: ev.id, content: ev.content, claimDomain: ev.claimDomain },
    mockCtx(approval),
    mockAgent(),
  )
  assert.equal(row.metadata.reviewStatus, 'dismissed')
  assert.equal(ledger.candidateStore.getCandidate(cand.id).state, 'rejected')
  const audit = ledger.auditStore.queryAudit({ op: 'dismiss' })
  assert.ok(audit.items.some((a) => a.targetId === cand.id && a.actor === 'user'))
  // rejected 不进 view
  assert.equal(views.readExpression(), null)
})

test('B3 promoteEvidence：无既有候选时兜底创建候选（纯 manual 流程可审计）', (t) => {
  const { ledger, views, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  const row = expression.promoteEvidence(ev.id)
  assert.equal(row.metadata.reviewStatus, 'promoted')
  const cand = expression.findCandidateForEvidence(ev.id)
  assert.ok(cand)
  assert.equal(cand.state, 'promoted')
  assert.equal(cand.decisionReason, 'manual-approval')
  assert.equal(views.readExpression().length, 1)
  const audit = ledger.auditStore.queryAudit({ op: 'promote' })
  assert.ok(audit.items.some((a) => a.actor === 'user'))
})

test('B3 legacy：无 B3 依赖时（createExpression({ledger})）不产生候选行', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'allowed-once' }
  const row = await expression.requestPromotion(
    { id: ev.id, content: ev.content },
    mockCtx(approval),
    mockAgent(),
  )
  assert.equal(row.metadata.reviewStatus, 'promoted')
  assert.equal(ledger.candidateStore.listCandidates({}).length, 0)
})

// ── M3 B3：autoPromote 路径 ───────────────────────────────────────────────

test('B3 autoPromote：policy promote → candidate promote + view + audit(actor=consolidation) + reviewStatus', (t) => {
  const { ledger, views, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev.id] })
  const policyResult = {
    decision: 'promote',
    reason: 'policy floors satisfied (2/2 compatible events, 1/1 strong supporting)',
    policy: { autoPromote: true, minEvents: 2, evaluatedAt: new Date().toISOString() },
  }
  const promoted = expression.autoPromote(cand, policyResult)
  assert.equal(promoted.state, 'promoted')
  assert.equal(promoted.decisionReason, policyResult.reason)
  // reviewStatus 同步
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, 'promoted')
  // view 重写
  const viewRows = views.readExpression()
  assert.equal(viewRows.length, 1)
  assert.equal(viewRows[0].candidateId, cand.id)
  // audit：op=promote, actor=consolidation（B1 AUDIT_ACTORS 不含 policy → 用 consolidation），payload 含 policy 快照
  const audit = ledger.auditStore.queryAudit({ op: 'promote', actor: 'consolidation' })
  assert.equal(audit.items.length, 1)
  assert.equal(audit.items[0].targetId, cand.id)
  assert.equal(audit.items[0].reason, policyResult.reason)
  assert.deepEqual(audit.items[0].payload.policy, policyResult.policy)
  assert.equal(views.verifyExpression().ok, true)
})

test('B3 autoPromote：非 proposed 候选 → 抛错（不落状态）', (t) => {
  const { ledger, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev.id] })
  const promoted = expression.autoPromote(cand, { decision: 'promote', reason: 'x' })
  assert.equal(promoted.state, 'promoted')
  assert.throws(
    () => expression.autoPromote(promoted, { decision: 'promote', reason: 'x2' }),
    /not proposed/,
  )
})

// ── M3 B3：rollback 路径 ──────────────────────────────────────────────────

test('B3 rollback：promoted → rolled_back + view 重建 + audit(actor=user)', (t) => {
  const { ledger, views, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev.id] })
  ledger.candidateStore.transitionCandidate(cand.id, 'promote', { reason: 'test', actor: 'user' })
  views.rebuildExpression()
  assert.equal(views.readExpression().length, 1)

  const res = expression.rollback(cand.id)
  assert.equal(res.ok, true)
  assert.equal(res.candidate.state, 'rolled_back')
  // view 重写：rolled_back 候选即时失效
  assert.equal(views.readExpression().length, 0)
  assert.equal(views.verifyExpression().ok, true)
  // audit
  const audit = ledger.auditStore.queryAudit({ op: 'rollback' })
  assert.ok(audit.items.some((a) => a.targetId === cand.id && a.actor === 'user'))
})

test('B3 rollback：只对 promoted 有效（非 promoted → ok:false + reason）', (t) => {
  const { ledger, expression } = b3Expression(t)
  const ev = seedStyleEvidence(ledger)
  const cand = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev.id] })
  const res = expression.rollback(cand.id) // proposed
  assert.equal(res.ok, false)
  assert.ok(res.reason.includes('only applies to promoted'))

  const missing = expression.rollback('cand_nope')
  assert.equal(missing.ok, false)
  assert.ok(missing.reason.includes('not found'))
})
