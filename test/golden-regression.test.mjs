// test/golden-regression.test.mjs — 黄金回归集：历史真实问题防复发（P0，2026-09-07）。
//
// 每条用例 = 一个曾发生并修复过的问题/契约，锚定可观察行为：
//   G1  F3：system-reminder 注入文本不得入 ledger（2026-08-30）
//   G2  压缩 checkpoint 摘要不得冒充 user_fact（2026-09-03 防御）
//   G3  D2-A：子代理会话消息降权，不污染 user_fact（含父 prompt）
//   G4  D2：coordinator / subagent-settled 一律 agent_authored
//   G5  D1：跨会话注入闸门与惩罚系数存在且默认收敛（none/non-instructional/all）
//   G6  authority 一致性校验：sourceClass→authority 强制映射不可绕过
//   G7  资格矩阵：external_information→experience ✓ / single_observation 不进 preference
//   G8  classifyStrength：仅 user_correction/user_explicit 为 STRONG
//   G9  预算承诺：MVP 900 / v0.1 1200 / soft 6000 / hard 8000；section quota 合计=900
//   G10 候选状态机：proposed --supersede--> superseded 契约存在（Level1 撤销语义）
//
// 运行：node --test test/golden-regression.test.mjs（或 pnpm test 全量）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEvidenceWorthy, isSystemInjected, isCompactionCheckpoint,
  sourceClassOf, toEvidenceCandidate,
} from '../src/extract.mjs'
import {
  assertAuthorityConsistent, agentAuthoredAuthority,
  authorityMayClaimDomain, AUTHORITY_DOMAIN_MATRIX,
} from '../src/governance.mjs'
import { classifyStrength } from '../src/policy.mjs'
import {
  MVP_TOTAL_BUDGET, V01_TOTAL_BUDGET, SOFT_MAX, HARD_MAX,
  MVP_SECTION_QUOTA, MVP_SECTION_TOTAL,
} from '../src/budget.mjs'
import {
  CROSS_SESSION_PENALTY, CROSS_SESSION_POLICIES,
} from '../src/composer.mjs'
import {
  CANDIDATE_STATES, CANDIDATE_EVENTS, TRANSITION_EVENTS, TRANSITIONS,
} from '../src/candidate.mjs'

// ---------- G1：system-reminder 跳过（F3，2026-08-30） ----------
test('G1 system-reminder 注入文本不是用户输入，不得入 ledger', () => {
  const injected = '<system-reminder>你是一名资深工程师……</system-reminder>'
  assert.equal(isSystemInjected(injected), true)
  // 即使包在 user/message 形态里也必须被 isEvidenceWorthy 拒绝
  assert.equal(isEvidenceWorthy({ type: 'user/message', id: 'g1a', content: injected }), false)
  // 正常用户消息不受影响
  assert.equal(isEvidenceWorthy({ type: 'user/message', id: 'g1b', content: '项目用 pnpm' }), true)
})

// ---------- G2：压缩 checkpoint 不是用户输入（2026-09-03 防御） ----------
test('G2 压缩重建摘要（surfaceOp=replace）不得入 ledger', () => {
  const cp = { type: 'user/message', id: 'g2a', content: '已压缩 N 条消息……', surfaceOp: { op: 'replace', sourceEventSeqs: [1, 2, 3] } }
  assert.equal(isCompactionCheckpoint(cp), true)
  assert.equal(isEvidenceWorthy(cp), false)
  // 普通追加消息 surfaceOp 缺失/append → 正常
  assert.equal(isCompactionCheckpoint({ type: 'user/message', id: 'g2b', content: 'x' }), false)
})

// ---------- G3：子代理会话降权（D2-A） ----------
test('G3 子代理会话中的 user 消息（含父 prompt）降权为 agent 产物', () => {
  const ev = {
    type: 'agent/inbox/spliced', seq: 1,
    data: { inserted: [{ content: [{ type: 'text', text: '帮我调研 MCP server' }], source: { kind: 'user' }, role: 'user' }] },
  }
  const normal = toEvidenceCandidate(ev, { sessionId: 'main-session' })
  assert.equal(normal.authority, 'user_explicit')
  assert.equal(normal.claimDomain, 'user_fact')
  const sub = toEvidenceCandidate(ev, { sessionId: 'sub-session', subagent: true })
  // 降权：不得以 user_explicit/user_fact 身份进入用户画像
  assert.notEqual(sub.authority, 'user_explicit')
  assert.notEqual(sub.claimDomain, 'user_fact')
})

