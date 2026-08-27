// test/policy.test.mjs — B2 Promotion policy 评估器（feat/policy）。
// 验收 oracle（M3-PLAN §6.2 + EXPRESSION.md §3-7）：
//   1) classifyStrength 全表（7 authority + 未知 → not_eligible）
//   2) floors 不可降：min_events=1→2 / min_strong=0→1 / age=60→30 / require_same_conversation=false→true
//   3) auto_promote=false（默认）→ 全部 hold（留人工）
//   4) 各拒绝路径 reason 完整（§7 清单：auto/state/against/conflicting/strong/events/expired）
//   5) 年龄过滤（31 天前证据不计数；全过期 → evidence expired）
//   6) 同会话约束（跨会话组合不放大；同会话达标可提升）
//   7) 方向性（反对证据 → hold；反向纠正不计 strong；NEGATIVE_ONLY 无方向默认 neutral）
//   8) 达标路径：promote + policy 快照（floors 明细 + counts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyStrength,
  evaluateCandidate,
  resolvePolicyConfig,
  conversationKeyOf,
  resolveDirection,
  REASONS,
  stateNotProposedReason,
  strongInsufficientReason,
  eventsInsufficientReason,
  evidenceExpiredReason,
  POLICY_DEFAULTS,
  POLICY_FLOORS,
} from '../src/policy.mjs'

let seq = 0

/** 构造证据行（store.toEvidence camelCase 形状；字段可覆盖，兼容 snake_case）。 */
function evRow(overrides = {}) {
  return {
    id: 'ev_' + String(++seq).padStart(4, '0'),
    authority: 'user_explicit',
    claimDomain: 'style',
    observedAt: new Date().toISOString(),
    sourceRef: { sessionId: 'sess-1' },
    ...overrides,
  }
}

/** 距今 days 天前的 ISO 时间 */
function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** 单个 STRONG（user_explicit）支持证据 */
function strongSupport(overrides = {}) {
  return evRow({ authority: 'user_explicit', ...overrides })
}

/** 两个同会话 STRONG 支持证据 → 默认配置下应 promote */
function twoStrongRows() {
  return [strongSupport(), strongSupport()]
}

/** 自动路径配置：开启 master switch（其余全默认） */
const autoOn = { autoPromote: true }

// ── oracle 1：classifyStrength 全表 ────────────────────────────────────────

test('classifyStrength：STRONG 映射（user_correction / user_explicit）', () => {
  assert.equal(classifyStrength('user_correction'), 'STRONG')
  assert.equal(classifyStrength('user_explicit'), 'STRONG')
})

test('classifyStrength：NEGATIVE_ONLY / WEAK 映射', () => {
  assert.equal(classifyStrength('single_observation'), 'NEGATIVE_ONLY')
  assert.equal(classifyStrength('agent_self_evaluation'), 'WEAK')
})

test('classifyStrength：not eligible 映射（external_information + 其余非用户反馈 authority + 未知）', () => {
  assert.equal(classifyStrength('external_information'), 'not_eligible')
  assert.equal(classifyStrength('system_policy'), 'not_eligible')
  assert.equal(classifyStrength('agent_inference'), 'not_eligible')
  assert.equal(classifyStrength('bogus_authority'), 'not_eligible')
  assert.equal(classifyStrength(undefined), 'not_eligible')
})

// ── oracle 2：floors 不可降 ────────────────────────────────────────────────

test('floors：min_events=1 配置 → 仍强制 2', () => {
  const p = resolvePolicyConfig({ minEvents: 1, autoPromote: true })
  assert.equal(p.minEvents, 2)
  assert.deepEqual(p.floors.minEvents, { requested: 1, effective: 2 })
})

test('floors：min_strong=0 配置 → 仍强制 1', () => {
  const p = resolvePolicyConfig({ minStrong: 0 })
  assert.equal(p.minStrong, 1)
  assert.deepEqual(p.floors.minStrong, { requested: 0, effective: 1 })
})

test('floors：max_evidence_age_days=60 配置（放宽）→ 强制 30', () => {
  const p = resolvePolicyConfig({ maxEvidenceAgeDays: 60 })
  assert.equal(p.maxEvidenceAgeDays, 30)
  assert.deepEqual(p.floors.maxEvidenceAgeDays, { requested: 60, effective: 30 })
})

