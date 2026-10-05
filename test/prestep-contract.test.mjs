// test/prestep-contract.test.mjs — agent/pre-step 护栏（事件纪律 P1，2026-10-02）
// ---------------------------------------------------------------------------
// 为什么要有这个文件：agent/pre-step 是 cordis **waterfall**——
//   · handler 不调 next() 即否决（下游客全不跑）；
//   · 但调了 next() 之后**必须**返回合法决策（{kind:'reject'} | {kind:'enter', messages}），
//     返回 undefined 会破坏整条链（上游拿不到决策）。
//   本仓 handler（src/index.mjs:542-763）有 3 条 early-return
//   （step!==1 / 下游非 enter / 候选为空）+ 1 条 fail-open catch，
//   此前**没有一条测试钉住**「每条 return 路径都返回合法决策」。
//   本文件补上：遍历每条 return 路径，断言三件——
//     ① 返回值是合法 PreStepDecision（**绝不是 undefined**）；
//     ② next 被调用过（不得跳过下游）；
//     ③ handler 不抛（fail-open）。
//
// 契约原文（本仓）：src/index.mjs:536-541（handler 必须返回 PreStepDecision，fail-open）
// waterfall 语义（上游）：@deepseek-ai/cordis src/events.ts:234-243（不调 next 即否决）
//
// 只驱动 apply() 的接线层，**不改产品代码**；temp 目录外不写任何东西
// （rulesDir/viewsDir 显式指到 tmp，避免测试动到 ~/.dsh/rules 与 ~/.dsh/acp）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.mjs'

/** 最小 fake ctx：够 apply() 走完装配（照 test/ingest-wiring.test.mjs 的写法） */
function makeCtx() {
  const handlers = new Map()
  const services = {}
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    provide: (name, value) => { services[name] = value },
    tools: { register: () => {} },
    inject: () => {},       // settings 服务不存在 → 不触发回调
    effect: (fn) => { disposers.push(fn) },
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
  }
  const disposeAll = () => {
    for (const d of disposers) {
      const f = d()
      if (typeof f === 'function') f()
    }
  }
  return { ctx, handlers, services, disposeAll }
}

/**
 * 合法 PreStepDecision 判定（本仓契约）：{kind:'reject'} 无 messages 要求；
 * {kind:'enter'} 必须带数组 messages。undefined / null / 裸对象一律不算。
 */
function isPreStepDecision(v) {
  if (!v || typeof v !== 'object') return false
  if (v.kind === 'reject') return true
  return v.kind === 'enter' && Array.isArray(v.messages)
}

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** 起一个跑在 tmp 里的 ACP；返回 pre-step handler 与摄入口（extra 覆盖 Config） */
function boot(t, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-prestep-'))
  const { ctx, handlers, disposeAll } = makeCtx()
  t.after(() => { disposeAll(); rmSync(dir, { recursive: true, force: true }) })
  // 注意：apply() **不会**套用 Config 的 schema 默认值（那是宿主做的）——
  // 直调用例自己补齐需要的键（同 test/ingest-wiring.test.mjs 的纪律）。
  apply(ctx, {
    ledgerDir: path.join(dir, 'ledger'),
    rulesDir: path.join(dir, 'rules'),
    viewsDir: path.join(dir, 'views'),
    observationInjection: false,
    startupRebuild: false,
    recallProviders: [],
    ...extra,
  })
  const pre = (handlers.get('agent/pre-step') ?? [])[0]
  assert.equal(typeof pre, 'function', 'apply 必须注册 agent/pre-step handler')
  /** 走摄入链落一条 active 证据（走公开事件口，不直写账本） */
  const emit = (session, event) => { for (const fn of handlers.get('session/event') ?? []) fn(session, event) }
  return { pre, emit }
}

/**
 * 驱动 handler：stub next 返回 downstream（或抛 throwsError），记录调用次数。
 * 返回值恒为 { result, nextCalls, sameRef }——handler 若抛错，测试直接红（不允许）。
 */
async function drive(pre, payload, { downstream, throwsError } = {}) {
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    if (throwsError) throw throwsError
    return downstream
  }
  const result = await pre(payload, next)
  return { result, nextCalls, sameRef: result === downstream }
}

const SESSION = { id: 'sess-guard', header: {} }
const stepPayload = (step) => ({ step, agent: { session: SESSION } })
const baseDecision = () => ({ kind: 'enter', messages: [userMsg('这个先放一放，我们看别的')] })

// ---- 护栏自检：判定函数本身不吃非法值（否则下面的断言会静默失效） ----

test('护栏自检：isPreStepDecision 不吃 undefined / null / 裸对象', () => {
  assert.equal(isPreStepDecision(undefined), false)
  assert.equal(isPreStepDecision(null), false)
  assert.equal(isPreStepDecision({}), false)
  assert.equal(isPreStepDecision({ kind: 'enter' }), false)          // 缺 messages
  assert.equal(isPreStepDecision({ kind: 'enter', messages: [] }), true)
  assert.equal(isPreStepDecision({ kind: 'reject' }), true)
})

// ---- 分支 1：step !== 1（src/index.mjs:546） ----

test('分支 step!==1：透传下游决策、必调 next、返回合法决策', async (t) => {
  const { pre } = boot(t)
  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(2), { downstream: decision })

  assert.equal(nextCalls, 1, 'next 必须被调用（不得跳过下游）')
  assert.ok(isPreStepDecision(result), '返回值必须是合法 PreStepDecision，实际: ' + JSON.stringify(result))
  assert.equal(sameRef, true, '非首步原样透传（不自造决策对象）')
})

