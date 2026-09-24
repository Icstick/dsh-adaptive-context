// test/ledger-quarantine-cascade.test.mjs — 隔离级联判据的纯函数验收（2026-09-24）
// 运行：node --test test/ledger-quarantine-cascade.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cascadeReason } from '../scripts/ledger-quarantine-cascade.mjs'

const obs = (over = {}) => ({ id: 'obs_x', subject: '用户', text: '偏好先出计划文档', evidence_ids: '["ev_1"]', claim_domain: 'user_preference', ...over })
const st = (m) => new Map(Object.entries(m))

test('源证据全部隔离 + 审批策略变更陈述 → 级联', () => {
  const ev = st({ ev_1: 'quarantined' })
  assert.equal(cascadeReason(obs({ text: '用户将审批策略从 never 改为 ask。' }), ev), 'approval-duplicate')
  assert.equal(cascadeReason(obs({ text: "Approval policy was changed from 'ask' to 'never'." }), ev), 'approval-duplicate')
})

test('★ 源证据全部隔离但文本是真偏好 → 不动（这是最容易误杀的一类）', () => {
  const ev = st({ ev_1: 'quarantined' })
  assert.equal(cascadeReason(obs({ text: '用户要求审批策略保持询问，不要自动执行。' }), ev), null)
  assert.equal(cascadeReason(obs({ text: '中文用户，妹妹，跨多个 DSH 项目工作，有御影澪姐姐人设' }), ev), null)
  assert.equal(cascadeReason(obs({ text: '百合、巨大娘×缩小体型差、足部恋物内容' }), ev), null)
})

test('源证据只要有一条不是隔离/脱敏 → 不动', () => {
  assert.equal(cascadeReason(obs({ evidence_ids: '["ev_1","ev_2"]' }), st({ ev_1: 'quarantined', ev_2: 'active' })), null)
  assert.equal(cascadeReason(obs({ evidence_ids: '["ev_1"]' }), st({ ev_1: 'active' })), null)
})

test('无证据引用 → 不动（本机蒸馏、没有跨机血缘的行不碰）', () => {
  assert.equal(cascadeReason(obs({ evidence_ids: '[]' }), st({})), null)
  assert.equal(cascadeReason(obs({ evidence_ids: 'not json' }), st({})), null)
})

test('英文残留 / 会话临时态：走放行闸门的同一套判据', () => {
  const ev = st({ ev_1: 'quarantined' })
  assert.equal(cascadeReason(obs({ text: 'Five background subagents finished their work, each reporting closing' }), ev), 'english-residue')
  assert.equal(cascadeReason(obs({ text: '用户同意继续当前任务' }), ev), 'ephemeral')
})

test('redacted 与 quarantined 同等对待', () => {
  assert.equal(cascadeReason(obs({ text: '用户将审批策略从 ask 改为 never。' }), st({ ev_1: 'redacted' })), 'approval-duplicate')
})
