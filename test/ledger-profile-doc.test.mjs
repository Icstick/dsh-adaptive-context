// test/ledger-profile-doc.test.mjs — 人读画像生成器（M2/P3）的纯函数验收
// 运行：node --test test/ledger-profile-doc.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowsToObservations, renderProfileDoc, PROFILE_DOC_DOMAINS } from '../scripts/ledger-profile-doc.mjs'
import { buildProfile } from '../src/profile.mjs'

const row = (over = {}) => ({
  id: 'obs_1', scope_id: 'user-global', subject: '用户', predicate: '偏好',
  claim_domain: 'user_preference', authority: 'user_explicit', text: '偏好先出计划文档',
  evidence_ids: '["ev_1"]', observed_at: '2026-09-20T00:00:00.000Z', ...over,
})

test('画像域只有 user_fact / user_preference（其余域归别的段）', () => {
  assert.deepEqual([...PROFILE_DOC_DOMAINS], ['user_fact', 'user_preference'])
})

test('rowsToObservations：snake_case → camelCase，evidence_ids 解析容错', () => {
  const [o] = rowsToObservations([row()])
  assert.equal(o.claimDomain, 'user_preference')
  assert.equal(o.scopeId, 'user-global')
  assert.deepEqual(o.evidenceIds, ['ev_1'])
  const [bad] = rowsToObservations([row({ evidence_ids: 'not json at all' })])
  assert.deepEqual(bad.evidenceIds, [])
  assert.deepEqual(rowsToObservations(null), [])
})

test('renderProfileDoc：确定性 + 按 subject 分组 + 计数', () => {
  const p = buildProfile(rowsToObservations([
    row({ id: 'obs_a', subject: '同步方式', text: '倾向采用 push+pull 的同步方式' }),
    row({ id: 'obs_b', subject: '用户环境', claim_domain: 'user_fact', text: '本机为 Windows，账户 zoot，网络走 ZeroTier 内网' }),
  ]))
  const doc = renderProfileDoc(p, { host: 'H', generatedAt: 'T' })
  assert.equal(doc, renderProfileDoc(p, { host: 'H', generatedAt: 'T' }))
  assert.match(doc, /## 稳定事实/)
  assert.match(doc, /## 偏好/)
  assert.match(doc, /### 同步方式/)
  assert.match(doc, /### 用户环境/)
  assert.match(doc, /参与构建：\*\*2 条\*\*/)
})

test('renderProfileDoc：闸门自检分流 —— 噪声不进正文，但也不消失', () => {
  const p = buildProfile(rowsToObservations([
    row({ id: 'obs_ok', text: '偏好先准备候选清单再推进任务' }),
    row({ id: 'obs_soft', text: '用户计划稍后讨论 memory 是否保留' }),
    row({ id: 'obs_hard', subject: 'approval', text: 'User changed the approval policy from ask to never' }),
  ]))
  const doc = renderProfileDoc(p, { host: 'H', generatedAt: 'T' })
  assert.match(doc, /### 待核（1 条/)
  assert.match(doc, /### 已由闸门挡下（1 条/)
  const body = doc.split('### 待核')[0]
  assert.equal(body.includes('User changed the approval policy'), false, 'hard 不该进正文')
  assert.equal(body.includes('用户计划稍后讨论'), false, 'soft 不该进正文')
  assert.equal(body.includes('偏好先准备候选清单'), true, '正常行要在正文里')
  assert.equal(doc.includes('User changed the approval policy'), true, '被挡的仍要在文档里留痕')
  // --gate off：三条都回正文，且不出现分流小节
  const noGate = renderProfileDoc(p, { host: 'H', generatedAt: 'T', gate: false })
  assert.equal(noGate.includes('已由闸门挡下'), false)
  assert.equal(noGate.includes('用户计划稍后讨论'), true)
})

test('renderProfileDoc：空 profile 不崩', () => {
  const doc = renderProfileDoc(buildProfile([], {}), { host: 'H', generatedAt: 'T' })
  assert.match(doc, /（空）/)
  assert.match(doc, /参与构建：\*\*0 条\*\*/)
})
