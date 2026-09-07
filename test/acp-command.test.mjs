// test/acp-command.test.mjs — T4 M4.3：/acp rule review 命令验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { handleRuleReviewCommand, renderRuleList, RULE_CMD_USAGE } from '../src/index.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-cmd-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { try { ledger.close() } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

const seedDraft = (ledger, over = {}) => ledger.ruleStore.createRule({
  domain: 'workflow',
  title: '测试先行',
  text: '改代码前先跑测试',
  gates: ['explicit-prefix'],
  evidenceIds: ['ev_seed'],
  ...over,
})

test('空库 list → 空态提示', (t) => {
  const ledger = fresh(t)
  const res = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule list')
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('无规则草案'))
})

test('list 展示草案与生效规则', (t) => {
  const ledger = fresh(t)
  seedDraft(ledger)
  const act = seedDraft(ledger, { title: '生效规则', text: '生效规则文本', id: undefined })
  ledger.ruleStore.transitionRule(act.row.id, 'approve')
  const res = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule list')
  assert.ok(res.text.includes('[draft] 1 条'))
  assert.ok(res.text.includes('测试先行'))
  assert.ok(res.text.includes('[active] 1 条'))
  assert.ok(res.text.includes('生效规则'))
})

test('accept 1 → active + audit rule_approved + onChanged 回调', (t) => {
  const ledger = fresh(t)
  const d = seedDraft(ledger)
  let changed = 0
  const res = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule accept 1', { onChanged: () => { changed += 1 } })
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('active'))
  assert.equal(ledger.ruleStore.getRule(d.row.id).state, 'active')
  assert.equal(changed, 1)
  const aud = ledger.db.prepare("SELECT COUNT(*) n FROM audit WHERE op='rule_approved' AND target_id=?").get(d.row.id)
  assert.equal(aud.n, 1)
})

test('reject 1 → rejected + audit rule_rejected；重复 reject 报错', (t) => {
  const ledger = fresh(t)
  const d = seedDraft(ledger)
  const res = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule reject 1')
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('rejected'))
  assert.equal(ledger.ruleStore.getRule(d.row.id).state, 'rejected')
  const again = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule reject 1')
  assert.equal(again.kind, 'error', '终态不可再操作')
})

test('越界序号 / 非法输入 → error + usage', (t) => {
  const ledger = fresh(t)
  const res1 = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule accept 9')
  assert.equal(res1.kind, 'error')
  const res2 = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'rule accept xyz')
  assert.equal(res2.kind, 'error')
  const usage = handleRuleReviewCommand(ledger.ruleStore, ledger.auditStore, 'bogus')
  assert.equal(usage.text, RULE_CMD_USAGE)
})
