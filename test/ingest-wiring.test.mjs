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
//
// 密闭性纪律（P1，2026-10-02 事故后补）
// ------------------------------------------------------------------
// apply() 内的 refreshRulesView() 是 **eager** 的（src/index.mjs:362），而 rulesDir
// 缺省解析为 resolveDshHome()/rules（src/index.mjs:349）——即真实的 ~/.dsh/rules。
// 该目录会做陈旧视图清理（src/rules.mjs:86-96：删掉带 kind: acp-rules 头、但不在本次
// 账本域集里的 .md）。所以**任何不传 rulesDir 的 apply() 调用都会清用户真实的规则视图**：
// 本文件此前就是如此，跑一次全量测试即删掉 ~/.dsh/rules/{security,workflow}.md（已复现）。
// 纪律：直接驱动 apply() 的用例必须显式传 rulesDir/viewsDir 到本文件私有 tmp。
// 注意 ledgerDir 给不出这层保护——rulesDir 不落在 ledgerDir 下，两者是独立解析的。
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
  // 直接驱动 apply() 的用例要么自己补齐默认值，要么依赖代码里的 `??` 兜底。
  // 本用例首次运行时正是踩在这里：subagentDowngrade 读 `=== true` 且无兜底，把子代理
  // 父任务书记成了 user_explicit，被断言当场抓住。2026-09-22 已给该键补 `?? true` 安全网；
  // 下面仍显式传值，是为了让用例不依赖兜底本身（兜底另有断言）。
  apply(ctx, {
    ledgerDir: dir,
    rulesDir: path.join(dir, 'rules'),   // 必须显式：缺省会解析到真实 ~/.dsh/rules 并被陈旧清理
    viewsDir: path.join(dir, 'views'),   // 缺省虽是 ledgerDir/views（安全），仍显式圈进 tmp
    observationInjection: false,
    startupRebuild: false,
    subagentDowngrade: true, // Config 默认 true；见上面注释
    recallProviders: [],     // 显式无 provider（2026-10-01 起也是缺省语义）
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

test('subagentDowngrade 缺省兜底：配置未给该键时仍降权（不依赖宿主套默认）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-wiring2-'))
  const { ctx, handlers, disposeAll } = makeCtx()
  t.after(() => { disposeAll(); rmSync(dir, { recursive: true, force: true }) })

  // 故意**不传** subagentDowngrade —— 模拟宿主没套 Config 默认值的路径
  apply(ctx, {
    ledgerDir: dir,
    rulesDir: path.join(dir, 'rules'),   // 同上：不显式传就会清真实 ~/.dsh/rules
    viewsDir: path.join(dir, 'views'),
    observationInjection: false,
    startupRebuild: false,
    recallProviders: [],
  })
  const sub = { id: 'sub-2', header: { origin: 'subagent' } }
  for (const fn of handlers.get('session/event') ?? []) {
    fn(sub, { type: 'user/message', seq: 1, content: '你是 YY 代理，任务是…' })
  }

  const db = new DatabaseSync(path.join(dir, DEFAULT_DB_NAME), { readOnly: true })
  const row = db.prepare("SELECT authority, session_type FROM evidence WHERE content LIKE '你是 YY 代理%'").get()
  db.close()
  disposeAll()
  assert.equal(row.authority, 'agent_inference', '缺省兜底必须为 true，否则父任务书会冒充 user_explicit')
  assert.equal(row.session_type, 'subagent')
})
