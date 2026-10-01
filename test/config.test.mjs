import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, unwrapVolatileConfig } from '../src/index.mjs'

test('plugin config validates defaults through Standard Schema', async () => {
  const result = await Config['~standard'].validate({})

  // 0.1.7：Config 字段带 .volatile()（插件页表单要）—— schema 产出的是 cosmokit 响应式引用，
  // 断言前先解包；无默认值的字段解包后是 undefined，去掉这些空键再比对。
  const plain = unwrapVolatileConfig(result.value)
  for (const key of Object.keys(plain)) if (plain[key] === undefined) delete plain[key]

  assert.deepEqual({ value: plain }, {
    value: {
      hotTokens: 900, // 2026-09-02：对齐 MVP_TOTAL_BUDGET（此前 300 但 composer 从不读取＝死配置）
      recallLimit: 20,
      targetDomain: 'work',
      crossSessionPolicy: 'non-instructional',
      fusion: 'weighted', // 2026-09-09：默认加权求和；rrf 为可选融合策略
      subagentDowngrade: true,
      debug: false,
      // 2026-10-01：memosBaseUrl/memosEnabled 退场——缺省不再造默认 memos 项
      // （recallProviders 缺省 = 无 provider），字段与默认值一并删除。
      recallProviders: [], // 缺省归一为 []（schemastery 数组语义），等于「无 provider」
      startupRebuild: true,
      autoPromote: false,
      observationInjection: false, // 2026-09-02：observation 注入已接线但默认冻结
      observationAuthorities: ['user_explicit', 'user_correction'], // T2 2026-09-07：权威闸门白名单
      preferenceEphemeralFilter: 'shadow', // 阶段 2.3 2026-09-09：默认只统计不生效
      observationHalfLifeDays: 30, // 2026-09-12：observation 时间衰减半衰期（0=关闭）
      injectionHysteresis: 0.2, // 2026-09-12：C3 注入滞回（0=关闭）
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

test('plugin config: absent recallProviders → []（= 无 provider，2026-10-01 变更）', async () => {
  const result = await Config['~standard'].validate({})
  // 旧行为：recallProviders 用 z.any() 透传，缺省保持 absent，由 registry 造默认 memos 项。
  // 新行为：缺省归一为 []，registry 侧即「无 provider」——absent 与显式 [] 等价。
  assert.deepEqual(unwrapVolatileConfig(result.value).recallProviders, [])
  assert.equal('llmTasks' in result.value, false) // llmTasks 仍是可选透传，语义未变
})

test('plugin config: explicit [] 与缺省等价（无 provider）', async () => {
  const absent = unwrapVolatileConfig((await Config['~standard'].validate({})).value)
  const empty = unwrapVolatileConfig((await Config['~standard'].validate({ recallProviders: [] })).value)
  assert.deepEqual(absent.recallProviders, empty.recallProviders)
  assert.deepEqual(absent.recallProviders, [])
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


