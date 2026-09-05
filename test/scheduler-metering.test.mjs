// test/scheduler-metering.test.mjs — S1 P7（B9 v0.3）：注入调度器接线（方案 A 主动上报）。
// 契约：调度器是可选依赖——缺失/故障必须 fail-open，绝不阻断 ACP 注入与 turn；
// 上报 = 注入文本生成后记录实际字符（body.length，字符级精确）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACP_SECTION_KEY,
  registerAcpSection,
  reportInjectionToScheduler,
} from '../src/index.mjs'

/** mock ctx：get 返回 services（'injectScheduler' 缺省 undefined）+ on 收集 internal/service 订阅 */
function mockCtx(services = {}, handlers = []) {
  return {
    get: (name) => services[name] ?? undefined,
    on: (event, fn) => { if (event === 'internal/service') handlers.push(fn); return () => {} },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
}

/** fake scheduler：收集 registerSection/recordUsage 调用 */
function fakeScheduler(overrides = {}) {
  const calls = { sections: [], usage: [] }
  const api = {
    calls,
    registerSection: async (input) => { calls.sections.push(input); return { ok: true, key: input.key } },
    recordUsage: async (input) => { calls.usage.push(input); return { ok: true, key: 'k', total: input.injectedChars, count: 1 } },
    ...overrides,
  }
  return api
}

test('S1 P7 registerAcpSection：scheduler 就绪即注册（参数契约：order 10/tokens/hotTokens 透传）', (t) => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  registerAcpSection(ctx, { hotTokens: 1600 })
  assert.equal(sched.calls.sections.length, 1)
  const reg = sched.calls.sections[0]
  assert.deepEqual(reg, {
    key: ACP_SECTION_KEY,
    plugin: 'dsh-adaptive-context',
    order: 10,
    budgetChars: 1600,        // config.hotTokens 透传
    unit: 'tokens',           // ACP 配额是 token 口径
    refresh: 'per-turn',      // 每轮注入
  })
})

test('S1 P7 registerAcpSection：缺省 hotTokens → 900（Config 默认）', (t) => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  registerAcpSection(ctx, {})
  assert.equal(sched.calls.sections[0].budgetChars, 900)
})

test('S1 P7 registerAcpSection：scheduler 未就绪 → 订阅 internal/service，就绪事件到达后注册', (t) => {
  const handlers = []
  let sched = null
  const services = {}
  const ctx = mockCtx(services, handlers)
  // get 动态读 services（事件到达后注入）
  ctx.get = (name) => services[name] ?? undefined
  registerAcpSection(ctx, { hotTokens: 1600 })
  assert.equal(handlers.length, 1, '应订阅 internal/service')
  // 模拟 scheduler 稍后装载：服务出现 + 事件广播
  services.injectScheduler = fakeScheduler()
  handlers[0]('injectScheduler')
  assert.equal(services.injectScheduler.calls.sections.length, 1, '就绪事件后应完成注册')
  assert.equal(services.injectScheduler.calls.sections[0].key, 'acp.composer')
})

test('S1 P7 registerAcpSection：scheduler 从未出现 → 静默（不抛、无注册）', () => {
  const ctx = mockCtx({}, [])
  assert.doesNotThrow(() => registerAcpSection(ctx, {}))
})

test('S1 P7 reportInjectionToScheduler：注入后上报 body 实际字符', async (t) => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  const body = '用户偏好：中文交流，先结论后理由。'
  reportInjectionToScheduler(ctx, 'session-1', body)
  await new Promise((r) => setTimeout(r, 5)) // fire-and-forget 落定
  assert.equal(sched.calls.usage.length, 1)
  assert.deepEqual(sched.calls.usage[0], {
    sessionId: 'session-1',
    section: ACP_SECTION_KEY,
    injectedChars: body.length,
  })
})

test('S1 P7 reportInjectionToScheduler：空 sessionId → 不传（落 global 槽）', async (t) => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  reportInjectionToScheduler(ctx, '', '无会话上下文')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sched.calls.usage.length, 1)
  const call = sched.calls.usage[0]
  assert.equal(Object.hasOwn(call, 'sessionId'), false)
  assert.equal(call.injectedChars, '无会话上下文'.length)
})

test('S1 P7 reportInjectionToScheduler：空 body 不报', async (t) => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  reportInjectionToScheduler(ctx, 'session-1', '')
  reportInjectionToScheduler(ctx, 'session-1', null)
  reportInjectionToScheduler(ctx, 'session-1', undefined)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sched.calls.usage.length, 0)
})

test('S1 P7 reportInjectionToScheduler：scheduler 缺失 → 静默降级', async (t) => {
  const ctx = mockCtx({})
  assert.doesNotThrow(() => reportInjectionToScheduler(ctx, 'session-1', '有内容'))
  await new Promise((r) => setTimeout(r, 5))
})

test('S1 P7 reportInjectionToScheduler：recordUsage 故障（reject）→ 不阻断（fail-open）', async (t) => {
  const sched = fakeScheduler({
    recordUsage: async () => { throw new Error('storage down') },
  })
  const ctx = mockCtx({ injectScheduler: sched })
  assert.doesNotThrow(() => reportInjectionToScheduler(ctx, 'session-1', '内容'))
  await new Promise((r) => setTimeout(r, 5))
})
