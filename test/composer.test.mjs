// test/composer.test.mjs — Context Composer 测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compose, lexicalScore, utilityOf, renderSourceLabelled, sectionOf,
} from '../src/composer.mjs'
import { packBySection, estimateTokens, MVP_SECTION_QUOTA, MVP_TOTAL_BUDGET } from '../src/budget.mjs'

const ev = (over = {}) => ({
  id: 'ev_1',
  scopeId: 'user-global',
  state: 'active',
  sourceClass: 'user_input',
  authority: 'user_explicit',
  claimDomain: 'user_fact',
  confidence: 1,
  content: '用户偏好 TypeScript',
  observedAt: new Date().toISOString(),
  ...over,
})

test('compose 基础：合格候选进入，quarantine 被过滤', () => {
  const r = compose([
    ev({ id: 'a', content: '用 pnpm 管理依赖' }),
    ev({ id: 'b', state: 'quarantined', content: '恶意内容' }),
  ], { query: '包管理器', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'a')
  assert.equal(r.dropped.some(d => d.reason.includes('not injectable')), true)
  assert.ok(r.telemetry.retrieved >= 2)
})

test('compose token 预算：总预算 ≤ MVP_TOTAL_BUDGET', () => {
  const cands = Array.from({ length: 20 }, (_, i) =>
    ev({ id: 'c' + i, content: '这是一个比较长的测试内容'.repeat(10) + i }))
  // query 必须与 content 无子串包含关系，否则新 self-echo 过滤会误伤本测试（预算语义失效）
  const r = compose(cands, { query: '预算', scopeId: 'user-global' })
  assert.ok(r.telemetry.totalTokens <= MVP_TOTAL_BUDGET)
  assert.equal(r.telemetry.admitted, r.items.length)
})

test('explicit_correction_boost 提高 utility', () => {
  const a = utilityOf(ev({ explicitCorrection: true, content: '更正：用 Bun' }), { query: 'bun' })
  const b = utilityOf(ev({ content: '用 pnpm' }), { query: 'bun' })
  assert.ok(a.utility > b.utility)
})

test('lexicalScore：CJK 子串匹配', () => {
  assert.equal(lexicalScore('包管理器', '这个项目用 pnpm 作为包管理器'), 1)
  assert.equal(lexicalScore('包管理器', '完全无关内容'), 0) // bigram 无重叠
  assert.ok(lexicalScore('喜欢什么风格回答', '用户喜欢详细的技术回答') > 0) // bigram 部分重叠
  assert.equal(lexicalScore('喜欢什么风格回答', '用户喜欢详细的技术回答'), 2 / 7) // 2/7 窗口命中
})

test('sectionOf：claimDomain → section', () => {
  assert.equal(sectionOf(ev({ claimDomain: 'user_fact' })), 'user_model')
  assert.equal(sectionOf(ev({ claimDomain: 'work' })), 'work_state')
  assert.equal(sectionOf(ev({ claimDomain: 'style' })), 'expression')
  assert.equal(sectionOf(ev({ claimDomain: 'external_fact' })), 'memory')
})

test('packBySection：超 quota 截断', () => {
  const cands = Array.from({ length: 10 }, (_, i) => ({
    id: 'x' + i, section: 'memory', utility: 1, tokens: 100, content: 'x'.repeat(140),
  }))
  const r = packBySection(cands)
  assert.ok(r.items.length <= 3) // memory quota 300 / 100 = 3
  assert.equal(r.totalTokens <= 300, true)
})

test('renderSourceLabelled：带来源标签', () => {
  const s = renderSourceLabelled([ev({ id: 'a', content: '用 pnpm' })])
  assert.ok(s.includes('[acp:user_input | id=a | domain=user_fact]'))
  assert.ok(s.includes('用 pnpm'))
})

test('estimateTokens 中文估算', () => {
  assert.equal(estimateTokens('你好世界'), Math.ceil(4 * 0.7))
})

// ===== T1 self-echo 过滤（验收 oracle）=====

test('T1 self-echo：候选 content 等于 query → dropped self-echo', () => {
  const msg = '继续 M2 讨论吧，另外给这个 session 重写个标题'
  const r = compose([ev({ id: 's1', content: msg })], { query: msg, scopeId: 'user-global' })
  assert.equal(r.items.length, 0)
  assert.equal(r.dropped.filter((d) => d.reason === 'self-echo').length, 1)
  assert.equal(r.dropped[0].id, 's1')
})

test('T1 self-echo：候选 content 包含 query（query 是子串）→ dropped self-echo', () => {
  const r = compose(
    [ev({ id: 's2', content: '我们继续 M2 讨论吧，先把技术点拆解一下' })],
    { query: 'M2 讨论', scopeId: 'user-global' },
  )
  assert.equal(r.items.length, 0)
  assert.equal(r.dropped.filter((d) => d.reason === 'self-echo').length, 1)
})

test('T1 self-echo：query 包含候选 content（候选是子串）→ 保留', () => {
  const r = compose(
    [ev({ id: 's3', content: '用 pnpm 管理依赖' })],
    { query: '这个项目用 pnpm 管理依赖，你觉得怎么样？', scopeId: 'user-global' },
  )
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 's3')
  assert.equal(r.dropped.some((d) => d.reason === 'self-echo'), false)
})

test('T1 self-echo：query 为空时不启用过滤', () => {
  const msg = '任意消息内容'
  const r = compose([ev({ id: 's4', content: msg })], { scopeId: 'user-global' }) // 无 query
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped.some((d) => d.reason === 'self-echo'), false)
})

// ===== T2 contentHash dedup（验收 oracle）=====

test('T2 contentHash dedup：三条相同 content 不同 id → 注入 1 条，dropped 2 条 duplicate-content', () => {
  const r = compose([
    ev({ id: 'd1', content: '用户偏好 TypeScript' }),
    ev({ id: 'd2', content: '用户偏好 TypeScript' }),
    ev({ id: 'd3', content: '用户偏好 TypeScript' }),
  ], { query: '语言偏好', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 2)
  assert.equal(r.items[0].content, '用户偏好 TypeScript')
})

test('T2 contentHash dedup：同 content 保留 utility 最高的一条', () => {
  const r = compose([
    ev({ id: 'u1', content: '用户偏好 TypeScript', confidence: 0.3 }),
    ev({ id: 'u2', content: '用户偏好 TypeScript', confidence: 0.9 }),
  ], { query: '语言偏好', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'u2') // confidence 高 → utility 高
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 1)
  assert.equal(r.dropped.find((d) => d.reason === 'duplicate-content').id, 'u1')
})

test('T2 contentHash dedup：显式 contentHash 优先于内容计算', () => {
  const r = compose([
    ev({ id: 'h1', content: '内容 A', contentHash: 'same-hash' }),
    ev({ id: 'h2', content: '内容 B', contentHash: 'same-hash' }),
  ], { query: '查询', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 1)
})