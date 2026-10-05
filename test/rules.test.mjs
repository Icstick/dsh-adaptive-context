// test/rules.test.mjs — T4 M4.1：反馈通道规则存储层 + 视图渲染验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { createRuleStore } from '../src/rule.mjs'
import { renderRulesView, viewFileName, writeRulesDir } from '../src/rules.mjs'
import { AUDIT_OPS } from '../src/audit.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-rule-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { try { ledger.close() } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

const draftInput = (over = {}) => ({
  scopeId: 'user-global',
  domain: 'workflow',
  title: '先测试后提交',
  text: '改代码必须先跑测试，全绿才提交（commit 前守则）',
  gates: ['explicit-prefix'],
  evidenceIds: ['ev_a', 'ev_b'],
  ...over,
})

test('v6 schema：打开即含 rule 表（新库直建）', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const r = store.createRule(draftInput())
  assert.equal(r.inserted, true)
  assert.ok(r.row.id.startsWith('rule_'))
  assert.equal(r.row.state, 'draft')
})

test('createRule 幂等：同 scope+domain+text 同 id，重复建返回 existing', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const a = store.createRule(draftInput())
  const b = store.createRule(draftInput())
  assert.equal(a.row.id, b.row.id)
  assert.equal(b.inserted, false)
})

test('createRule 校验：空 text / 超长 text / 未知 state 拒绝', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  assert.throws(() => store.createRule(draftInput({ text: '' })), /非空/)
  assert.throws(() => store.createRule(draftInput({ text: 'x'.repeat(201) })), /200/)
  assert.throws(() => store.createRule(draftInput({ state: 'bogus' })), TypeError)
  assert.throws(() => store.createRule(draftInput({ supersedes: 'rule_nope' })), /不存在/)
})

test('状态机：draft --approve--> active（active_from 落时间戳）；active --supersede--> superseded', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const { row } = store.createRule(draftInput())
  const act = store.transitionRule(row.id, 'approve', { now: 1000 })
  assert.equal(act.state, 'active')
  assert.equal(act.activeFrom, 1000)
  const sup = store.transitionRule(row.id, 'supersede', { now: 2000 })
  assert.equal(sup.state, 'superseded')
  assert.equal(sup.activeUntil, 2000)
  assert.throws(() => store.transitionRule(row.id, 'approve'), /not allowed/)
})

test('修订链：新规则 supersedes 旧 active → lineage 回溯两代', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const v1 = store.createRule(draftInput())
  store.transitionRule(v1.row.id, 'approve')
  const v2 = store.createRule(draftInput({ text: '改代码必须先跑测试和 lint，全绿才提交', supersedes: v1.row.id }))
  assert.equal(v2.inserted, true)
  store.transitionRule(v2.row.id, 'approve')
  const lineage = store.getRuleLineage(v2.row.id)
  assert.deepEqual(lineage, [v1.row.id, v2.row.id])
})

test('修订语义：draft 前驱可被新草案修订替代（状态机表达，无 state 强约束）', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const d1 = store.createRule(draftInput())
  const v2 = store.createRule(draftInput({ text: '改稿：先测试再提交（含 lint）', supersedes: d1.row.id }))
  assert.equal(v2.inserted, true)
  assert.equal(v2.row.supersedes, d1.row.id)
  assert.deepEqual(store.getRuleLineage(v2.row.id), [d1.row.id, v2.row.id])
})

test('queryRules：state/domain 过滤 + total', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  store.createRule(draftInput())
  store.createRule(draftInput({ domain: 'habit', text: '每日收工前归档 checkpoint' }))
  const all = store.queryRules({})
  assert.equal(all.total, 2)
  const flow = store.queryRules({ domain: 'workflow' })
  assert.equal(flow.total, 1)
  const drafts = store.queryRules({ state: 'draft' })
  assert.equal(drafts.total, 2)
  const actives = store.queryRules({ state: 'active' })
  assert.equal(actives.total, 0)
})

