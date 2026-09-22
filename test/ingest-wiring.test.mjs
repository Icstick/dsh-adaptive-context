// test/ingest-wiring.test.mjs — 摄入链端到端（index.mjs 接线，2026-09-22）
// ------------------------------------------------------------------
// 为什么要有这个文件：仓库里此前**没有**驱动 session/event handler 的用例
// （grep session/event 只命中 src/index.mjs），于是「接线层」的回归只能靠人读代码。
// C/A1/B1 三条改动恰好都落在接线上，所以补一个最小 fake ctx 跑真路径。
//
// 覆盖：
//   A1  assistant/message 不入账；user/message 入账
//   C   子代理会话（header.origin=subagent）落 session_type='subagent'
//   B1  公开服务面直写（未经 ingest 声明）缺省 quarantine
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../src/index.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'

/** 最小 fake ctx：够 apply() 走完装配，不引入任何宿主服务 */
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
  return { ctx, handlers, services, disposeAll: () => { for (const d of disposers) { const f = d(); if (typeof f === 'function') f() } } }
}

test('摄入链端到端：A1 不收 assistant / C 落 subagent / B1 直写缺省隔离', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-wiring-'))
  const { ctx, handlers, services, disposeAll } = makeCtx()
  t.after(() => { disposeAll(); rmSync(dir, { recursive: true, force: true }) })

  // 注意：apply() **不会**套用 Config 的 schema 默认值（那是宿主加载时做的）。
  // 直接驱动 apply() 的用例必须自己把默认值补齐——否则 subagentDowngrade 等键为
  // undefined，读侧那些 `config.x === true` 的判断会静默走 false 分支（本用例首次运行时
  // 就是这样把子代理父任务书记成了 user_explicit，被断言当场抓住）。
  apply(ctx, {
    ledgerDir: dir,
    observationInjection: false,
    startupRebuild: false,
    subagentDowngrade: true, // Config 默认 true；见上面注释
    memosEnabled: false,
    recallProviders: [],
  })

  const emit = (session, event) => {
    for (const fn of handlers.get('session/event') ?? []) fn(session, event)
  }
  const root = { id: 'session-root', header: {} }
  const sub = { id: 'sub-1', header: { origin: 'subagent' } }

  emit(root, { type: 'user/message', seq: 1, content: '真人说的第一句' })
  emit(root, { type: 'assistant/message', seq: 2, content: '模型的回答（A1 起不入账）' })
  emit(root, { type: 'tool/result', seq: 3, content: 'exit 0' })
  emit(sub, { type: 'user/message', seq: 1, content: '你是 XX 代理，任务是…' })

  // B1：公开服务面直写（无 ingest 声明）
  const direct = services.acp.append({
    sourceClass: 'agent_authored', authority: 'single_observation', confidence: 0.6,
    durability: 0.5, sensitivity: 'private', claimDomain: 'experience', content: '插件直写',
  })

  const db = new DatabaseSync(path.join(dir, DEFAULT_DB_NAME), { readOnly: true })
  const rows = db.prepare('SELECT content, session_type, session_id, state, authority FROM evidence ORDER BY observed_at').all()
  db.close()
  disposeAll()

  const contents = rows.map((r) => r.content)
  assert.deepEqual(
    contents.filter((c) => c.includes('模型的回答')), [],
    'A1：assistant/message 不得入账',
  )
  assert.ok(contents.includes('真人说的第一句'), 'user/message 照常入账')
  assert.ok(contents.includes('exit 0'), 'tool/result 仍入账（A1 暂留）')

  const subRow = rows.find((r) => r.content.startsWith('你是 XX 代理'))
  assert.equal(subRow.session_type, 'subagent', 'C：子代理会话落 subagent')
  assert.equal(subRow.authority, 'agent_inference', '子代理父任务书走降权（2026-08-30 决策 D2-A）')

  const rootRow = rows.find((r) => r.content === '真人说的第一句')
  assert.equal(rootRow.session_type, 'root')

  const directRow = rows.find((r) => r.content === '插件直写')
  assert.equal(direct.decision, 'quarantine', 'B1：直写缺省隔离')
  assert.equal(directRow.state, 'quarantined')
})
