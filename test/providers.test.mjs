// test/providers.test.mjs — MemOS adapter 测试（mock fetch）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemosProvider } from '../src/providers/memos.mjs'
import { isValidRecallCandidate } from '../src/providers/recall-contract.mjs'

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
