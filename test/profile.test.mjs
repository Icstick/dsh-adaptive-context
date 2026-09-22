// test/profile.test.mjs — Profile 物化视图（A0，2026-09-22）
// 验收目标：分组语义正确、非画像域不混入、确定性可重建、候选形状与 observationToCandidate 同形。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_ARRAYS, PROFILE_DOMAIN_ARRAY, PROFILE_EMPTY_IN_MVP, PROFILE_WEIGHT,
  profileArrayOf, isProfileDomain, buildProfile, profileRefs, profileToCandidates,
  computeProfileWeight,
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

test('computeProfileWeight：base / 支撑 / 复现 / 批准 各自加成，且封顶', () => {
  assert.equal(computeProfileWeight(1, {}).weight, PROFILE_WEIGHT.base, '无信号 = base')
  assert.equal(computeProfileWeight(0, {}).weight, PROFILE_WEIGHT.base, '0 条证据不扣分')
  assert.ok(computeProfileWeight(3, {}).weight > PROFILE_WEIGHT.base, '多支撑更重')
  assert.ok(computeProfileWeight(1, { days: 3 }).weight > PROFILE_WEIGHT.base, '跨日更重')
  assert.ok(computeProfileWeight(1, { confirmed: true }).weight > PROFILE_WEIGHT.base, '批准更重')
  // 封顶作用在**加成**上：超过 evidenceMax 条之后再加也不涨
  const capped = { ...PROFILE_WEIGHT, evidenceMax: 4 }
  assert.equal(computeProfileWeight(5, {}, capped).weight,
    computeProfileWeight(99, {}, capped).weight, '支撑加成封顶')
  assert.equal(computeProfileWeight(99, { days: 99, confirmed: true }).weight, PROFILE_WEIGHT.cap, '总上限')
})

test('computeProfileWeight：signals 如实回填（可解释「为什么这条排前面」）', () => {
  const { signals } = computeProfileWeight(3, { days: 2, sessions: 4, confirmed: true })
  assert.deepEqual(signals, { evidenceCount: 3, days: 2, sessions: 4, confirmed: true })
})

test('buildProfile：weight 由「自身证据条数 + support 信号」共同决定', () => {
  const strong = OBS({ id: 'obs_strong', evidenceIds: ['e1', 'e2', 'e3'] })
  const weak = OBS({ id: 'obs_weak', evidenceIds: ['e1'] })
  const base = buildProfile([strong, weak])
  const baseById = Object.fromEntries(base.preferences.map((r) => [r.observationId, r]))
  // evidenceCount 来自 observation 自身（不依赖 support），所以即使没有 support，
  // 支撑多的那条也已经比 base 重——support 只补「跨日/批准」这两类外部信号。
  assert.equal(baseById.obs_weak.weight, PROFILE_WEIGHT.base, '1 条证据 + 无 support = base')
  assert.equal(baseById.obs_strong.signals.evidenceCount, 3)
  assert.ok(baseById.obs_strong.weight > baseById.obs_weak.weight, '仅凭证据条数就已拉开')

  const withSupport = buildProfile([strong, weak], {
    support: new Map([['obs_strong', { days: 3, sessions: 4, confirmed: true }]]),
  })
  const byId = Object.fromEntries(withSupport.preferences.map((r) => [r.observationId, r]))
  assert.ok(byId.obs_strong.weight > byId.obs_weak.weight, '强信号条目更重')
  assert.equal(byId.obs_strong.signals.confirmed, true)
  assert.equal(byId.obs_weak.signals.days, 0)
})

test('profileToCandidates：weight 落到 confidence；**authority 原样不动**（Confidence is not authority）', () => {
  const p = buildProfile([OBS({ id: 'obs_w', authority: 'single_observation', evidenceIds: ['e1', 'e2'] })], {
    scopeId: 'user-global',
    support: new Map([['obs_w', { days: 2, confirmed: true }]]),
  })
  const c = profileToCandidates(p, 'user-global')[0]
  assert.ok(c.confidence > PROFILE_WEIGHT.base, 'confidence 被加权抬起')
  assert.equal(c.authority, 'single_observation', 'authority 绝不因加权而变')
  assert.equal(c.profileWeight, c.confidence)
  assert.equal(c.profileSignals.confirmed, true)
})

test('buildProfile：空文本的 ref 仍进 Profile（可追溯），但不成候选', () => {
  const p = buildProfile([OBS({ id: 'obs_empty', text: '' })], { scopeId: 'user-global' })
  assert.equal(p.sourceVersion, 1)
  assert.equal(profileToCandidates(p).length, 0)
})