test('ledger.ruleStore 装配：openEvidenceLedger 直接可用', (t) => {
  const ledger = freshLedger(t)
  assert.equal(typeof ledger.ruleStore.createRule, 'function')
  const r = ledger.ruleStore.createRule(draftInput())
  assert.equal(ledger.ruleStore.getRule(r.row.id).domain, 'workflow')
})

test('AUDIT_OPS 含 rule 生命周期 ops', () => {
  for (const op of ['rule_drafted', 'rule_approved', 'rule_rejected', 'rule_superseded']) {
    assert.ok(AUDIT_OPS.includes(op), op)
  }
})

test('renderRulesView：frontmatter + active/superseded 分节 + 可读性快照', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const v1 = store.createRule(draftInput({ activeFrom: 1000 }))
  store.transitionRule(v1.row.id, 'approve', { now: 1000 })
  store.createRule(draftInput({ text: '改代码必须先跑测试和 lint', supersedes: v1.row.id }))
  const rows = store.queryRules({ domain: 'workflow' }).items
  const md = renderRulesView(rows, { domain: 'workflow', updatedAt: '2026-09-07T12:00:00.000Z' })
  assert.ok(md.includes('kind: acp-rules'))
  assert.ok(md.includes('domain: workflow'))
  assert.ok(md.includes('## active'))
  assert.ok(md.includes('id=' + v1.row.id))
  assert.ok(md.includes('先测试后提交'))
  assert.ok(md.includes('## superseded / rejected'))
  assert.equal(viewFileName('workflow'), 'workflow.md')
  assert.equal(viewFileName('user_habit'), 'user_habit.md')
})

// ===================== M4.1b：writeRulesDir 写盘编排 =====================

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'

test('writeRulesDir：按域分文件落盘，内容含 frontmatter 与规则', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const w1 = store.createRule(draftInput())
  const w2 = store.createRule(draftInput({ domain: 'habit', text: '每日收工前归档 checkpoint' }))
  store.transitionRule(w1.row.id, 'approve')
  store.transitionRule(w2.row.id, 'approve')
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-rules-view-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const res = writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  assert.deepEqual(res.domains.sort(), ['habit', 'workflow'])
  assert.equal(res.removed, 0)
  const wf = readFileSync(path.join(dir, 'workflow.md'), 'utf8')
  assert.ok(wf.includes('kind: acp-rules'))
  assert.ok(wf.includes('domain: workflow'))
  assert.ok(wf.includes('先测试后提交'))
  assert.equal(res.files.length, 2)
})

test('writeRulesDir：陈旧域清理（只删 kind: acp-rules 文件，用户 md 保留）', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-rules-view-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'notes.md'), '用户自己的笔记(markdown)', 'utf8')
  const a = store.createRule(draftInput())
  const h = store.createRule(draftInput({ domain: 'habit', text: '每日收工前归档' }))
  store.transitionRule(a.row.id, 'approve')
  store.transitionRule(h.row.id, 'approve')
  writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  assert.ok(existsSync(path.join(dir, 'notes.md')), '非规则 md 保留')
  // habit 域规则全部 supersede → 重建后 habit.md 被清理
  const habit = store.queryRules({ domain: 'habit' }).items[0]
  store.transitionRule(habit.id, 'supersede')
  const res2 = writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  assert.equal(existsSync(path.join(dir, 'habit.md')), false, '失效域文件已删')
  assert.equal(res2.removed, 1)
  assert.ok(existsSync(path.join(dir, 'workflow.md')))
  assert.ok(existsSync(path.join(dir, 'notes.md')))
})

// 注（2026-10-02）：空域集如今**跳过**清理，不再清空目录（守卫见下一节）。
// 本用例的目录自始为空（从未写出过视图），断言仍成立，语义只剩「无 active 规则 → 不写任何视图」；
// 「空域集到底删不删文件」由下一节的三条守卫用例覆盖。断言未删减。
test('writeRulesDir：无 active 规则 → 不写任何视图（空域集是否删文件见下节守卫）', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-rules-view-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = store.createRule(draftInput())
  writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  store.transitionRule(a.row.id, 'approve')
  store.transitionRule(a.row.id, 'supersede')
  const res = writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  assert.equal(res.files.length, 0)
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 0)
})

