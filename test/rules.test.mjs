// test/rules.test.mjs — T4 M4.1：反馈通道规则存储层 + 视图渲染验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { createRuleStore, ruleIdOf, RULE_STATES, RULE_TRANSITIONS } from '../src/rule.mjs'
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

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

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

test('writeRulesDir：无 active 规则 → 清空规则视图（notes 仍保留）', (t) => {
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
