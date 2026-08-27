// test/providers.test.mjs — MemOS adapter 测试（mock fetch）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemosProvider } from '../src/providers/memos.mjs'
import { createProviderRegistry } from '../src/providers/registry.mjs'
import { isValidRecallCandidate } from '../src/providers/recall-contract.mjs'
import { normalizeMemosHits, normalizeRecallHits } from '../src/index.mjs'
import { compose } from '../src/composer.mjs'

test('recall 成功：归一化为 RecallCandidate', async (t) => {
  // mock fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    assert.ok(url.includes('/api/v1/memory/search'))
    const body = JSON.parse(opts.body)
    assert.equal(body.query, 'pnpm')
    return {
      ok: true,
      json: async () => ({
        hits: [
          { tier: 1, refId: 't-1', refKind: 'trace', score: 0.9, snippet: '项目用 pnpm' },
          { tier: 2, refId: 'e-1', refKind: 'episode', score: 0.6, snippet: 'yarn 迁移记录' },
        ],
        injectedContext: '', tierLatencyMs: {},
      }),
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const provider = createMemosProvider({ baseUrl: 'http://127.0.0.1:18801', timeoutMs: 100 })
  const hits = await provider.recall({ text: 'pnpm', limit: 5 })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].id, 'memos:trace:t-1')
  assert.equal(hits[0].content, '项目用 pnpm')
  assert.equal(hits[0].sourceProvider, 'memos')
  assert.ok(isValidRecallCandidate(hits[0]))
})

test('recall fail-open：Provider 宕机返回 []', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('connection refused') }
  t.after(() => { globalThis.fetch = originalFetch })

  const provider = createMemosProvider({ baseUrl: 'http://127.0.0.1:18801', timeoutMs: 100 })
  const hits = await provider.recall({ text: 'x' })
  assert.deepEqual(hits, [])
})

test('recall 超时 fail-open', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    // 尊重 abort signal
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const provider = createMemosProvider({ baseUrl: 'http://127.0.0.1:18801', timeoutMs: 50 })
  const hits = await provider.recall({ text: 'slow' })
  assert.deepEqual(hits, [])
})

test('recall 尊重外部 AbortSignal', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const provider = createMemosProvider({ baseUrl: 'http://127.0.0.1:18801', timeoutMs: 5000 })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 30)
  const hits = await provider.recall({ text: 'cancel' }, ac.signal)
  assert.deepEqual(hits, [])
})

test('无效候选被过滤', () => {
  assert.equal(isValidRecallCandidate({ id: 'a', content: 'x', score: 0.5, sourceProvider: 'm' }), true)
  assert.equal(isValidRecallCandidate({ id: '', content: 'x', score: 0.5, sourceProvider: 'm' }), false)
  assert.equal(isValidRecallCandidate({ id: 'a', content: '', score: 0.5, sourceProvider: 'm' }), false)
  assert.equal(isValidRecallCandidate(null), false)
})

// —— T3：memos-provider 接入 composer（P0-3）——

test('provider 候选归一化：RecallCandidate → composer 候选（T3）', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      hits: [{ tier: 3, refId: 'e-9', refKind: 'episode', score: 0.42, snippet: '某次 pnpm 安装卡住' }],
    }),
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const provider = createMemosProvider({ baseUrl: 'http://127.0.0.1:18801', timeoutMs: 100 })
  const hits = await provider.recall({ text: 'pnpm', limit: 5 })
  const c = normalizeMemosHits(hits, 'user-global')[0]

  assert.equal(c.id, 'memos:episode:e-9')        // 防双前缀：provider id 已带 memos:
  assert.equal(c.content, '某次 pnpm 安装卡住')
  assert.equal(c.score, 0.42)
  assert.equal(c.providerScore, 0.42)            // semantic 分量来源（compose hasProvider=true 时用）
  assert.equal(c.sourceProvider, 'memos')
  assert.equal(c.claimDomain, 'experience')      // untrusted historical data
  assert.equal(c.state, 'active')                // readGuard 放行
  assert.equal(c.scopeId, 'user-global')
  assert.equal(c.confidence, 0.5)                // 最低置信度，不宣称权威

  // 无 'memos:' 前缀的 id 补前缀；非数组输入 → []
  assert.equal(normalizeMemosHits([{ id: 'raw-1', content: 'x', score: 0.1, sourceProvider: 'memos' }], 'user-global')[0].id, 'memos:raw-1')
  assert.deepEqual(normalizeMemosHits(null, 'user-global'), [])
})

