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
  PROMOTION_TOOL_NAME,
  REVIEW_STATUSES,
} from '../src/expression.mjs'

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

test('requestPromotion：approval 发起调用，approved 回调 → reviewStatus=promoted', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const calls = []
  const approval = {
    request: async (req) => { calls.push(req); return 'approved' },
  }
  const row = await expression.requestPromotion(
    { id: ev.id, content: ev.content, claimDomain: ev.claimDomain, sourceRef: ev.sourceRef },
    mockCtx(approval),
  )
  assert.equal(row.metadata.reviewStatus, 'promoted')
  // 发起调用：载荷带 toolName + 证据内容 + source 溯源
  assert.equal(calls.length, 1)
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
  )
  assert.equal(row.metadata.reviewStatus, 'dismissed')
})

test('requestPromotion：审批服务故障（request 抛错）→ fail-open 不抛错', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const approval = { request: async () => { throw new Error('approval backend down') } }
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(approval))
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('requestPromotion：未知 outcome（如 unavailable）→ 不改 reviewStatus', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'unavailable' }
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(approval))
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

// ── oracle 3：approval 不可用 → 静默跳过 ───────────────────────────────────

test('requestPromotion：ctx.get 返回 undefined → 静默跳过不抛错', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx(undefined))
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('requestPromotion：approval 存在但无 request 方法 → 静默跳过不抛错', async (t) => {
  const { ledger } = fresh(t)
  const ev = seedStyleEvidence(ledger)
  const expression = createExpression({ ledger })
  const res = await expression.requestPromotion({ id: ev.id, content: ev.content }, mockCtx({ config: {} }))
  assert.equal(res, null)
  assert.equal(ledger.getById(ev.id).metadata.reviewStatus, undefined)
})

test('requestPromotion：candidate 无 id → 静默跳过不抛错', async (t) => {
  const { ledger } = fresh(t)
  const expression = createExpression({ ledger })
  const approval = { request: async () => 'approved' }
  const res = await expression.requestPromotion({ content: '无 id 候选' }, mockCtx(approval))
  assert.equal(res, null)
})

// ── 契约辅助 ───────────────────────────────────────────────────────────────

test('buildPromotionRequest：载荷含证据内容 + source 溯源（M2-PLAN 5B payload）', () => {
  const req = buildPromotionRequest({
    id: 'ev_1',
    content: '先给结论',
    claimDomain: 'style',
    sourceRef: { sessionEventId: 'x' },
  })
  assert.equal(req.toolName, 'acp.promotion')
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
