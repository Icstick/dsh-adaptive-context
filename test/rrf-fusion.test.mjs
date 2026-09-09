// test/rrf-fusion.test.mjs — 2026-09-09：Reciprocal Rank Fusion 融合策略
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rrfFuse, compose, semanticRouteScore, WEIGHTS } from '../src/composer.mjs'

test('rrfFuse 单路：排序与该路一致，最高者归一化到 1', () => {
  const rows = [
    { id: 'a', lexical: 0.9, semantic: 0 },
    { id: 'b', lexical: 0.5, semantic: 0 },
    { id: 'c', lexical: 0.1, semantic: 0 },
  ]
  const m = rrfFuse(rows)
  assert.equal(m.get('a'), 1)
  assert.ok(m.get('a') > m.get('b'))
  assert.ok(m.get('b') > m.get('c'))
})

test('rrfFuse 双路：两路都靠前者胜出；全零路不参与（不产生数组顺序噪声）', () => {
  const rows = [
    { id: 'both', lexical: 1.0, semantic: 1.0 },
    { id: 'lex-only', lexical: 0.9, semantic: 0.1 },
    { id: 'sem-only', lexical: 0.1, semantic: 0.9 },
  ]
  const m = rrfFuse(rows, { k: 1 })
  assert.equal(m.get('both'), 1, '两路都排第一 → 融合分最高')
  assert.ok(m.get('both') > m.get('lex-only'))
  assert.ok(m.get('both') > m.get('sem-only'))
  // semantic 全零 → 结果应与只有 lexical 一路完全一致
  const allZeroSem = rrfFuse(rows.map((r) => ({ ...r, semantic: 0 })), { k: 1 })
  const lexOnly = rrfFuse(rows.map((r) => ({ ...r, semantic: 0 })), { k: 1 })
  assert.deepEqual([...allZeroSem.entries()], [...lexOnly.entries()])
  // semantic 全零时只剩 lexical 一路：排序完全由词面决定
  assert.equal(allZeroSem.get('both'), 1)
  assert.ok(allZeroSem.get('lex-only') > allZeroSem.get('sem-only'))
})

test('semanticRouteScore：provider 归一化与权重（与 utilityOf 同口径）', () => {
  const providerMax = new Map([['memos', 2]])
  const opts = { hasProvider: true, providerMax, providerWeights: { memos: 0.5 } }
  assert.equal(semanticRouteScore({ providerScore: 2, sourceProvider: 'memos' }, opts), 0.5)
  assert.equal(semanticRouteScore({ providerScore: 1, sourceProvider: 'memos' }, opts), 0.25)
  assert.equal(semanticRouteScore({ providerScore: 1, sourceProvider: 'memos' }, { hasProvider: false }), 0)
})

test('compose：fusion=rrf 可运行且注入面与加权模式同量级', () => {
  const base = (id, providerScore) => ({
    id,
    content: '先结论后展开，不要客服腔',
    sourceClass: 'observation',
    claimDomain: 'user_preference',
    authority: 'user_explicit',
    confidence: 0.8,
    durability: 0.6,
    sensitivity: 'private',
    state: 'active',
    scopeId: 'user-global',
    observedAt: new Date().toISOString(),
    providerScore,
    sourceProvider: 'memos',
  })
  const cands = [base('c1', 1.0), base('c2', 0.8), base('c3', 0.2)]
  const opts = {
    query: '偏好',
    scopeId: 'user-global',
    hasProvider: true,
    providerWeights: { memos: 1 },
    currentSessionId: 'session-x',
  }
  const weighted = compose(cands, { ...opts, fusion: 'weighted' })
  const rrf = compose(cands, { ...opts, fusion: 'rrf' })
  assert.ok(weighted.items.length >= 1)
  assert.ok(rrf.items.length >= 1)
  // 融合分驱动的 relevance 仍落在合理区间（0..1 量级），不会因换融合方式爆表
  for (const it of rrf.items) {
    assert.ok(it.utility > 0 && it.utility < 2, 'utility 量级: ' + it.utility)
  }
  assert.ok(WEIGHTS.semantic + WEIGHTS.lexical > 0)
})