// ===================== 2026-10-02 事故守卫：空域集不清目录 =====================
// 背景：一次域集为空的 apply()（未传 config.rulesDir → 回落 ~/.dsh/rules）把该目录下的
// security.md / workflow.md 当真「陈旧域」删了。守卫 = 域集为空 → 跳过陈旧清理（一个都不删）
// + warn；域集非空 → 原清理行为不变。三条：a 回归（不许删）/ b 未削弱原行为（该删还删）/ c 正常写。

const RULES_HEAD = '---\nkind: acp-rules\ndomain: '

function freshRulesDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-rules-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个 ACP 规则视图文件：前 120 字符含 kind: acp-rules（与清理判据同款）。 */
function seedView(dir, name, domain) {
  writeFileSync(path.join(dir, name),
    RULES_HEAD + domain + '\nupdated_at: 2026-10-01T00:00:00.000Z\n---\n\n# 规则：' + domain + '\n', 'utf8')
}

/** 只收 warn 的假 logger（writeRulesDir 只用 warn）。 */
function makeLogger() {
  const warns = []
  return { warns, warn: (m) => { warns.push(String(m)) } }
}

test('守卫 a（回归 2026-10-02）：域集为空 + 目录已有 acp-rules 视图 → 一个都不删 + warn', (t) => {
  const dir = freshRulesDir(t)
  seedView(dir, 'security.md', 'security')   // 事故当天被删的就是这一类文件
  seedView(dir, 'workflow.md', 'workflow')
  writeFileSync(path.join(dir, 'notes.md'), '用户自己的笔记', 'utf8')
  const logger = makeLogger()
  const res = writeRulesDir([], { dir, logger })
  assert.ok(existsSync(path.join(dir, 'security.md')), 'security.md 必须还在')
  assert.ok(existsSync(path.join(dir, 'workflow.md')), 'workflow.md 必须还在')
  assert.ok(existsSync(path.join(dir, 'notes.md')), 'notes.md 必须还在')
  assert.equal(res.removed, 0, '一个都不删')
  assert.equal(res.skippedStaleCleanup, true, '守卫已生效')
  assert.equal(res.files.length, 0, '域集为空不写任何视图')
  assert.equal(logger.warns.length, 1, '恰好一条 warn')
  assert.ok(logger.warns[0].includes('域集为空，跳过清理以防误删'), logger.warns[0])
  assert.ok(logger.warns[0].includes(dir), 'warn 要写明目标目录')
  assert.ok(logger.warns[0].includes('kept_md=3'), logger.warns[0])
})

test('守卫 b：域集非空 + 目录有不在域集内的陈旧视图 → 仍被删除（原行为未削弱）', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const dir = freshRulesDir(t)
  seedView(dir, 'habit.md', 'habit')                                   // 陈旧域：不在本次域集
  writeFileSync(path.join(dir, 'notes.md'), '用户自己的笔记', 'utf8') // 用户 md：不许碰
  const a = store.createRule(draftInput())
  store.transitionRule(a.row.id, 'approve')
  const logger = makeLogger()
  const res = writeRulesDir(store.queryRules({ state: 'active' }).items, { dir, logger })
  assert.deepEqual(res.domains, ['workflow'])
  assert.equal(res.removed, 1, '陈旧域仍被清理')
  assert.equal(existsSync(path.join(dir, 'habit.md')), false, 'habit.md 已删')
  assert.ok(existsSync(path.join(dir, 'workflow.md')), '本次域已写出')
  assert.ok(existsSync(path.join(dir, 'notes.md')), '非规则 md 不受影响')
  assert.equal(res.skippedStaleCleanup, false, '域集非空 → 不走守卫')
  assert.equal(logger.warns.length, 0, '域集非空不打「跳过清理」的 warn')
})

