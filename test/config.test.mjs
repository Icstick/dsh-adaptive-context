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
      crossSessionPolicy: 'non-instructional',
      subagentDowngrade: true,
      debug: false,
      memosBaseUrl: 'http://127.0.0.1:18801',
      memosEnabled: true,
      startupRebuild: true,
      autoPromote: false,
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
test('mergeSettingsIntoConfig：settings 文档覆盖 Config（仅提供已配置字段）', async () => {
  const { mergeSettingsIntoConfig } = await import('../src/index.mjs')
  const ctx = { get: () => ({ get: () => ({ hotTokens: 500, crossSessionPolicy: 'all' }) }) }
  const merged = mergeSettingsIntoConfig(ctx, { hotTokens: 300, recallLimit: 20, debug: false })
  assert.equal(merged.hotTokens, 500)
  assert.equal(merged.crossSessionPolicy, 'all')
  assert.equal(merged.recallLimit, 20) // settings 未提供 → Config 保留
  assert.equal(merged.debug, false)
})

test('mergeSettingsIntoConfig：settings 服务缺失/无 namespace → 原样返回 Config', async () => {
  const { mergeSettingsIntoConfig } = await import('../src/index.mjs')
  const noService = { get: () => undefined }
  const noSection = { get: () => ({ get: () => null }) }
  const config = { hotTokens: 300, recallLimit: 20 }
  assert.deepEqual(mergeSettingsIntoConfig(noService, config), config)
  assert.deepEqual(mergeSettingsIntoConfig(noSection, config), config)
  // 不修改原对象
  assert.equal(Object.keys(config).length, 2)
})

test('mergeSettingsIntoConfig：settings 值为 null/undefined 时不覆盖', async () => {
  const { mergeSettingsIntoConfig } = await import('../src/index.mjs')
  const ctx = { get: () => ({ get: () => ({ hotTokens: null, debug: undefined, recallLimit: 50 }) }) }
  const merged = mergeSettingsIntoConfig(ctx, { hotTokens: 300, recallLimit: 20, debug: true })
  assert.equal(merged.hotTokens, 300)
  assert.equal(merged.debug, true)
  assert.equal(merged.recallLimit, 50)
})


