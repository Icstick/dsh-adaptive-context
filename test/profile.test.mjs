// test/profile.test.mjs — Profile 物化视图（A0，2026-09-22）
// 验收目标：分组语义正确、非画像域不混入、确定性可重建、候选形状与 observationToCandidate 同形。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_ARRAYS, PROFILE_DOMAIN_ARRAY, PROFILE_EMPTY_IN_MVP,
  profileArrayOf, isProfileDomain, buildProfile, profileRefs, profileToCandidates,
} from '../src/profile.mjs'

const OBS = (over = {}) => ({
  id: 'obs_1', scopeId: 'user-global', subject: '分支管理', predicate: '偏好',
  claimDomain: 'user_preference', text: '倾向将分支都合并到main', authority: 'user_explicit',
  evidenceIds: ['ev_1'], observedAt: '2026-09-20T00:00:00.000Z',
  ...over,
})

test('契约：五个数组齐全；MVP 恒空三数组有显式清单', () => {
  assert.deepEqual([...PROFILE_ARRAYS], ['stableFacts', 'preferences', 'recentState', 'interactionPatterns', 'inferredTraits'])
  assert.deepEqual([...PROFILE_EMPTY_IN_MVP], ['recentState', 'interactionPatterns', 'inferredTraits'])
  assert.deepEqual(PROFILE_DOMAIN_ARRAY, { user_fact: 'stableFacts', user_preference: 'preferences' })
})

test('域映射：只有 user_fact / user_preference 进画像，其余四域明确不进', () => {
  assert.equal(profileArrayOf('user_fact'), 'stableFacts')
  assert.equal(profileArrayOf('user_preference'), 'preferences')
  for (const d of ['work', 'style', 'experience', 'external_fact']) {
    assert.equal(profileArrayOf(d), null, d + ' 不该进画像')
    assert.equal(isProfileDomain(d), false)
  }
})

test('buildProfile：按域分组 + 逐条带 observationId 与 evidenceIds（三级回链）', () => {
  const p = buildProfile([
    OBS({ id: 'obs_pref', claimDomain: 'user_preference' }),
    OBS({ id: 'obs_fact', claimDomain: 'user_fact', text: '本机为 Windows' }),
    OBS({ id: 'obs_work', claimDomain: 'work', text: '不该进来' }),
    OBS({ id: 'obs_style', claimDomain: 'style', text: '也不该进来' }),
  ], { scopeId: 'user-global' })
  assert.equal(p.stableFacts.length, 1)
  assert.equal(p.preferences.length, 1)
  assert.equal(p.recentState.length, 0)
  assert.equal(p.subjectId, 'user-global')
  assert.equal(p.sourceVersion, 2, 'sourceVersion = 参与构建的 observation 条数')
  assert.equal(p.stableFacts[0].observationId, 'obs_fact')
  assert.deepEqual(p.stableFacts[0].evidenceIds, ['ev_1'])
  assert.equal(p.preferences[0].observationId, 'obs_pref')
})

test('buildProfile：确定性（同输入同输出，与入参顺序无关）', () => {
  const a = OBS({ id: 'obs_b', observedAt: '2026-09-21T00:00:00.000Z' })
  const b = OBS({ id: 'obs_a', observedAt: '2026-09-20T00:00:00.000Z' })
  const p1 = buildProfile([a, b])
  const p2 = buildProfile([b, a])
  assert.deepEqual(p1, p2)
  assert.equal(p1.preferences[0].observationId, 'obs_a', '按 observedAt 升序')
})

test('profileRefs：跨数组扁平，顺序 = PROFILE_ARRAYS 顺序，带 array 标记', () => {
  const p = buildProfile([
    OBS({ id: 'obs_pref', claimDomain: 'user_preference' }),
    OBS({ id: 'obs_fact', claimDomain: 'user_fact' }),
  ])
  const refs = profileRefs(p)
  assert.deepEqual(refs.map((r) => r.array), ['stableFacts', 'preferences'])
  assert.deepEqual(refs.map((r) => r.observationId), ['obs_fact', 'obs_pref'])
})

test('profileToCandidates：形状与 observationToCandidate 同形 + profileArray 标记', () => {
  const p = buildProfile([OBS({ id: 'obs_pref', claimDomain: 'user_preference' })], { scopeId: 'user-global' })
  const cands = profileToCandidates(p, 'user-global')
  assert.equal(cands.length, 1)
  const c = cands[0]
  assert.equal(c.id, 'obs_pref')
  assert.equal(c.sourceClass, 'observation')
  assert.equal(c.claimDomain, 'user_preference', '仍是原域 → composer sectionOf 归 user_model')
  assert.equal(c.state, 'active')
  assert.equal(c.isObservation, true)
  assert.equal(c.profileArray, 'preferences')
  assert.ok(c.content.includes('分支管理 偏好：'))
})

test('profileToCandidates：空/缺省 profile 返回空数组（fail-open）', () => {
  assert.deepEqual(profileToCandidates(null, 'user-global'), [])
  assert.deepEqual(profileToCandidates(undefined, 'user-global'), [])
  assert.deepEqual(profileToCandidates(buildProfile([]), 'user-global'), [])
})

test('buildProfile：空文本的 ref 仍进 Profile（可追溯），但不成候选', () => {
  const p = buildProfile([OBS({ id: 'obs_empty', text: '' })], { scopeId: 'user-global' })
  assert.equal(p.sourceVersion, 1)
  assert.equal(profileToCandidates(p).length, 0)
})