test('compose 集成：hasProvider=true 时 MemOS providerScore 参与排序（T3）', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      hits: [{ tier: 1, refId: 't-1', refKind: 'trace', score: 0.9, snippet: '项目用 pnpm 管理依赖' }],
    }),
  })
  t.after(() => { globalThis.fetch = originalFetch })

  // mock createMemosProvider 路径：recall → 归一化 → compose（与 index.mjs pre-step 相同装配）
  const provider = createMemosProvider({ baseUrl: 'http://127.0.0.1:18801', timeoutMs: 100 })
  const hits = await provider.recall({ text: 'pnpm', limit: 5 })
  const memoCandidates = normalizeMemosHits(hits, 'user-global')

  // ledger 候选：lexical 强命中但无 providerScore（semantic=0）
  const ledgerCandidates = [{
    id: 'ev_ledger_1',
    content: '用户偏好 pnpm 而非 yarn',
    claimDomain: 'user_preference',
    state: 'active',
    scopeId: 'user-global',
    authority: 'user_explicit',
    confidence: 0.9,
  }]

  const both = [...ledgerCandidates, ...memoCandidates]
  // query 用无语义包含的词，避免 self-echo 过滤干扰（content 包含 query 会被排除）
  const query = { query: '工具链选择', scopeId: 'user-global', targetDomain: 'work', maxTokens: 900 }

  // hasProvider=true：semantic 分量 0.32×providerScore 生效，memos 候选排第一
  const withProvider = compose(both, { ...query, hasProvider: true })
  assert.equal(withProvider.items.length, 2, '两个候选都 admitted')
  assert.equal(withProvider.items[0].id, 'memos:trace:t-1', 'providerScore 推高 memos 候选')
  const mi = withProvider.items.find((i) => i.id === 'memos:trace:t-1')
  assert.ok(mi.providerScore === 0.9 && mi.utility > 0.3, 'providerScore 参与 utility 计算')

  // 对照 hasProvider=false：semantic 并入 lexical（0.50 权重），无 providerScore 的 ledger 候选反超
  const withoutProvider = compose(both, { ...query, hasProvider: false })
  assert.equal(withoutProvider.items[0].id, 'ev_ledger_1', '无 Provider 时 lexical 主导')
})

// ===================== M3 A1：Provider Registry（多源召回） =====================

test('registry 缺省：无 recallProviders → 自动构造默认 memos 项（向后兼容）', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      hits: [{ tier: 1, refId: 't-1', refKind: 'trace', score: 0.7, snippet: '默认 memos 项召回' }],
    }),
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const registry = createProviderRegistry({
    defaults: { memosBaseUrl: 'http://127.0.0.1:18801', memosEnabled: true },
  })
  const providers = registry.listRecallProviders()
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'memos')
  assert.equal(providers[0].kind, 'recall')
  assert.equal(providers[0].enabled, true)
  assert.equal(providers[0].weight, 1) // 缺省权重 1.0
  assert.ok(providers[0].timeoutMs > 0)

  const hits = await registry.recallAll({ text: '默认', limit: 5 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sourceProvider, 'memos')
  assert.equal(hits[0].content, '默认 memos 项召回')
})

test('registry 缺省但 memosEnabled=false → 无启用 provider，recallAll 返回 []', async () => {
  const registry = createProviderRegistry({
    defaults: { memosBaseUrl: 'http://127.0.0.1:18801', memosEnabled: false },
  })
  assert.equal(registry.listRecallProviders().length, 0)
  assert.deepEqual(await registry.recallAll({ text: 'x' }), [])
})

test('registry 显式 [] → 不启用任何 provider（区别于缺省）', async () => {
  const registry = createProviderRegistry({ recallProviders: [], defaults: { memosEnabled: true } })
  assert.equal(registry.listRecallProviders().length, 0)
  assert.deepEqual(await registry.recallAll({ text: 'x' }), [])
})

test('registry 双 provider：并行召回合并，sourceProvider 按描述符 id 打标', async () => {
  const seen = []
  const registry = createProviderRegistry({
    recallProviders: [
      { id: 'alpha', enabled: true, timeoutMs: 100, weight: 2, create: () => ({
        recall: async (query, signal) => {
          seen.push('alpha')
          assert.ok(signal instanceof AbortSignal)
          assert.equal(query.text, 'pnpm')
          assert.equal(query.limit, 5)
          return [{ id: 'a-1', content: 'alpha 记忆', score: 0.9, sourceProvider: 'alpha' }]
        },
      }) },
      { id: 'beta', enabled: true, timeoutMs: 100, weight: 0.5, create: () => ({
        recall: async () => {
          seen.push('beta')
          return [{ id: 'b-1', content: 'beta 记忆', score: 0.5, sourceProvider: 'beta' }]
        },
      }) },
    ],
  })

  const providers = registry.listRecallProviders()
  assert.equal(providers.length, 2)
  assert.equal(providers[0].weight, 2)
  assert.equal(providers[1].weight, 0.5)

  const hits = await registry.recallAll({ text: 'pnpm', limit: 5 })
  assert.deepEqual(seen.sort(), ['alpha', 'beta']) // 并行（都触发）
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map((h) => h.sourceProvider).sort(), ['alpha', 'beta'])
  // 即使 provider 自带 sourceProvider，也以描述符 id 为准
  assert.equal(hits.find((h) => h.id === 'a-1').sourceProvider, 'alpha')
})

