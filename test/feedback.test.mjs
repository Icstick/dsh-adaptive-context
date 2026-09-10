// test/feedback.test.mjs — T4 M4.2：反馈通道草拟管线验收（G1/G2 闸门 + draft 落库 + 幂等 + 日限）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  RULE_PREFIXES, g2KeyOf, isExplicitRuleRequest,
  collectRuleCandidates, draftRuleFromEvidence,
  maybeDraft, parseDraftJson, DRAFT_MAX_RUNS_PER_DAY,
} from '../src/feedback.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-fb-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { try { ledger.close() } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

function seedEv(ledger, over = {}) {
  const res = ledger.append({
    sourceClass: over.sourceClass ?? 'user_input',
    authority: over.authority ?? 'user_explicit',
    confidence: 0.9,
    durability: 0.5,
    sensitivity: 'private',
    claimDomain: over.claimDomain ?? 'user_fact',
    content: over.content ?? '测试内容',
    observedAt: over.observedAt ?? new Date().toISOString(),
    sourceRef: { sessionEventId: 'fb-' + Math.random().toString(36).slice(2, 10) },
  })
  return ledger.getById(res.id)
}

// ===================== 纯函数：G1 / G2 key =====================

test('isExplicitRuleRequest：记住:/更正:/规则:/remember: 前缀命中（有余量文本）', () => {
  for (const p of RULE_PREFIXES) {
    assert.equal(isExplicitRuleRequest(p + '改代码前先跑测试'), true, 'prefix=' + p)
  }
  assert.equal(isExplicitRuleRequest('记住：'), false, '前缀无余量不算')
  assert.equal(isExplicitRuleRequest('我记住了这个项目用 pnpm'), false, '正文含词非前缀不算')
  assert.equal(isExplicitRuleRequest(''), false)
})

test('g2KeyOf：压缩空白 + 截断前 24 字符', () => {
  assert.equal(g2KeyOf('  a   b  c '), 'a b c')
  assert.equal(g2KeyOf('x'.repeat(40)).length, 24)
  assert.equal(g2KeyOf('不要直接改 生产配置'), '不要直接改 生产配置')
})

// ===================== 候选采集 =====================

test('collectRuleCandidates：G1 前缀（user_explicit + user_correction）+ G2 重复 ≥2（取最新），噪声与窗口外排除', (t) => {
  const ledger = freshLedger(t)
  const old = new Date(Date.now() - 10 * 86400000).toISOString()
  seedEv(ledger, { content: '记住：改代码前先跑测试', authority: 'user_explicit', sourceClass: 'user_input' })
  seedEv(ledger, { content: '更正：不要用 yarn，统一 pnpm', authority: 'user_correction', sourceClass: 'user_correction', claimDomain: 'user_preference' })
  seedEv(ledger, { content: '不要直接改生产配置 动手前先确认影响面并准备好回滚方案 这点很重要', authority: 'user_correction', sourceClass: 'user_correction', claimDomain: 'user_preference' })
  seedEv(ledger, { content: '不要直接改生产配置 动手前先确认影响面并准备好回滚方案 别忽略', authority: 'user_correction', sourceClass: 'user_correction', claimDomain: 'user_preference' })
  seedEv(ledger, { content: '单独一次的纠正不算规则', authority: 'user_correction', sourceClass: 'user_correction', claimDomain: 'user_preference' })
  seedEv(ledger, { content: '记住：老规矩不做候选（窗口外）', observedAt: old })
  const cands = collectRuleCandidates(ledger)
  const texts = cands.map((c) => String(c.content).slice(0, 12))
  assert.ok(texts.some((s) => s.startsWith('记住：改代码前')), 'G1 user_explicit 前缀')
  assert.ok(texts.some((s) => s.startsWith('更正：不要用')), 'G1 user_correction 前缀')
  assert.ok(texts.some((s) => s.startsWith('不要直接改生产配置')), 'G2 重复代表（窗口内最新措辞）')
  assert.equal(texts.some((s) => s.startsWith('单独一次')), false, '单次纠正不进')
  assert.equal(texts.some((s) => s.includes('老规矩')), false, '窗口外不进')
  assert.equal(cands.length, 3)
})