// ---- 分支 2：下游不是 enter（src/index.mjs:547） ----

test('分支 下游 reject：原样透传 reject、必调 next、不注入', async (t) => {
  const { pre } = boot(t)
  const decision = { kind: 'reject' }
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(result.kind, 'reject', '下游否决不得被我方翻成 enter')
  assert.equal(sameRef, true)
})

// ---- 分支 3：下游 enter 但候选为空（src/index.mjs:733） ----

test('分支 候选为空：step1 无候选时原样透传（不发注入消息）', async (t) => {
  const { pre } = boot(t)
  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, true, 'items.length===0 走 early-return，返回同一个决策对象')
  assert.equal(result.messages.length, 1, '不得凭空多出注入消息')
})

// ---- 分支 4：正常注入路径（src/index.mjs:752-756） ----

test('分支 正常注入：账本有候选时追加一条 source-labelled 消息（新决策对象）', async (t) => {
  // skipExternalTool:false —— 本用例测的是 **pre-step 注入契约**（新决策对象 / 消息形状 / 来源标签），
  // 不是「哪些来源该被挡」。而这里的候选**只能**由 tool/result 摄入（→ external_tool），
  // 2026-10-04 加了那道过滤后不覆盖就永远进不去。（审计见 reports/…/SELFDEV-LOG.md 57）
  const { pre, emit } = boot(t, { skipExternalTool: false })
  // 走公开摄入口落一条 active 证据：external_tool → external_fact（非画像域，进 ledger 候选）
  emit(SESSION, { type: 'tool/result', seq: 3, content: '跑完测试：583 passed，0 failed' })

  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, false, '注入路径必须返回**新的**决策对象')
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, decision.messages.length + 1, '下游消息前段原样保留，注入追加在尾部')
  assert.equal(result.messages[0], decision.messages[0], '不得改动下游消息本身')
  const injected = result.messages[result.messages.length - 1]
  assert.equal(injected.source.kind, 'plugin:dsh-adaptive-context', '注入消息必须带来源标签（untrusted 历史上下文）')
  assert.equal(injected.role, 'user')
  assert.match(injected.content[0].text, /\[acp:/, '注入正文带 [acp:…] 标识')
})

// ---- 预算相关分支：plan §P1 列的「预算为 0」 ----

test('分支 预算为 0：hotTokens=0 的语义是「无上限」（不是不注入），注入照常且决策合法', async (t) => {
  // 同上：skipExternalTool:false（本用例测预算语义，候选只能由 tool/result 摄入）
  const { pre, emit } = boot(t, { hotTokens: 0, skipExternalTool: false })
  emit(SESSION, { type: 'tool/result', seq: 5, content: '跑完测试：583 passed，0 failed' })

  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  // src/budget.mjs:128：capTotal = Number.isFinite(totalCap) && totalCap > 0 ? totalCap : Infinity
  // ——「0」在本仓是「不设总上限」的同义词（WC 的 budgetChars=0 同款语义），
  // 所以这里**不该**期待「预算 0 → 不注入」；哪天语义改成 0=关闭，这条会红。
  assert.equal(sameRef, false)
  assert.equal(result.messages.length, decision.messages.length + 1)
})

// ---- fail-open：next() 抛错（src/index.mjs:757-762） ----

test('fail-open：next() 抛错时返回合法空决策，不外抛', async (t) => {
  const { pre } = boot(t)
  const { result, nextCalls } = await drive(pre, stepPayload(1), { throwsError: new Error('downstream boom') })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result), 'fail-open 也必须给合法决策，实际: ' + JSON.stringify(result))
  assert.equal(result.kind, 'enter')
  assert.deepEqual(result.messages, [])
})

test('fail-open：next() 抛错后 step!==1 的路径同样不抛', async (t) => {
  const { pre } = boot(t)
  const { result, nextCalls } = await drive(pre, stepPayload(3), { throwsError: new Error('downstream boom') })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
})

// ---- fail-open：决策已拿到、插件内部抛错（src/index.mjs:760） ----

test('fail-open：拿到下游决策后内部抛错 → 原样返回下游决策（不吞不造）', async (t) => {
  const { pre } = boot(t)
  const decision = baseDecision()
  // session.id 取值即抛：发生在 decision 赋值之后、注入之前
  const boomSession = { get id() { throw new Error('session id boom') }, header: {} }
  const { result, nextCalls, sameRef } = await drive(pre, { step: 1, agent: { session: boomSession } }, { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, true, '已有决策时照原样返回，不落成空决策')
})

// ---- 现状记录（挂账，见 P1 报告）：下游违规返回 undefined 时我方透传 ----

test('现状记录：下游 next() 返回 undefined 时我方透传 undefined（不自造决策）', async (t) => {
  const { pre } = boot(t)
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: undefined })

  assert.equal(nextCalls, 1)
  // 本条**不是**断言“护栏正确”，而是把现状钉住：
  // 我方不校验下游返回值，undefined 会原样透传（链路破坏由违规的下游负责）。
  // 若将来在上游（宿主/前置 listener）加规范化，这条会红 —— 那时同步更新 P1 纪律。
  assert.equal(result, undefined)
  assert.equal(sameRef, true)
  assert.equal(isPreStepDecision(result), false, '现状：此路径不产生合法决策（已挂账）')
})