test('floors：require_same_conversation=false 配置 → 强制 true（不可关闭）', () => {
  const p = resolvePolicyConfig({ requireSameConversation: false })
  assert.equal(p.requireSameConversation, true)
})

test('floors：auto_promote 默认 false，仅显式 true 开启', () => {
  assert.equal(resolvePolicyConfig({}).autoPromote, false)
  assert.equal(resolvePolicyConfig({ autoPromote: false }).autoPromote, false)
  assert.equal(resolvePolicyConfig({ autoPromote: true }).autoPromote, true)
})

test('floors：更严配置原样保留（min_events=3 / age=7）', () => {
  const p = resolvePolicyConfig({ minEvents: 3, maxEvidenceAgeDays: 7 })
  assert.equal(p.minEvents, 3)
  assert.equal(p.maxEvidenceAgeDays, 7)
})

// ── oracle 3：auto_promote=false → 全部 hold ───────────────────────────────

test('auto_promote=false：证据完全达标也 hold（留人工）', () => {
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: twoStrongRows() })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, REASONS.AUTO_DISABLED)
  // 即使 state 非法/存在冲突，master switch 关闭时也统一 hold（§7 路径 1 最先）
  const weird = evaluateCandidate({ candidate: { state: 'promoted', conflictingCandidates: ['cand_x'] }, evidenceRows: twoStrongRows() })
  assert.equal(weird.decision, 'hold')
  assert.equal(weird.reason, REASONS.AUTO_DISABLED)
})

test('auto_promote=false：空证据也 hold，reason 一致', () => {
  const res = evaluateCandidate({ evidenceRows: [] })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, REASONS.AUTO_DISABLED)
})

// ── oracle 4：各拒绝路径 reason 完整（§7 清单）─────────────────────────────

test('path 2：state 非 proposed → reject + "state is X, not proposed"', () => {
  for (const state of ['promoted', 'rejected', 'superseded', 'rolled_back']) {
    const res = evaluateCandidate({ candidate: { state }, evidenceRows: twoStrongRows(), config: autoOn })
    assert.equal(res.decision, 'reject')
    assert.equal(res.reason, stateNotProposedReason(state))
  }
})

test('path 3：存在反对证据 → hold + "compatible evidence disagrees — left for review"', () => {
  const rows = [strongSupport(), strongSupport({ direction: 'opposes' })]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, REASONS.OPPOSING_EVIDENCE)
})

test('path 4：存在冲突候选 → hold + "a conflicting candidate exists — left for review"', () => {
  const res = evaluateCandidate({
    candidate: { state: 'proposed', conflictingCandidates: ['cand_other'] },
    evidenceRows: twoStrongRows(),
    config: autoOn,
  })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, REASONS.CONFLICTING_CANDIDATE)
  // 兼容对象数组形式
  const res2 = evaluateCandidate({
    candidate: { state: 'proposed', conflicting: [{ id: 'cand_other' }] },
    evidenceRows: twoStrongRows(),
    config: autoOn,
  })
  assert.equal(res2.decision, 'hold')
})

test('path 5：strong 不足 → hold + "N/M strong events (K supporting)"', () => {
  // 2 个 NEGATIVE_ONLY（显式支持方向）→ 事件数够但 strong=0
  const rows = [
    evRow({ authority: 'single_observation', direction: 'supports' }),
    evRow({ authority: 'single_observation', direction: 'supports' }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, strongInsufficientReason(0, 1, 0))
})

test('path 6：事件数不足 → hold + "N/M compatible events"', () => {
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: [strongSupport()], config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, eventsInsufficientReason(1, 2))
})

test('path 7：证据全部过期 → hold + "all compatible evidence expired"', () => {
  const rows = [
    strongSupport({ observedAt: daysAgo(31) }),
    strongSupport({ observedAt: daysAgo(45) }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, evidenceExpiredReason(30))
})

// ── oracle 5：年龄过滤 ─────────────────────────────────────────────────────

test('年龄过滤：31 天前证据不计数（1 新 + 1 旧 → 事件数不足）', () => {
  const rows = [strongSupport(), strongSupport({ observedAt: daysAgo(31) })]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, eventsInsufficientReason(1, 2))
})

test('年龄过滤：刚好 30 天（边界）→ 计入', () => {
  const rows = [strongSupport(), strongSupport({ observedAt: daysAgo(30) })]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
})