// ===================== 草拟 =====================

test('draftRuleFromEvidence：G1 兜底去前缀落 draft，gates=explicit-prefix', (t) => {
  const ledger = freshLedger(t)
  const ev = seedEv(ledger, { content: '记住：改代码前先跑测试', authority: 'user_explicit' })
  const res = draftRuleFromEvidence(ledger, ev)
  assert.equal(res.inserted, true)
  assert.equal(res.row.state, 'draft')
  assert.equal(res.row.text, '改代码前先跑测试')
  assert.deepEqual(res.row.gates, ['explicit-prefix'])
  assert.deepEqual(res.row.evidenceIds, [ev.id])
  assert.equal(res.row.source, 'feedback')
})

test('draftRuleFromEvidence：LLM JSON 覆盖 domain/title/text', (t) => {
  const ledger = freshLedger(t)
  const ev = seedEv(ledger, { content: '记住：每次提交前跑全量测试' })
  const res = draftRuleFromEvidence(ledger, ev, {
    llmJson: { domain: 'workflow', title: '提交前全量测试', text: '每次提交前必须跑全量测试，全绿才允许 push' },
  })
  assert.equal(res.row.domain, 'workflow')
  assert.equal(res.row.title, '提交前全量测试')
  assert.equal(res.row.text, '每次提交前必须跑全量测试，全绿才允许 push')
})

test('maybeDraft：无 LLM 兜底草拟 + audit rule_drafted + 幂等（二次 run 不再草拟）', async (t) => {
  const ledger = freshLedger(t)
  seedEv(ledger, { content: '记住：改代码前先跑测试', authority: 'user_explicit' })
  seedEv(ledger, { content: '更正：不要用 yarn，统一 pnpm', authority: 'user_correction', sourceClass: 'user_correction', claimDomain: 'user_preference' })
  const r1 = await maybeDraft(ledger, {})
  assert.equal(r1.ran, true)
  assert.equal(r1.candidates, 2)
  assert.equal(r1.drafted, 2)
  const { total } = ledger.ruleStore.queryRules({ state: 'draft' })
  assert.equal(total, 2)
  const r2 = await maybeDraft(ledger, {})
  assert.equal(r2.drafted, 0, '幂等：已入 rules 的证据不重复草拟')
  const { total: t2 } = ledger.ruleStore.queryRules({})
  assert.equal(t2, 2)
})

test('maybeDraft：LLM mock 产出 JSON → 采用模型字段', async (t) => {
  const ledger = freshLedger(t)
  seedEv(ledger, { content: '记住：改代码前先跑测试', authority: 'user_explicit' })
  const llmCall = async () => JSON.stringify([
    { domain: 'workflow', title: '测试先行', text: '先写测试再写实现，全绿才提交' },
  ])
  const r = await maybeDraft(ledger, { llmCall })
  assert.equal(r.drafted, 1)
  const { items } = ledger.ruleStore.queryRules({})
  assert.equal(items[0].domain, 'workflow')
  assert.equal(items[0].title, '测试先行')
})

test('maybeDraft：日限节流（同天已达上限 → daily_cap 短路）', async (t) => {
  const ledger = freshLedger(t)
  ledger.setMeta('feedback_draft_day', new Date().toISOString().slice(0, 10))
  ledger.setMeta('feedback_draft_count', String(DRAFT_MAX_RUNS_PER_DAY))
  const r = await maybeDraft(ledger, {})
  assert.equal(r.ran, false)
  assert.equal(r.reason, 'daily_cap')
})

test('parseDraftJson：剥 markdown fence / 前后杂文；非法 → null', () => {
  assert.deepEqual(parseDraftJson('```json\n[{"domain":"workflow"}]\n```'), [{ domain: 'workflow' }])
  assert.deepEqual(parseDraftJson('前缀杂文 [{"a":1}] 后缀'), [{ a: 1 }])
  assert.equal(parseDraftJson('没有数组'), null)
  assert.equal(parseDraftJson('[broken'), null)
})