test('守卫 c：域集非空 + 视图内容变化 → 正常覆盖写入，不留 temp', (t) => {
  const ledger = freshLedger(t)
  const store = createRuleStore({ db: ledger.db })
  const dir = freshRulesDir(t)
  const a = store.createRule(draftInput())
  store.transitionRule(a.row.id, 'approve')
  const first = writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  const v1 = readFileSync(path.join(dir, 'workflow.md'), 'utf8')
  assert.ok(v1.includes('先测试后提交'))
  assert.deepEqual(first.files, ['workflow.md'])
  const b = store.createRule(draftInput({ text: '改代码必须先跑 lint，全绿才提交' }))
  store.transitionRule(b.row.id, 'approve')
  const second = writeRulesDir(store.queryRules({ state: 'active' }).items, { dir })
  const v2 = readFileSync(path.join(dir, 'workflow.md'), 'utf8')
  assert.deepEqual(second.domains, ['workflow'])
  assert.deepEqual(second.files, ['workflow.md'])
  assert.notEqual(v2, v1, '内容确实变了')
  assert.ok(v2.includes('先测试后提交') && v2.includes('lint'))
  assert.equal(second.removed, 0)
  assert.equal(second.skippedStaleCleanup, false)
  assert.equal(readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0, '不留 temp 残留')
})

// ---- 守卫 d：端到端重演事故路径（apply() 未传 rulesDir → 缺省 $DSH_HOME/rules）----
// 2026-10-02 的真实触发链是 apply()（不是 writeRulesDir 被直接调用）：refreshRulesView()
// 在装配时 eager 跑，rulesDir 缺省解析到 $DSH_HOME/rules，而那一刻账本域集为空。
// 本用例把 $DSH_HOME 圈进 tmp 来重演这条链——即使将来守卫被摘掉，也只会在 tmp 里删，
// 碰不到真实的 ~/.dsh/rules（密闭性：绝不拿真目录做实验）。

/** 最小 fake ctx：够 apply() 走完装配（照 test/ingest-wiring.test.mjs 的写法）。 */
function makeApplyCtx() {
  const warnLog = []
  const services = {}
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    on: () => {},
    provide: (name, value) => { services[name] = value },
    tools: { register: () => {} },
    inject: () => {},       // settings 服务不存在 → 不触发回调
    effect: (fn) => { disposers.push(fn) },   // 必须收起：apply() 靠它关账本（否则 Windows 上 rmSync EPERM）
    logger: {
      warn: (m) => { warnLog.push(String(m)) },
      debug: () => {}, info: () => {}, error: () => {},
    },
  }
  return { ctx, warnLog, disposeAll: () => { for (const d of disposers) { const fn = d(); if (typeof fn === 'function') fn() } } }
}

test('守卫 d（端到端）：apply() 不传 rulesDir → 缺省 $DSH_HOME/rules 也不会被扫空', async (t) => {
  const { apply } = await import('../src/index.mjs')
  const home = mkdtempSync(path.join(tmpdir(), 'acp-guard-home-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home            // 重演真实缺省解析，但圈在 tmp 内
  const { ctx, warnLog, disposeAll } = makeApplyCtx()
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    disposeAll()                            // 先关账本：apply() 靠 ctx.effect 登记 ledger.close()
    rmSync(home, { recursive: true, force: true })   // 不关就 EPERM（Windows 上文件被占用）
  })
  const seeded = path.join(home, 'rules')   // = 缺省 rulesDir
  mkdirSync(seeded, { recursive: true })
  seedView(seeded, 'security.md', 'security')   // 事故当天被删的两个文件
  seedView(seeded, 'workflow.md', 'workflow')
  apply(ctx, {                            // 故意**不传** rulesDir —— 就是事故当天的调用形状
    ledgerDir: path.join(home, 'acp'),    // 空账本 → 域集为空
    viewsDir: path.join(home, 'views'),
    observationInjection: false,
    startupRebuild: false,
    recallProviders: [],
  })
  assert.ok(existsSync(path.join(seeded, 'security.md')), 'security.md 必须还在')
  assert.ok(existsSync(path.join(seeded, 'workflow.md')), 'workflow.md 必须还在')
  assert.ok(warnLog.some((m) => m.includes('域集为空，跳过清理以防误删')),
    'apply() 路径要能听到守卫的 warn：' + JSON.stringify(warnLog))
})
