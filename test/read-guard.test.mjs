// test/read-guard.test.mjs — Read Guard 验收测试：
// authority → claimDomain 资格矩阵（GOVERNANCE.md §2.5，决策日期 2026-08-25）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readGuard, AUTHORITY_DOMAIN_MATRIX, authorityMayClaimDomain,
  isEphemeralPreference, preferenceFilterAllows,
} from '../src/governance.mjs'
import { AUTHORITIES, CLAIM_DOMAINS } from '../src/constants.mjs'

/** 最小 evidence（readGuard 只读 state/scopeId/authority/validFrom/validUntil） */
function ev(overrides = {}) {
  return {
    state: 'active',
    scopeId: 'user-global',
    authority: 'user_explicit',
    ...overrides,
  }
}

function ctx(overrides = {}) {
  return { scopeId: 'user-global', ...overrides }
}

test('矩阵完整性：7 authority × 6 claimDomain 全覆盖，行/列与 constants 一致', () => {
  assert.deepEqual(Object.keys(AUTHORITY_DOMAIN_MATRIX).sort(), [...AUTHORITIES].sort())
  for (const authority of AUTHORITIES) {
    const row = AUTHORITY_DOMAIN_MATRIX[authority]
    assert.deepEqual(Object.keys(row).sort(), [...CLAIM_DOMAINS].sort(), `row '${authority}' 缺列`)
    for (const domain of CLAIM_DOMAINS) {
      assert.equal(typeof row[domain], 'boolean', `${authority}×${domain} 必须显式为 boolean`)
    }
  }
})

test('system_policy / user_explicit / user_correction：全部 6 域允许', () => {
  for (const authority of ['system_policy', 'user_explicit', 'user_correction']) {
    for (const domain of CLAIM_DOMAINS) {
      const g = readGuard(ev({ authority }), ctx({ targetDomain: domain }))
      assert.equal(g.allowed, true, `${authority} 应允许 ${domain}`)
      assert.deepEqual(g.reasons, [])
    }
  }
})

test('external_information 不能注入 user_preference 域 → 拒绝', () => {
  const g = readGuard(ev({ authority: 'external_information' }), ctx({ targetDomain: 'user_preference' }))
  assert.equal(g.allowed, false)
  assert.ok(g.reasons[0].includes('not permitted'))
})

test('external_information 不能注入 style 域 → 拒绝', () => {
  const g = readGuard(ev({ authority: 'external_information' }), ctx({ targetDomain: 'style' }))
  assert.equal(g.allowed, false)
})

test('external_information 可注入 work 域 → 允许', () => {
  const g = readGuard(ev({ authority: 'external_information' }), ctx({ targetDomain: 'work' }))
  assert.equal(g.allowed, true)
})

test('external_information 可注入 experience 域（2026-08-25 调整）→ 允许', () => {
  const g = readGuard(ev({ authority: 'external_information' }), ctx({ targetDomain: 'experience' }))
  assert.equal(g.allowed, true)
})

test('single_observation 可注入 user_fact → 允许', () => {
  const g = readGuard(ev({ authority: 'single_observation' }), ctx({ targetDomain: 'user_fact' }))
  assert.equal(g.allowed, true)
})

test('single_observation 不能注入 style → 拒绝', () => {
  const g = readGuard(ev({ authority: 'single_observation' }), ctx({ targetDomain: 'style' }))
  assert.equal(g.allowed, false)
})

test('single_observation 不能注入 user_preference → 拒绝（观察到用 TS ≠ 用户喜欢 TS）', () => {
  const g = readGuard(ev({ authority: 'single_observation' }), ctx({ targetDomain: 'user_preference' }))
  assert.equal(g.allowed, false)
})

test('single_observation 可注入 work / experience / external_fact → 允许', () => {
  for (const domain of ['work', 'experience', 'external_fact']) {
    const g = readGuard(ev({ authority: 'single_observation' }), ctx({ targetDomain: domain }))
    assert.equal(g.allowed, true, `single_observation 应允许 ${domain}`)
  }
})

test('agent_self_evaluation 任何域都拒绝', () => {
  for (const domain of CLAIM_DOMAINS) {
    const g = readGuard(ev({ authority: 'agent_self_evaluation' }), ctx({ targetDomain: domain }))
    assert.equal(g.allowed, false, `agent_self_evaluation 应拒绝 ${domain}`)
  }
})

