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
  const r = compose(cands, { query: '测试', scopeId: 'user-global' })
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