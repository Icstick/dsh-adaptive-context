// test/dreaming-authority-bound.test.mjs — 判据 B：巩固不得放大权威（2026-09-25）
//
// 依据：AuthMem-Bench（https://arxiv.org/abs/2608.01679）
//   「authority collapse = 巩固保留了主张，却抹掉了约束其可用范围的来源限制，
//     使存下来的记忆暗示出比来源允许的更大的权威」；49 组配置里 48 组出现，
//     失败点就在**巩固那一步**（= 本仓的 dreaming → staging promote）。
//
// 本仓既有先例：src/store.mjs 的 deriveObservationAuthority——evidence→observation 那一步
// 已经取过「支撑证据里最弱的一条」。本文件把同一条非放大防火墙延伸到 observation→promote。
//
// 序（高→低，与 store.mjs 的 rank 和 test/observation-authority.test.mjs 的注释一致）：
//   user_correction > user_explicit > system_policy > external_information
//   > single_observation > agent_inference > agent_self_evaluation
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as pol from '../src/policy.mjs'
// 用命名空间导入：还没实现时表现为**断言失败**（可读的红），而不是模块加载错误。
const { AUTHORITY_RANK, authorityRank, amplifiesAuthority, authorityNotAmplifiedReason, AUTHORITY_AMPLIFIED } = pol
import { DECLARED_AUTHORITY_RANK } from './helpers/authority-rank.mjs'

test('AUTHORITY_RANK：7 个值齐全，与既有断言过的序（observation-authority.test 的注释序）一致', () => {
  const keys = Object.keys(AUTHORITY_RANK)
  assert.equal(keys.length, 7, 'authority 7 值一个不多一个不少')
  assert.deepEqual(keys.slice().sort(), Object.keys(DECLARED_AUTHORITY_RANK).slice().sort())
  // 与 store.deriveObservationAuthority 的 rank 表同序——非放大防火墙两段共用同一个序
  assert.deepEqual(AUTHORITY_RANK, DECLARED_AUTHORITY_RANK)
  assert.ok(AUTHORITY_RANK.user_correction > AUTHORITY_RANK.user_explicit)
  assert.ok(AUTHORITY_RANK.user_explicit > AUTHORITY_RANK.system_policy)
  assert.ok(AUTHORITY_RANK.system_policy > AUTHORITY_RANK.external_information)
  assert.ok(AUTHORITY_RANK.external_information > AUTHORITY_RANK.single_observation)
  assert.ok(AUTHORITY_RANK.single_observation > AUTHORITY_RANK.agent_inference)
  assert.ok(AUTHORITY_RANK.agent_inference > AUTHORITY_RANK.agent_self_evaluation)
})

test('authorityRank：未知值不可比 → null（调用方据此判「不可核验」，不静默放行）', () => {
  assert.equal(authorityRank('user_explicit'), 5)
  assert.equal(authorityRank('nonsense'), null)
  assert.equal(authorityRank(undefined), null)
  assert.equal(authorityRank(''), null)
})

test('非放大：结论不得高于全部支撑证据里最低的那条', () => {
  // 结论顶着 user_explicit，靠的是「一条 agent_inference」——这就是 collapse 本体
  assert.equal(amplifiesAuthority('user_explicit', ['user_explicit', 'agent_inference']), true)
  assert.equal(amplifiesAuthority('system_policy', ['agent_inference']), true)
  assert.equal(amplifiesAuthority('user_correction', ['user_explicit']), true)
})

test('非放大：等同或更低不算放大（取最低秩本来就允许相等）', () => {
  assert.equal(amplifiesAuthority('user_explicit', ['user_explicit']), false)
  assert.equal(amplifiesAuthority('agent_inference', ['user_explicit']), false)
  assert.equal(amplifiesAuthority('agent_self_evaluation', ['user_explicit', 'agent_inference']), false)
})

test('非放大：证据缺失/全非法/结论未知 → null（不可判定，绝不返回 false 冒充通过）', () => {
  assert.equal(amplifiesAuthority('user_explicit', []), null)
  assert.equal(amplifiesAuthority('user_explicit', undefined), null)
  assert.equal(amplifiesAuthority('user_explicit', ['bad', 'worse']), null)
  assert.equal(amplifiesAuthority('bad', ['user_explicit']), null)
  assert.equal(amplifiesAuthority(null, ['user_explicit']), null)
})

test('拒绝理由可读（写进 decision_reason，不新造平行字段）', () => {
  const r = authorityNotAmplifiedReason('user_correction', 'agent_self_evaluation')
  assert.equal(typeof r, 'string')
  assert.match(r, /user_correction/)
  assert.match(r, /agent_self_evaluation/)
  assert.equal(r.includes(AUTHORITY_AMPLIFIED), true, '拒绝理由要带固定前缀，便于审计 grep')
})
