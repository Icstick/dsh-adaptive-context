// test/p3-profile-injection.test.mjs — PLAN-S2 P3 验收：用户画像（observation 轨）跨会话稳定注入。
// 验收信号（PLAN-S2 §8.5）：会话 A 数次声明/纠正确认 → consolidation 蒸出 user_model observation →
// 会话 B（同 workspace 另一工作流）pre-step 稳定收到画像；而单次观察/agent 自产蒸馏不得冒充偏好。
// 正交保障：原始 user_input 的 F7 跨会话闸门行为不回归。
// 运行：node test/p3-profile-injection.test.mjs（单文件直跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { compose, sectionOf } from '../src/composer.mjs'
import { observationToCandidate } from '../src/index.mjs'
import { MVP_SECTION_QUOTA } from '../src/budget.mjs'

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-p3-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { try { ledger.close() } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }) })
  return ledger
}

/** 造 observation 行（store 返回形状） */
const obsRow = (over = {}) => ({
  id: 'obs_1',
  scopeId: 'user-global',
  subject: '语言偏好',
  predicate: '是',
  claimDomain: 'user_preference',
  authority: 'user_correction',
  text: '中文为主、技术严谨、不要客服腔',
  evidenceIds: ['ev_1'],
  supersedes: [],
  state: 'active',
  observedAt: '2026-09-05T00:00:00.000Z',
  createdAt: 1788000000000,
  ...over,
})

const evidence = (over = {}) => ({
  id: 'ev_1', scopeId: 'user-global', state: 'active', sourceClass: 'user_input',
  authority: 'user_explicit', claimDomain: 'user_fact', confidence: 0.9,
  content: '用户消息内容', observedAt: '2026-09-05T00:00:00.000Z', ...over,
})

// ===================== observationToCandidate 形状 =====================

test('observationToCandidate：溯源 authority 透传、缺省回退 single_observation、sourceClass=observation、无 sessionId', () => {
  const c = observationToCandidate(obsRow(), 'user-global')
  assert.equal(c.authority, 'user_correction')
  assert.equal(c.sourceClass, 'observation')
  assert.equal(c.isObservation, true)
  assert.equal(c.sessionId, undefined, 'observation 无会话属性 → 不过跨会话闸门（稳定画像）')
  assert.equal(c.claimDomain, 'user_preference')
  assert.equal(c.content, '语言偏好 是：中文为主、技术严谨、不要客服腔')

  const fallback = observationToCandidate(obsRow({ authority: null }), 'user-global')
  assert.equal(fallback.authority, 'single_observation')
  const undef = observationToCandidate(obsRow({ authority: undefined }), 'user-global')
  assert.equal(undef.authority, 'single_observation')
})

// ===================== P3 验收：画像跨会话注入 =====================

test('验收：跨会话画像（user_correction 溯源 user_preference）稳定注入 user_model 段', () => {
  const cand = observationToCandidate(obsRow(), 'user-global')
  const r = compose([cand], {
    query: '现在的会话话题',
    scopeId: 'user-global',
    currentSessionId: 'session-B', // 另一个会话：画像是会话 A 蒸出的
  })
  assert.equal(r.items.length, 1, '跨会话画像 observation 必须注入')
  assert.equal(r.items[0].id, cand.id)
  assert.equal(sectionOf(r.items[0]), 'user_model')
  assert.equal(r.items[0].crossSession, undefined, 'observation 轨无会话 → 不施加 0.3 惩罚（区别于原始消息）')
  assert.equal(r.dropped.some((d) => d.reason.startsWith('cross-session')), false)
})

test('验收对照：原始跨会话 user_input 仍被 F7 闸门拦截（P3 不推翻 F7）', () => {
  const raw = evidence({ id: 'ev_raw', sessionId: 'session-A', content: '会话 A 的原始用户消息' })
  const obs = observationToCandidate(obsRow({ id: 'obs_x', text: '画像版内容' }), 'user-global')
  const r = compose([raw, obs], {
    query: '话题',
    scopeId: 'user-global',
    currentSessionId: 'session-B',
  })
  assert.ok(r.dropped.some((d) => d.id === 'ev_raw' && d.reason === 'cross-session-instructional'), 'F7 必须维持')
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'obs_x')
})

test('闸门语义：single_observation 溯源的 user_preference 画像被矩阵拒绝（观察到 ≠ 用户偏好）', () => {
  const cand = observationToCandidate(obsRow({ id: 'obs_single', authority: 'single_observation' }), 'user-global')
  const r = compose([cand], { query: '话题', scopeId: 'user-global', currentSessionId: 'session-B' })
  assert.equal(r.items.length, 0)
  assert.ok(r.dropped.some((d) => d.id === 'obs_single' && d.reason.includes('authority not permitted for target domain: user_preference')))
})

test('闸门语义：single_observation 溯源的 user_fact 观察可注入（事实性域）', () => {
  const cand = observationToCandidate(obsRow({ id: 'obs_fact', claimDomain: 'user_fact', authority: 'single_observation', text: '观察到用户项目用 pnpm' }), 'user-global')
  const r = compose([cand], { query: '工具', scopeId: 'user-global', currentSessionId: 'session-B' })
  assert.equal(r.items.length, 1)
  assert.equal(sectionOf(r.items[0]), 'user_model')
})

