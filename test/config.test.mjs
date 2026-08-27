import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/index.mjs'

test('plugin config validates defaults through Standard Schema', async () => {
  const result = await Config['~standard'].validate({})

  assert.deepEqual(result, {
    value: {
      hotTokens: 300,
      recallLimit: 20,
      targetDomain: 'work',
      debug: false,
      memosBaseUrl: 'http://127.0.0.1:18801',
      memosEnabled: true,
    },
  })
})

test('plugin config rejects an unknown target domain', async () => {
  const result = await Config['~standard'].validate({ targetDomain: 'unknown-domain' })

  assert.ok(result.issues?.length)
})

test('plugin config passes through recallProviders and llmTasks (M3 A1/A2)', async () => {
  const input = {
    recallProviders: [
      { id: 'memos', enabled: true, timeoutMs: 3000, weight: 2, baseUrl: 'http://127.0.0.1:18801' },
      { id: 'other', enabled: false },
    ],
    llmTasks: {
      consolidation: {
        provider: 'deepseek', model: 'chat',
        fallback: [{ provider: 'openai', model: 'gpt-x' }],
        timeoutMs: 5000, maxTokens: 512,
      },
    },
  }
  const result = await Config['~standard'].validate(input)
  assert.deepEqual(result.value.recallProviders, input.recallProviders)
  assert.deepEqual(result.value.llmTasks, input.llmTasks)
})

test('plugin config: absent recallProviders/llmTasks stay absent (backward compat defaults)', async () => {
  const result = await Config['~standard'].validate({})
  assert.equal('recallProviders' in result.value, false)
  assert.equal('llmTasks' in result.value, false)
})