test('年龄过滤：更严配置（age=7）下 10 天前证据过期', () => {
  const rows = [strongSupport({ observedAt: daysAgo(10) }), strongSupport({ observedAt: daysAgo(10) })]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: { ...autoOn, maxEvidenceAgeDays: 7 } })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, evidenceExpiredReason(7))
})

test('年龄过滤：config.now 注入（确定性评估）', () => {
  const now = Date.parse('2026-08-28T00:00:00Z')
  const rows = [strongSupport({ observedAt: '2026-08-27T00:00:00Z' }), strongSupport({ observedAt: '2026-08-26T00:00:00Z' })]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: { ...autoOn, now } })
  assert.equal(res.decision, 'promote')
})

// ── oracle 6：同会话约束 ───────────────────────────────────────────────────

test('同会话约束：跨会话证据不组合（各 1 条 → 事件数不足）', () => {
  const rows = [
    strongSupport({ sourceRef: { sessionId: 'sess-a' } }),
    strongSupport({ sourceRef: { sessionId: 'sess-b' } }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, eventsInsufficientReason(1, 2))
})

test('同会话约束：同会话 2 条 → promote', () => {
  const rows = [
    strongSupport({ sourceRef: { sessionId: 'sess-a' } }),
    strongSupport({ sourceRef: { sessionId: 'sess-a' } }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
})

test('同会话约束：sessionEventId "sessionId:seq" 格式（extract.mjs 真实格式）', () => {
  const rows = [
    strongSupport({ sourceRef: { sessionEventId: 'sess-a:12' } }),
    strongSupport({ sourceRef: { sessionEventId: 'sess-a:13' } }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
  // 跨会话（同格式）不组合
  const rows2 = [
    strongSupport({ sourceRef: { sessionEventId: 'sess-a:12' } }),
    strongSupport({ sourceRef: { sessionEventId: 'sess-b:1' } }),
  ]
  const res2 = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows2, config: autoOn })
  assert.equal(res2.decision, 'hold')
})

test('同会话约束：目标会话 = 最新证据所在会话（多数会话不放大）', () => {
  // 会话 b 最新且只有 1 条 → 只计 b → 事件数不足（防止跨会话凑数）
  const rows = [
    strongSupport({ sourceRef: { sessionId: 'sess-a' }, observedAt: daysAgo(10) }),
    strongSupport({ sourceRef: { sessionId: 'sess-a' }, observedAt: daysAgo(9) }),
    strongSupport({ sourceRef: { sessionId: 'sess-b' }, observedAt: daysAgo(1) }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, eventsInsufficientReason(1, 2))
})

test('同会话约束：全部无会话信息 → 视为同一会话（缺失不 veto）', () => {
  const rows = [strongSupport({ sourceRef: undefined }), strongSupport({ sourceRef: undefined })]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
})

test('conversationKeyOf：解析优先级 sessionId > conversationId > sessionEventId', () => {
  assert.equal(conversationKeyOf({ sourceRef: { sessionId: 's', conversationId: 'c' } }), 's')
  assert.equal(conversationKeyOf({ sourceRef: { conversationId: 'c' } }), 'c')
  assert.equal(conversationKeyOf({ sourceRef: { sessionEventId: 'sess-9:42' } }), 'sess-9')
  assert.equal(conversationKeyOf({ sourceRef: { sessionEventId: 'plain-id' } }), 'plain-id')
  assert.equal(conversationKeyOf({}), '')
  assert.equal(conversationKeyOf({ sourceRef: { sessionEventId: '' } }), '')
})

// ── oracle 7：方向性 ───────────────────────────────────────────────────────

test('方向性：反向纠正（user_correction + direction=opposes）→ hold', () => {
  const rows = [
    strongSupport(),
    evRow({ authority: 'user_correction', direction: 'opposes' }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, REASONS.OPPOSING_EVIDENCE)
})

test('方向性：反向纠正不计 strong（1 支持 + 1 反向 → 先命中反对路径）', () => {
  const rows = [
    strongSupport(),
    evRow({ authority: 'user_correction', direction: 'opposes' }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  // 反对路径优先于 strong 不足（§7 顺序）
  assert.equal(res.reason, REASONS.OPPOSING_EVIDENCE)
})

test('方向性：STRONG 无显式方向 → 默认 supports', () => {
  assert.equal(resolveDirection(strongSupport()), 'supports')
  assert.equal(resolveDirection(evRow({ authority: 'user_correction' })), 'supports')
})

test('方向性：NEGATIVE_ONLY / WEAK 无显式方向 → 默认 neutral（不计数不反对）', () => {
  assert.equal(resolveDirection(evRow({ authority: 'single_observation' })), 'neutral')
  assert.equal(resolveDirection(evRow({ authority: 'agent_self_evaluation' })), 'neutral')
  // neutral 不构成 compatible events：2 NEGATIVE_ONLY 无方向 → 事件数 0 → 不足
  const rows = [
    evRow({ authority: 'single_observation' }),
    evRow({ authority: 'single_observation' }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  // §7 顺序：strong 检查先于事件数检查 → 表面 reason 是 strong 不足
  assert.equal(res.reason, strongInsufficientReason(0, 1, 0))
})

test('方向性：显式 direction 覆盖 STRONG 默认（direction=neutral → 不计数）', () => {
  const rows = [
    strongSupport({ direction: 'neutral' }),
    strongSupport(),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'hold')
  assert.equal(res.reason, eventsInsufficientReason(1, 2))
})

// ── oracle 8：达标路径 + policy 快照 ───────────────────────────────────────

test('达标：2 STRONG 同会话 + auto_promote=true → promote', () => {
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: twoStrongRows(), config: autoOn })
  assert.equal(res.decision, 'promote')
  assert.ok(res.reason.includes('2/2 compatible events'))
  assert.ok(res.reason.includes('2/1 strong supporting'))
})

test('达标：1 STRONG + 1 NEGATIVE_ONLY(显式支持) → events=2/strong=1 → promote', () => {
  const rows = [
    strongSupport(),
    evRow({ authority: 'single_observation', direction: 'supports' }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
})

test('policy 快照：生效参数 + floors 明细 + counts + evaluatedAt（审计用）', () => {
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: twoStrongRows(), config: { minEvents: 1, autoPromote: true } })
  const p = res.policy
  assert.equal(p.minEvents, 2) // floor 收口
  assert.deepEqual(p.floors.minEvents, { requested: 1, effective: 2 })
  assert.equal(p.minStrong, 1)
  assert.equal(p.maxEvidenceAgeDays, 30)
  assert.equal(p.requireSameConversation, true)
  assert.equal(p.autoPromote, true)
  assert.ok(typeof p.evaluatedAt === 'string' && !Number.isNaN(Date.parse(p.evaluatedAt)))
  assert.deepEqual(p.counts, {
    eligible: 2, fresh: 2, expired: 0, sameConversation: 2,
    supports: 2, opposes: 0, strong: 2, strongSupporting: 2, compatibleEvents: 2,
  })
})

// ── 输入鲁棒性 ─────────────────────────────────────────────────────────────

test('输入鲁棒性：evidenceRows 缺省/undefined → 事件数不足', () => {
  const res1 = evaluateCandidate({ candidate: { state: 'proposed' }, config: autoOn })
  assert.equal(res1.decision, 'hold')
  const res2 = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: undefined, config: autoOn })
  assert.equal(res2.decision, 'hold')
})

test('输入鲁棒性：snake_case 字段（DB 原始行）与 camelCase 等效', () => {
  const rows = [
    evRow({ observed_at: new Date().toISOString(), source_ref: { session_id: 'sess-x' } }),
    evRow({ observed_at: new Date().toISOString(), source_ref: { session_id: 'sess-x' } }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
})

test('输入鲁棒性：not_eligible 证据（external_information）不计数、不反对', () => {
  const rows = [
    strongSupport(),
    strongSupport(),
    evRow({ authority: 'external_information' }),
  ]
  const res = evaluateCandidate({ candidate: { state: 'proposed' }, evidenceRows: rows, config: autoOn })
  assert.equal(res.decision, 'promote')
  assert.equal(res.policy.counts.eligible, 2)
})

// ── 契约常量 ───────────────────────────────────────────────────────────────

test('POLICY_FLOORS / POLICY_DEFAULTS 固定（EXPRESSION.md §3 表）', () => {
  assert.equal(POLICY_FLOORS.minEvents, 2)
  assert.equal(POLICY_FLOORS.minStrong, 1)
  assert.equal(POLICY_FLOORS.maxEvidenceAgeDays, 30)
  assert.equal(POLICY_FLOORS.requireSameConversation, true)
  assert.equal(POLICY_FLOORS.autoPromote, false)
  assert.equal(POLICY_DEFAULTS.minEvents, 2)
  assert.equal(POLICY_DEFAULTS.autoPromote, false)
})