test('闸门语义：user_correction 溯源的 style 画像可注入 expression 段（风格被用户纠正过）', () => {
  const cand = observationToCandidate(obsRow({ id: 'obs_style', claimDomain: 'style', authority: 'user_correction', subject: '风格', text: '回复先给结论再展开' }), 'user-global')
  const r = compose([cand], { query: '颜色搭配', scopeId: 'user-global', currentSessionId: 'session-B' })
  assert.equal(r.items.length, 1)
  assert.equal(sectionOf(r.items[0]), 'expression')
})

test('闸门语义：agent 自评溯源的观察不进任何段（agent_self_evaluation 矩阵全拒绝）', () => {
  const cand = observationToCandidate(obsRow({ id: 'obs_self', claimDomain: 'experience', authority: 'agent_self_evaluation', text: 'agent 自评内容' }), 'user-global')
  const r = compose([cand], { query: '评估', scopeId: 'user-global', currentSessionId: 'session-B' })
  assert.equal(r.items.length, 0)
  assert.ok(r.dropped.some((d) => d.id === 'obs_self' && d.reason.includes('authority not permitted')))
})

test('配额与预算：高权威条目整条保留（不截断），装不下整条拒绝', () => {
  // ① 高权威 + 超过 60% 软上限但装得进 section 配额 → 整条注入、不截断
  const fits = observationToCandidate(obsRow({ id: 'obs_fit', text: '画像条目内容'.repeat(16) }), 'user-global')
  const r1 = compose([fits], { query: '话题', scopeId: 'user-global', currentSessionId: 'session-B', quota: MVP_SECTION_QUOTA })
  assert.equal(r1.items.length, 1, '装得下就必须注入')
  assert.equal(r1.items[0].truncated, false)
  assert.equal(r1.items[0].oversize, true)
  assert.ok(!r1.items[0].content.includes('截断'), '高权威条目不得被截断（截断会切掉条件从句）')
  // ② 高权威 + 超大装不进 section 配额 → 整条丢弃（结构化拒绝），绝不半条
  const huge = Array.from({ length: 6 }, (_, i) =>
    observationToCandidate(obsRow({ id: 'obs_q' + i, text: '画像条目内容 '.repeat(80) + i }), 'user-global'))
  const r2 = compose(huge, { query: '话题', scopeId: 'user-global', currentSessionId: 'session-B', quota: MVP_SECTION_QUOTA })
  assert.equal(r2.items.length, 0)
  assert.ok(r2.dropped.every((d) => d.reason.includes('high-authority kept whole')), JSON.stringify(r2.dropped.slice(0, 2)))
  // ③ 低权威长条目仍走截断（保留可回溯 id，不丢整条）
  const low = observationToCandidate(obsRow({ id: 'obs_low', authority: 'single_observation', claimDomain: 'user_fact', text: '观察内容 '.repeat(120) }), 'user-global')
  const r3 = compose([low], { query: '话题', scopeId: 'user-global', currentSessionId: 'session-B', quota: MVP_SECTION_QUOTA })
  assert.equal(r3.items.length, 1)
  assert.equal(r3.items[0].truncated, true)
  const sec3 = r3.items[0].section
  assert.ok((r3.telemetry.sectionTokens[sec3] ?? 0) <= MVP_SECTION_QUOTA[sec3], sec3 + ' 超配额')
})

// ===================== 端到端链路（真库：append → consolidate 形状 upsert → 注入面） =====================

test('端到端：真库溯源聚合 → observationToCandidate → compose 注入（会话 A 声明 → 会话 B 收到画像）', (t) => {
  const ledger = freshLedger(t)
  // 会话 A：用户声明 + 纠正（同一偏好，重复信号）
  const a = ledger.append(evInput('user_explicit', '会话A：项目依赖统一用 pnpm', 'sA:1'))
  const b = ledger.append(evInput('user_correction', '会话A：更正——还是用 bun 吧', 'sA:2'))
  // consolidation 蒸馏（模拟：LLM/规则产出一条 user_preference observation）
  const up = ledger.upsertObservation({
    subject: '包管理器', predicate: '偏好', claimDomain: 'user_preference',
    text: '用户项目依赖统一用 bun（曾用 pnpm 后更正）', evidenceIds: [a.id, b.id],
  })
  // 2026-09-09 非放大：evidenceIds 同时列了被更正的旧声明 → 取最弱 = user_explicit。
  // user_explicit 仍属高权威轨，画像注入路径不受影响（下面断言继续成立）。
  assert.equal(up.row.authority, 'user_explicit', '非放大聚合应取支撑证据中最弱的一条')

  // 会话 B 注入面（无词法重叠也要命中——observation 轨全文注入）
  const obsCand = observationToCandidate(ledger.listObservations('user-global')[0], 'user-global')
  const rawC = evidence({ id: 'ev_c', sessionId: 'session-B', content: 'B 的本会话消息' })
  const r = compose([rawC, obsCand], { query: '无关联话题', scopeId: 'user-global', currentSessionId: 'session-B' })
  assert.equal(r.items.length, 2, '本会话消息 + 跨会话画像都应注入')
  const ob = r.items.find((i) => i.id === up.id)
  assert.ok(ob, '画像 observation 必须在注入面')
  assert.equal(ob.authority, 'user_explicit')
  assert.ok(ob.content.includes('bun'))
})

function evInput(authority, content, ref) {
  return {
    sourceClass: authority === 'user_correction' ? 'user_correction' : 'user_input',
    authority,
    confidence: 0.9, durability: 0.5, sensitivity: 'private',
    claimDomain: authority === 'user_correction' ? 'user_preference' : 'user_fact',
    content,
    sourceRef: { sessionEventId: ref },
    sessionId: 'session-A',
  }
}
