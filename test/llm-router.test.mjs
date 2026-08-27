// test/llm-router.test.mjs — LLM 任务路由（M3 A2）：路由解析 / fallback 链 / 全失败。
// 沿用 M2 范式：llm.stream + purpose:'compaction' + BlockAssembler（mock llm 产真实 chunk 形状）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmRouter, callLlmText } from '../src/providers/llm-router.mjs'

/** 成功流：text 块 + stop finish */
async function* okStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 失败流：stream 直接抛错（网络/服务故障） */
async function* throwingStream() {
  throw new Error('provider connection refused')
  yield 0 // unreachable
}

/** 失败流：finish 非 stop（error 终态，无文本） */
async function* errorFinishStream() {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY' } } }
}

/** 记录每次 stream 调用的 provider/model */
function recordingLlm(streamImpl) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push({ provider: options.provider, model: options.model, purpose: options.purpose })
      return streamImpl()
    },
  }
}

test('路由解析：getRoute 返回主路由，未配置任务返回 null，chainFor 含 fallback', () => {
  const router = createLlmRouter({
    tasks: {
      consolidation: {
        provider: 'deepseek', model: 'chat',
        fallback: [{ provider: 'openai', model: 'gpt-x' }],
        timeoutMs: 1000, maxTokens: 512,
      },
    },
  })
  const route = router.getRoute('consolidation')
  assert.equal(route.provider, 'deepseek')
  assert.equal(route.model, 'chat')
  assert.equal(router.getRoute('reflect'), null)
  const chain = router.chainFor('consolidation')
  assert.equal(chain.length, 2)
  assert.equal(chain[1].provider, 'openai')
})

test('主路由成功：callFor 返回文本，llm.stream 收到正确路由参数', async () => {
  const llm = recordingLlm(() => okStream('{"observations":[]}'))
  const router = createLlmRouter({
    tasks: { consolidation: { provider: 'deepseek', model: 'chat', timeoutMs: 1000, maxTokens: 256 } },
    resolveLlm: () => llm,
  })
  const text = await router.callFor('consolidation', 'user text', 'system text')
  assert.equal(text, '{"observations":[]}')
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'deepseek')
  assert.equal(llm.calls[0].model, 'chat')
  assert.equal(llm.calls[0].purpose, 'compaction') // GenerateOptions 联合类型约束
})

test('fallback 链：主路由抛错 → fallback 成功', async () => {
  let n = 0
  const llm = recordingLlm(() => {
    n += 1
    return n === 1 ? throwingStream() : okStream('fallback 结果')
  })
  const router = createLlmRouter({
    tasks: {
      consolidation: {
        provider: 'deepseek', model: 'chat',
        fallback: [{ provider: 'openai', model: 'gpt-x' }],
      },
    },
    resolveLlm: () => llm,
  })
  const text = await router.callFor('consolidation', 'u', 's')
  assert.equal(text, 'fallback 结果')
  assert.equal(llm.calls.length, 2, '主路由失败后尝试 fallback')
  assert.equal(llm.calls[0].provider, 'deepseek')
  assert.equal(llm.calls[1].provider, 'openai')
})

test('fallback 链：主路由空输出（finish 非 stop）→ fallback 成功', async () => {
  let n = 0
  const llm = recordingLlm(() => {
    n += 1
    return n === 1 ? errorFinishStream() : okStream('兜底输出')
  })
  const router = createLlmRouter({
    tasks: {
      consolidation: {
        provider: 'deepseek', model: 'chat',
        fallback: [{ provider: 'openai', model: 'gpt-x' }],
      },
    },
    resolveLlm: () => llm,
  })
  const text = await router.callFor('consolidation', 'u', 's')
  assert.equal(text, '兜底输出')
  assert.equal(llm.calls.length, 2)
})

test('全失败：主路由 + fallback 都抛错 → callFor reject', async () => {
  const llm = recordingLlm(() => throwingStream())
  const router = createLlmRouter({
    tasks: {
      consolidation: {
        provider: 'deepseek', model: 'chat',
        fallback: [{ provider: 'openai', model: 'gpt-x' }],
      },
    },
    resolveLlm: () => llm,
  })
  await assert.rejects(
    router.callFor('consolidation', 'u', 's'),
    /all routes failed/,
  )
  assert.equal(llm.calls.length, 2)
})

test('llm 服务缺失 → callFor reject（调用方 buildLlmCall 返回 null 走规则兜底）', async () => {
  const router = createLlmRouter({
    tasks: { consolidation: { provider: 'deepseek', model: 'chat' } },
    resolveLlm: () => undefined,
  })
  await assert.rejects(
    router.callFor('consolidation', 'u', 's'),
    /llm service unavailable/,
  )
})

test('task 未配置路由 → callFor reject', async () => {
  const router = createLlmRouter({
    tasks: { consolidation: { provider: 'deepseek', model: 'chat' } },
    resolveLlm: () => recordingLlm(() => okStream('x')),
  })
  await assert.rejects(
    router.callFor('reflect', 'u', 's'),
    /has no route/,
  )
})

test('callLlmText 直接调用：空文本输出 → 抛错', async () => {
  const llm = recordingLlm(() => errorFinishStream())
  await assert.rejects(
    callLlmText(llm, { provider: 'deepseek', model: 'chat' }, 'u', 's'),
    /produced no text|finished with/,
  )
})
