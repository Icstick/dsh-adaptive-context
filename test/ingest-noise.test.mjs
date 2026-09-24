// test/ingest-noise.test.mjs — 机器模板冻结表 + 两处拦截的验收（2026-09-24）
// 运行：node --test test/ingest-noise.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MACHINE_TEMPLATES, INGEST_NOISE_VERSION, machineTemplateOf, isMachineTemplate } from '../src/ingest-noise.mjs'
import { toEvidenceCandidate } from '../src/extract.mjs'
import { isConsolidationSkippable } from '../src/consolidate.mjs'

test('模板表冻结：每个条目有 id/kind/note，且有版本号', () => {
  assert.equal(typeof INGEST_NOISE_VERSION, 'number')
  assert.ok(MACHINE_TEMPLATES.length >= 4)
  for (const t of MACHINE_TEMPLATES) {
    assert.ok(t.id && t.kind && t.note, JSON.stringify(t))
    assert.ok(['prefix', 'regex'].includes(t.kind))
  }
})

test('四条模板各自命中（前缀 / 行首锚定）', () => {
  assert.equal(machineTemplateOf('You are the background skill reviewer. 你的任务是…').id, 'reviewer-prompt')
  assert.equal(machineTemplateOf('【maid 压缩归档】会话 x 的摘要').id, 'maid-archive')
  assert.equal(machineTemplateOf('Background subagent 7f3a1c2e-1111-2222-3333-444455556666 finished in 12s').id, 'subagent-banner')
  assert.equal(machineTemplateOf('<system-reminder>注意 blah</system-reminder>').id, 'system-reminder')
})

test('★ 只认前缀/行首：模板串出现在文本中间不算（审计自污染的教训）', () => {
  const quoted = '我在报告里引用了这句：You are the background skill reviewer. 作为例子，说明它会被误收。'
  assert.equal(isMachineTemplate(quoted), false)
  const quoted2 = '上述注入块形如 <system-reminder>…</system-reminder>，但它出现在句子中间。'
  assert.equal(isMachineTemplate(quoted2), false)
  assert.equal(isMachineTemplate('我先解释一下 Background subagent abc finished 这条横幅的含义'), false)
})

test('前导空白（含全角空格）归一后再判', () => {
  assert.equal(isMachineTemplate('   \n  You are the background skill reviewer. ok'), true)
  assert.equal(isMachineTemplate('\u3000【maid 压缩归档】x'), true)
})

test('正常内容一律不命中', () => {
  for (const s of [
    '偏好先准备候选清单再推进任务',
    '我们这个项目用 pnpm',
    '更正：这个项目之后统一用 Bun',
    'Background subagent 的任务书要求不能空跑',
    '', null, undefined,
  ]) assert.equal(isMachineTemplate(s), false, String(s))
})

test('集成 · extract 层：机器模板不进账本', () => {
  const banner = { type: 'user/message', id: 'e-tpl', content: 'Background subagent 7f3a1c2e-1111-2222-3333-444455556666 finished in 12s' }
  assert.equal(toEvidenceCandidate(banner, { sessionId: 's1' }), null)
  const reviewPrompt = { type: 'user/message', id: 'e-tpl2', content: 'You are the background skill reviewer. 要求：不能空跑' }
  assert.equal(toEvidenceCandidate(reviewPrompt, { sessionId: 's1' }), null)
  const normal = { type: 'user/message', id: 'e-ok', content: '偏好先出计划文档' }
  assert.ok(toEvidenceCandidate(normal, { sessionId: 's1' }))
})

test('集成 · consolidate 层：机器模板永不蒸馏，且不受 agent-experience 开关影响', () => {
  const ev = { sourceClass: 'user_correction', claimDomain: 'user_preference', content: 'You are the background skill reviewer. 要求至少一条' }
  assert.equal(isConsolidationSkippable(ev, true), true)
  assert.equal(isConsolidationSkippable(ev, false), true)
  const normal = { sourceClass: 'user_input', claimDomain: 'user_preference', content: '偏好先出计划文档' }
  assert.equal(isConsolidationSkippable(normal, true), false)
})