test('registry 禁用任一 → 另一正常召回', async () => {
  const registry = createProviderRegistry({
    recallProviders: [
      { id: 'alpha', enabled: false, create: () => ({ recall: async () => [{ id: 'a', content: 'x', score: 1, sourceProvider: 'alpha' }] }) },
      { id: 'beta', enabled: true, create: () => ({ recall: async () => [{ id: 'b', content: 'y', score: 1, sourceProvider: 'beta' }] }) },
    ],
  })
  assert.equal(registry.listRecallProviders().length, 1)
  assert.equal(registry.listRecallProviders()[0].id, 'beta')
  const hits = await registry.recallAll({ text: 'x' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sourceProvider, 'beta')
})

test('registry 全部禁用 → recallAll 返回 []', async () => {
  const registry = createProviderRegistry({
    recallProviders: [
      { id: 'alpha', enabled: false, create: () => ({ recall: async () => [{ id: 'a', content: 'x', score: 1, sourceProvider: 'alpha' }] }) },
      { id: 'beta', enabled: false, create: () => ({ recall: async () => [{ id: 'b', content: 'y', score: 1, sourceProvider: 'beta' }] }) },
    ],
  })
  assert.equal(registry.listRecallProviders().length, 0)
  assert.deepEqual(await registry.recallAll({ text: 'x' }), [])
})

test('registry fail-open：单 provider 抛错不阻断另一 provider', async () => {
  const registry = createProviderRegistry({
    recallProviders: [
      { id: 'alpha', timeoutMs: 100, create: () => ({ recall: async () => { throw new Error('boom') } }) },
      { id: 'beta', timeoutMs: 100, create: () => ({ recall: async () => [{ id: 'b', content: 'beta 正常', score: 0.6, sourceProvider: 'beta' }] }) },
    ],
  })
  const hits = await registry.recallAll({ text: 'x' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sourceProvider, 'beta')
})

test('registry fail-open：单 provider 超时（挂起）不阻断另一 provider', async () => {
  const registry = createProviderRegistry({
    recallProviders: [
      { id: 'alpha', timeoutMs: 30, create: () => ({ recall: () => new Promise(() => {}) }) }, // 永不 resolve
      { id: 'beta', timeoutMs: 100, create: () => ({ recall: async () => [{ id: 'b', content: 'beta 及时', score: 0.6, sourceProvider: 'beta' }] }) },
    ],
  })
  const started = Date.now()
  const hits = await registry.recallAll({ text: 'x' })
  assert.ok(Date.now() - started < 200, '不被挂起的 provider 拖住')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sourceProvider, 'beta')
})

test('registry 集成：recallAll → normalizeRecallHits → compose 多源融合（A3 装配）', async () => {
  const registry = createProviderRegistry({
    recallProviders: [
      { id: 'alpha', weight: 1, create: () => ({ recall: async () => [{ id: 'a-1', content: 'alpha 记忆片段甲', score: 0.9, sourceProvider: 'alpha' }] }) },
      { id: 'beta', weight: 3, create: () => ({ recall: async () => [{ id: 'b-1', content: 'beta 记忆片段乙', score: 0.3, sourceProvider: 'beta' }] }) },
    ],
  })
  const hits = await registry.recallAll({ text: '工具链', limit: 5 })
  const recallCandidates = normalizeRecallHits(hits, 'user-global')
  assert.equal(recallCandidates.length, 2)
  assert.equal(recallCandidates[0].claimDomain, 'experience')
  assert.equal(recallCandidates[0].state, 'active')
  assert.equal(recallCandidates[0].scopeId, 'user-global')

  const providerWeights = Object.fromEntries(registry.listRecallProviders().map((p) => [p.id, p.weight]))
  assert.deepEqual(providerWeights, { alpha: 1, beta: 3 })

  const result = compose(recallCandidates, {
    query: '工具链选择',
    scopeId: 'user-global',
    targetDomain: 'work',
    hasProvider: true,
    providerWeights,
    maxTokens: 900,
  })
  assert.equal(result.items.length, 2)
  // 归一化后 id 带 sourceProvider 前缀（normalizeRecallHits 防跨源 id 冲突）
  assert.equal(recallCandidates[0].id, 'alpha:a-1')
  assert.equal(recallCandidates[1].id, 'beta:b-1')
  // beta 归一化后 1.0 × 3 → semantic 分量压过 alpha（0.9→1.0 × 1）
  assert.equal(result.items[0].id, 'beta:b-1')
})