test('agent_inference 任何域都拒绝（不进 active view）', () => {
  for (const domain of CLAIM_DOMAINS) {
    const g = readGuard(ev({ authority: 'agent_inference' }), ctx({ targetDomain: domain }))
    assert.equal(g.allowed, false, `agent_inference 应拒绝 ${domain}`)
  }
})

test('无 targetDomain 时只做基础检查（兼容现有行为）', () => {
  // 合法 active + scope 匹配 → 允许，且不经过矩阵
  assert.equal(readGuard(ev({ authority: 'agent_inference' }), ctx()).allowed, true)
  // quarantine 仍拒绝（基础检查不因无 targetDomain 而放宽）
  assert.equal(readGuard(ev({ state: 'quarantined' }), ctx()).allowed, false)
  // scope 不匹配仍拒绝
  assert.equal(readGuard(ev({ scopeId: 'workspace' }), ctx({ scopeId: 'user-global' })).allowed, false)
  // superseded 默认拒绝，allowSuperseded 放行
  assert.equal(readGuard(ev({ state: 'superseded' }), ctx()).allowed, false)
  assert.equal(readGuard(ev({ state: 'superseded' }), ctx({ allowSuperseded: true })).allowed, true)
})

test('temporal validAt 与矩阵正交：过期证据在矩阵允许时仍被 temporal 拒绝', () => {
  const g = readGuard(
    ev({ authority: 'external_information', validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-06-01T00:00:00Z' }),
    ctx({ targetDomain: 'work', validAt: '2026-09-01T00:00:00Z' }),
  )
  assert.equal(g.allowed, false)
  assert.ok(g.reasons.includes('expired'))
})

test('未知 authority：矩阵不适用，不拒绝（读边界 fail-open，兼容存量调用）', () => {
  const g = readGuard(ev({ authority: undefined }), ctx({ targetDomain: 'user_preference' }))
  assert.equal(g.allowed, true)
  assert.equal(authorityMayClaimDomain(undefined, 'user_preference'), true)
  assert.equal(authorityMayClaimDomain('nonexistent_authority', 'work'), true)
})

// ===================== 阶段 2.3：一次性任务指令判别（2026-09-09） =====================

test('isEphemeralPreference：指代当次上下文的偏好判为一次性', () => {
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '这个字体再大一些' }), true)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '这里改成方形' }), true)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '刚才那版好一点' }), true)
})

test('isEphemeralPreference：命令式动作且无耐久标记判为一次性', () => {
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '改一下默认值' }), true)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '先做轻量的' }), true)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '继续' }), true)
})

test('isEphemeralPreference：明确耐久表达的偏好一律保留', () => {
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '之后统一用 Bun' }), false)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '每步提交、feature 分支' }), false)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '一直用 pnpm，不喜欢 npm' }), false)
  // 耐久标记优先于指代/命令式（保守：宁可漏判也不误杀）
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '以后这个默认改成折叠' }), false)
})

test('isEphemeralPreference：非 user_preference 域不参与判别', () => {
  for (const d of ['user_fact', 'work', 'experience', 'style', 'external_fact']) {
    assert.equal(isEphemeralPreference({ claimDomain: d, text: '这个改一下' }), false)
  }
  assert.equal(isEphemeralPreference(null), false)
  assert.equal(isEphemeralPreference({ claimDomain: 'user_preference', text: '' }), false)
})

test('preferenceFilterAllows：off 全放行 / shadow 只统计不生效 / on 真过滤', () => {
  const durable = { claimDomain: 'user_preference', text: '之后统一用 Bun' }
  const ephemeral = { claimDomain: 'user_preference', text: '这个字体再大一些' }

  assert.equal(preferenceFilterAllows(durable, 'off'), true)
  assert.equal(preferenceFilterAllows(ephemeral, 'off'), true)

  assert.equal(preferenceFilterAllows(durable, 'shadow'), true)
  assert.equal(preferenceFilterAllows(ephemeral, 'shadow'), true) // shadow 保留

  assert.equal(preferenceFilterAllows(durable, 'on'), true)
  assert.equal(preferenceFilterAllows(ephemeral, 'on'), false) // 唯一会真丢的模式

  // 缺省 = shadow（默认先观察）
  assert.equal(preferenceFilterAllows(ephemeral), true)
})
