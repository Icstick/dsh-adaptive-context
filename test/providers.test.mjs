// test/providers.test.mjs — MemOS adapter 测试（mock fetch）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemosProvider } from '../src/providers/memos.mjs'
import { isValidRecallCandidate } from '../src/providers/recall-contract.mjs'
import { normalizeMemosHits } from '../src/index.mjs'
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
  const query = { query: 'pnpm', scopeId: 'user-global', targetDomain: 'work', maxTokens: 900 }

  // hasProvider=true：semantic 分量 0.32×providerScore 生效，memos 候选排第一
  const withProvider = compose(both, { ...query, hasProvider: true })
  assert.equal(withProvider.items.length, 2, '两个候选都 admitted')
  assert.equal(withProvider.items[0].id, 'memos:trace:t-1', 'providerScore 推高 memos 候选')
  const mi = withProvider.items.find((i) => i.id === 'memos:trace:t-1')
  assert.ok(mi.providerScore === 0.9 && mi.utility > 0.4, 'providerScore 参与 utility 计算')

  // 对照 hasProvider=false：semantic 并入 lexical（0.50 权重），无 providerScore 的 ledger 候选反超
  const withoutProvider = compose(both, { ...query, hasProvider: false })
  assert.equal(withoutProvider.items[0].id, 'ev_ledger_1', '无 Provider 时 lexical 主导')
})