// ---------- G4：coordinator / subagent-settled → agent_authored（D2） ----------
test('G4 协调者续派与子代理完成通知是 agent 产物，不是 user_input', () => {
  for (const kind of ['coordinator', 'subagent-settled']) {
    const ev = { type: 'agent/inbox/spliced', id: 'g4a', data: { inserted: [{ source: { kind }, content: [{ type: 'text', text: '任务完成' }] }] } }
    assert.equal(sourceClassOf(ev), 'agent_authored', 'kind=' + kind)
  }
})

// ---------- G5：跨会话注入闸门与惩罚（D1，2026-08-30） ----------
test('G5 跨会话候选默认收敛：闸门含 none，惩罚系数 0.3', () => {
  assert.deepEqual(CROSS_SESSION_POLICIES, ['none', 'non-instructional', 'all'])
  assert.equal(CROSS_SESSION_PENALTY, 0.3)
})

// ---------- G6：authority 一致性强制映射（安全核心） ----------
test('G6 sourceClass→authority 映射不可绕过', () => {
  assert.equal(assertAuthorityConsistent('user_input', 'user_explicit'), true)
  assert.equal(assertAuthorityConsistent('user_correction', 'user_correction'), true)
  assert.equal(assertAuthorityConsistent('external_tool', 'external_information'), true)
  assert.throws(() => assertAuthorityConsistent('user_input', 'agent_inference'), TypeError)
  assert.throws(() => assertAuthorityConsistent('user_correction', 'user_explicit'), TypeError)
  assert.equal(agentAuthoredAuthority('self_eval'), 'agent_self_evaluation')
  assert.equal(agentAuthoredAuthority('inference'), 'agent_inference')
  assert.equal(agentAuthoredAuthority('other'), 'single_observation')
})

// ---------- G7：authority→claimDomain 资格矩阵（2026-08-25 契约） ----------
test('G7 资格矩阵：external 可进 experience；single_observation 不进 preference/style', () => {
  assert.equal(authorityMayClaimDomain('external_information', 'experience'), true)
  assert.equal(authorityMayClaimDomain('user_explicit', 'user_preference'), true)
  assert.equal(authorityMayClaimDomain('single_observation', 'user_fact'), true)
  assert.equal(authorityMayClaimDomain('single_observation', 'user_preference'), false)
  assert.equal(authorityMayClaimDomain('single_observation', 'style'), false)
  // agent 推断与自我评价永不进 active view
  for (const d of Object.keys(AUTHORITY_DOMAIN_MATRIX.user_explicit)) {
    assert.equal(authorityMayClaimDomain('agent_inference', d), false)
    assert.equal(authorityMayClaimDomain('agent_self_evaluation', d), false)
  }
})

// ---------- G8：classifyStrength 资格（promotion 输入侧） ----------
test('G8 仅 user_correction/user_explicit 授予 STRONG', () => {
  assert.equal(classifyStrength('user_correction'), 'STRONG')
  assert.equal(classifyStrength('user_explicit'), 'STRONG')
  assert.equal(classifyStrength('single_observation'), 'NEGATIVE_ONLY')
  assert.equal(classifyStrength('agent_self_evaluation'), 'WEAK')
  for (const a of ['system_policy', 'agent_inference', 'external_information']) {
    assert.equal(classifyStrength(a), 'not_eligible', a)
  }
})

// ---------- G9：预算三级承诺 + section quota ----------
test('G9 预算承诺不回退：900/1200/6000/8000，quota 合计=900', () => {
  assert.equal(MVP_TOTAL_BUDGET, 900)
  assert.equal(V01_TOTAL_BUDGET, 1200)
  assert.equal(SOFT_MAX, 6000)
  assert.equal(HARD_MAX, 8000)
  assert.equal(MVP_SECTION_TOTAL, 900)
  assert.deepEqual(Object.keys(MVP_SECTION_QUOTA).sort(), ['expression', 'memory', 'user_model', 'work_state'])
  assert.equal(MVP_SECTION_QUOTA.memory, 350)
  assert.equal(MVP_SECTION_QUOTA.user_model, 180)
  assert.equal(MVP_SECTION_QUOTA.work_state, 250)
  assert.equal(MVP_SECTION_QUOTA.expression, 120)
})

// ---------- G10：候选状态机 supersede 契约 ----------
test('G10 proposed 可被 supersede；superseded 为终态（撤销语义存在）', () => {
  assert.ok(CANDIDATE_STATES.includes('superseded'))
  assert.ok(CANDIDATE_EVENTS.includes('supersede'))
  assert.ok(TRANSITION_EVENTS.includes('supersede'))
  assert.deepEqual(TRANSITIONS.proposed, ['promote', 'reject', 'supersede'])
  assert.deepEqual(TRANSITIONS.superseded, []) // 终态
})
