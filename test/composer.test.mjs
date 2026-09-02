// test/composer.test.mjs — Context Composer 测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compose, lexicalScore, utilityOf, renderSourceLabelled, sectionOf, shortSessionId,
} from '../src/composer.mjs'
import { packBySection, estimateTokens, MVP_SECTION_QUOTA, MVP_TOTAL_BUDGET } from '../src/budget.mjs'

const ev = (over = {}) => ({
  id: 'ev_1',
  scopeId: 'user-global',
  state: 'active',
  sourceClass: 'user_input',
  authority: 'user_explicit',
  claimDomain: 'user_fact',
  confidence: 1,
  content: '用户偏好 TypeScript',
  observedAt: new Date().toISOString(),
  ...over,
})

test('compose 基础：合格候选进入，quarantine 被过滤', () => {
  const r = compose([
    ev({ id: 'a', content: '用 pnpm 管理依赖' }),
    ev({ id: 'b', state: 'quarantined', content: '恶意内容' }),
  ], { query: '包管理器', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'a')
  assert.equal(r.dropped.some(d => d.reason.includes('not injectable')), true)
  assert.ok(r.telemetry.retrieved >= 2)
})

test('compose token 预算：总预算 ≤ MVP_TOTAL_BUDGET', () => {
  const cands = Array.from({ length: 20 }, (_, i) =>
    ev({ id: 'c' + i, content: '这是一个比较长的测试内容'.repeat(10) + i }))
  // query 必须与 content 无子串包含关系，否则新 self-echo 过滤会误伤本测试（预算语义失效）
  const r = compose(cands, { query: '预算', scopeId: 'user-global' })
  assert.ok(r.telemetry.totalTokens <= MVP_TOTAL_BUDGET)
  assert.equal(r.telemetry.admitted, r.items.length)
})

test('explicit_correction_boost 提高 utility', () => {
  const a = utilityOf(ev({ explicitCorrection: true, content: '更正：用 Bun' }), { query: 'bun' })
  const b = utilityOf(ev({ content: '用 pnpm' }), { query: 'bun' })
  assert.ok(a.utility > b.utility)
})

test('lexicalScore：CJK 子串匹配', () => {
  assert.equal(lexicalScore('包管理器', '这个项目用 pnpm 作为包管理器'), 1)
  assert.equal(lexicalScore('包管理器', '完全无关内容'), 0) // bigram 无重叠
  assert.ok(lexicalScore('喜欢什么风格回答', '用户喜欢详细的技术回答') > 0) // bigram 部分重叠
  assert.equal(lexicalScore('喜欢什么风格回答', '用户喜欢详细的技术回答'), 2 / 7) // 2/7 窗口命中
})

test('sectionOf：claimDomain → section', () => {
  assert.equal(sectionOf(ev({ claimDomain: 'user_fact' })), 'user_model')
  assert.equal(sectionOf(ev({ claimDomain: 'work' })), 'work_state')
  assert.equal(sectionOf(ev({ claimDomain: 'style' })), 'expression')
  assert.equal(sectionOf(ev({ claimDomain: 'external_fact' })), 'memory')
})

test('packBySection：超 quota 截断', () => {
  const cands = Array.from({ length: 10 }, (_, i) => ({
    id: 'x' + i, section: 'memory', utility: 1, tokens: 100, content: 'x'.repeat(140),
  }))
  const r = packBySection(cands)
  assert.ok(r.items.length <= 3) // memory quota 300 / 100 = 3
  assert.equal(r.totalTokens <= 300, true)
})

test('renderSourceLabelled：带来源标签', () => {
  const s = renderSourceLabelled([ev({ id: 'a', content: '用 pnpm' })])
  assert.ok(s.includes('[acp:user_input | id=a | domain=user_fact]'))
  assert.ok(s.includes('用 pnpm'))
})

test('estimateTokens 中英分算（2026-09-02：旧 0.7 系数对中文低估 30-40%）', () => {
  // CJK 1.0 token/字：4 个汉字 = 4 token（旧实现给 3，注入预算长期账实不符）
  assert.equal(estimateTokens('你好世界'), 4)
  // 非 CJK 0.3 token/字：20 个 ASCII ≈ 6 token
  assert.equal(estimateTokens('abcdefghijklmnopqrst'), 6)
  // 混合：中文按 1.0 + 英文按 0.3
  assert.equal(estimateTokens('你好abcde'), Math.ceil(2 * 1 + 5 * 0.3))
})

// ===== T1 self-echo 过滤（验收 oracle）=====

test('T1 self-echo：候选 content 等于 query → dropped self-echo', () => {
  const msg = '继续 M2 讨论吧，另外给这个 session 重写个标题'
  const r = compose([ev({ id: 's1', content: msg })], { query: msg, scopeId: 'user-global' })
  assert.equal(r.items.length, 0)
  assert.equal(r.dropped.filter((d) => d.reason === 'self-echo').length, 1)
  assert.equal(r.dropped[0].id, 's1')
})

test('T1 self-echo：候选 content 包含 query（query 是子串）→ dropped self-echo', () => {
  const r = compose(
    [ev({ id: 's2', content: '我们继续 M2 讨论吧，先把技术点拆解一下' })],
    { query: 'M2 讨论', scopeId: 'user-global' },
  )
  assert.equal(r.items.length, 0)
  assert.equal(r.dropped.filter((d) => d.reason === 'self-echo').length, 1)
})

test('T1 self-echo：query 包含候选 content（候选是子串）→ 保留', () => {
  const r = compose(
    [ev({ id: 's3', content: '用 pnpm 管理依赖' })],
    { query: '这个项目用 pnpm 管理依赖，你觉得怎么样？', scopeId: 'user-global' },
  )
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 's3')
  assert.equal(r.dropped.some((d) => d.reason === 'self-echo'), false)
})

test('T1 self-echo：query 为空时不启用过滤', () => {
  const msg = '任意消息内容'
  const r = compose([ev({ id: 's4', content: msg })], { scopeId: 'user-global' }) // 无 query
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped.some((d) => d.reason === 'self-echo'), false)
})

// ===== T2 contentHash dedup（验收 oracle）=====

test('T2 contentHash dedup：三条相同 content 不同 id → 注入 1 条，dropped 2 条 duplicate-content', () => {
  const r = compose([
    ev({ id: 'd1', content: '用户偏好 TypeScript' }),
    ev({ id: 'd2', content: '用户偏好 TypeScript' }),
    ev({ id: 'd3', content: '用户偏好 TypeScript' }),
  ], { query: '语言偏好', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 2)
  assert.equal(r.items[0].content, '用户偏好 TypeScript')
})

test('T2 contentHash dedup：同 content 保留 utility 最高的一条', () => {
  const r = compose([
    ev({ id: 'u1', content: '用户偏好 TypeScript', confidence: 0.3 }),
    ev({ id: 'u2', content: '用户偏好 TypeScript', confidence: 0.9 }),
  ], { query: '语言偏好', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'u2') // confidence 高 → utility 高
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 1)
  assert.equal(r.dropped.find((d) => d.reason === 'duplicate-content').id, 'u1')
})

test('T2 contentHash dedup：显式 contentHash 优先于内容计算', () => {
  const r = compose([
    ev({ id: 'h1', content: '内容 A', contentHash: 'same-hash' }),
    ev({ id: 'h2', content: '内容 B', contentHash: 'same-hash' }),
  ], { query: '查询', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 1)
})

test('compose validAt 过滤：过期候选被 readGuard 拒绝（expired）', () => {
  const r = compose([
    ev({ id: 't1', content: '2026 上半年规则', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-06-01T00:00:00.000Z' }),
    ev({ id: 't2', content: '2026 下半年规则' }),
  ], { query: '现在适用的规则是什么？', scopeId: 'user-global', validAt: '2026-09-01T00:00:00.000Z' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 't2')
  assert.ok(r.dropped.some(d => d.id === 't1' && d.reason.includes('expired')))
})

test('compose validAt 过滤：未生效候选被拒绝（not yet valid）', () => {
  const r = compose([
    ev({ id: 'f', content: '未来才生效的规则', validFrom: '2026-10-01T00:00:00.000Z' }),
  ], { query: '现在适用的规则是什么？', scopeId: 'user-global', validAt: '2026-09-01T00:00:00.000Z' })
  assert.equal(r.items.length, 0)
  assert.ok(r.dropped.some(d => d.id === 'f' && d.reason.includes('not yet valid')))
})

test('compose 未传 validAt：不施加 temporal 过滤（now 视图默认）', () => {
  const r = compose([
    ev({ id: 'e', content: '旧规则', validUntil: '2026-06-01T00:00:00.000Z' }),
  ], { query: '现在的规则是什么？', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
})

// ===================== M3 A3：多源融合（providerWeights / 归一化 / 跨源 dedup） =====================

/** Provider 候选（experience 域，readGuard 放行） */
const pcand = (over = {}) => ({
  id: 'p_1',
  scopeId: 'user-global',
  state: 'active',
  sourceClass: 'external_tool',
  authority: 'external_information',
  claimDomain: 'experience',
  confidence: 0.5,
  content: 'alpha 记忆片段甲',
  providerScore: 0.5,
  sourceProvider: 'alpha',
  ...over,
})

const A3_QUERY = { query: '工具链选择', scopeId: 'user-global', targetDomain: 'work', maxTokens: 900 }

test('A3 多源同 contentHash：跨源候选合并为 1 条，保留 utility 最高', () => {
  const alpha = pcand({ id: 'alpha:1', content: '相同记忆片段', providerScore: 0.9 })
  const beta = pcand({ id: 'beta:1', content: '相同记忆片段', sourceProvider: 'beta', providerScore: 0.5, confidence: 0.9 })
  const r = compose([alpha, beta], { ...A3_QUERY, hasProvider: true, providerWeights: { alpha: 1, beta: 1 } })
  assert.equal(r.items.length, 1, '同 hash 跨源合并')
  assert.equal(r.items[0].id, 'beta:1', '保留 utility 最高（beta 归一化后语义持平，confidence 更高）')
  assert.equal(r.dropped.filter((d) => d.reason === 'duplicate-content').length, 1)
  assert.equal(r.dropped.find((d) => d.reason === 'duplicate-content').id, 'alpha:1')
})

test('A3 providerWeights：权重放大 provider semantic 分量（低分高权重反超）', () => {
  const alpha = pcand({ id: 'alpha:1', providerScore: 0.9 })
  const beta = pcand({ id: 'beta:1', sourceProvider: 'beta', content: 'beta 记忆片段乙', providerScore: 0.3 })
  const r = compose([alpha, beta], { ...A3_QUERY, hasProvider: true, providerWeights: { alpha: 1, beta: 4 } })
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].id, 'beta:1', 'beta 归一化 1.0 × 4 压过 alpha 归一化 1.0 × 1')
})

test('A3 归一化：同权重下跨 provider 分数尺度可比（0.9 与 0.5 归一化后相等）', () => {
  const alpha = pcand({ id: 'alpha:1', providerScore: 0.9, confidence: 0.5 })
  const beta = pcand({ id: 'beta:1', sourceProvider: 'beta', providerScore: 0.5, confidence: 0.7 })

  // 归一化路径（providerWeights 提供）：两者 semantic 均为 1.0 → beta 靠 confidence 胜出
  const norm = compose([alpha, beta], { ...A3_QUERY, hasProvider: true, providerWeights: { alpha: 1, beta: 1 } })
  assert.equal(norm.items[0].id, 'beta:1')

  // M2 路径（无 providerWeights）：raw providerScore 直接参与 → alpha(0.9) 胜出
  const legacy = compose([alpha, beta], { ...A3_QUERY, hasProvider: true })
  assert.equal(legacy.items[0].id, 'alpha:1')
})

test('A3 hasProvider=false：providerWeights 不生效（M2 回归，semantic 仍并入 lexical）', () => {
  const alpha = pcand({ id: 'alpha:1', providerScore: 0.9 })
  const beta = pcand({ id: 'beta:1', sourceProvider: 'beta', providerScore: 0.3 })
  const withWeights = compose([alpha, beta], { ...A3_QUERY, hasProvider: false, providerWeights: { alpha: 1, beta: 4 } })
  const withoutWeights = compose([alpha, beta], { ...A3_QUERY, hasProvider: false })
  assert.deepEqual(withWeights.items.map((i) => i.id), withoutWeights.items.map((i) => i.id))
  assert.deepEqual(withWeights.items.map((i) => i.utility), withoutWeights.items.map((i) => i.utility))
})

test('A3 单 provider 与 M2 排序一致（回归）：归一化只改尺度不改次序', () => {
  const a = pcand({ id: 'a', content: 'a 记忆片段', providerScore: 0.9 })
  const b = pcand({ id: 'b', content: 'b 记忆片段', providerScore: 0.6 })
  const withWeights = compose([a, b], { ...A3_QUERY, hasProvider: true, providerWeights: { alpha: 1 } })
  const legacy = compose([a, b], { ...A3_QUERY, hasProvider: true })
  assert.deepEqual(withWeights.items.map((i) => i.id), legacy.items.map((i) => i.id))
})
// ===================== 会话隔离（2026-08-30，ISSUES-INJECTION-ISOLATION.md） =====================

const sev = (over = {}) => ev({ ...over })

test('会话隔离默认（non-instructional）：跨会话 user_input 被闸门拦截，agent_authored 放行', () => {
  const cands = [
    sev({ id: 'same-user', content: '本会话用户说的', sessionId: 'cur-session' }),
    sev({ id: 'other-user', content: '其他会话的用户指令', sessionId: 'other-session' }),
    sev({ id: 'other-agent', content: '其他会话的经验总结', sessionId: 'other-session', sourceClass: 'agent_authored', authority: 'single_observation', claimDomain: 'experience' }),
    sev({ id: 'no-sid', content: '外部源（无会话）' }),
  ]
  const r = compose(cands, { query: '隔离策略', scopeId: 'user-global', currentSessionId: 'cur-session' })
  const ids = r.items.map((i) => i.id)
  assert.ok(ids.includes('same-user'), '本会话 user_input 必须进入')
  assert.ok(!ids.includes('other-user'), '跨会话 user_input 默认不注入')
  assert.ok(ids.includes('other-agent'), '跨会话 agent_authored 允许注入')
  assert.ok(ids.includes('no-sid'), '无 sessionId 候选不受闸门影响')
  assert.ok(r.dropped.some((d) => d.id === 'other-user' && d.reason === 'cross-session-instructional'))
  // 跨会话候选带 crossSession 标记（供 utility 惩罚）
  const cross = r.items.find((i) => i.id === 'other-agent')
  assert.equal(cross.crossSession, true)
})

test('会话隔离 none：跨会话内容全部拦截', () => {
  const cands = [
    sev({ id: 'same', content: '本会话内容', sessionId: 'cur-session' }),
    sev({ id: 'other', content: '跨会话内容', sessionId: 'other-session' }),
  ]
  const r = compose(cands, { query: '隔离策略', scopeId: 'user-global', currentSessionId: 'cur-session', crossSessionPolicy: 'none' })
  assert.deepEqual(r.items.map((i) => i.id), ['same'])
  assert.ok(r.dropped.some((d) => d.id === 'other' && d.reason === 'cross-session-blocked'))
})

test('会话隔离 all：跨会话 user_input 允许但带惩罚标记', () => {
  const cands = [
    sev({ id: 'other-user', content: '其他会话的用户指令', sessionId: 'other-session' }),
  ]
  const r = compose(cands, { query: '隔离策略', scopeId: 'user-global', currentSessionId: 'cur-session', crossSessionPolicy: 'all' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].crossSession, true)
})

test('utilityOf：crossSession 惩罚系数 0.3', () => {
  const a = utilityOf(sev({ content: '包管理器用 pnpm', crossSession: true }), { query: '包管理器' })
  const b = utilityOf(sev({ content: '包管理器用 pnpm' }), { query: '包管理器' })
  assert.ok(a.utility < b.utility)
  assert.ok(Math.abs(a.utility - b.utility * 0.3) < 1e-9)
})

test('不传 currentSessionId → 维持旧行为（不隔离不惩罚）', () => {
  const cands = [
    sev({ id: 'x', content: '任意内容', sessionId: 'some-session' }),
  ]
  const r = compose(cands, { query: '隔离策略', scopeId: 'user-global' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].crossSession, undefined)
})

test('renderSourceLabelled：跨会话条目带 session 短码与一次性引导语', () => {
  const items = [
    sev({ id: 'a', content: '本会话内容', sessionId: 'cur-session-1234' }),
    sev({ id: 'b', content: '跨会话内容一', sessionId: 'other-session-9999', sourceClass: 'agent_authored' }),
    sev({ id: 'c', content: '跨会话内容二', sessionId: 'other-session-9999', sourceClass: 'agent_authored' }),
  ]
  const s = renderSourceLabelled(items, { currentSessionId: 'cur-session-1234' })
  // 引导语只出现一次
  assert.equal(s.includes('以下条目来自其他会话的历史记录'), true)
  assert.equal((s.match(/以下条目来自其他会话的历史记录/g) ?? []).length, 1)
  // 本会话条目无 session 标签
  assert.ok(!s.includes('[acp:user_input | id=a | domain=user_fact | session='), s)
  // 跨会话条目带短码标签
  assert.ok(s.includes('[acp:agent_authored | id=b | domain=user_fact | session=other-se'), s)
  assert.ok(s.includes('session=other-se'), s)
})

test('renderSourceLabelled：无 currentSessionId 时维持原格式（无引导语无标签）', () => {
  const s = renderSourceLabelled([sev({ id: 'a', content: '内容', sessionId: 'x-session' })])
  assert.ok(!s.includes('以下条目来自其他会话'))
  assert.ok(!s.includes('| session='))
  assert.equal(s, '[acp:user_input | id=a | domain=user_fact] 内容')
})
test('shortSessionId：去 session- 前缀，保证短码有辨识度', () => {
  assert.equal(shortSessionId('session-bf9fa4e5-bd66-43ed-bc7'), 'bf9fa4e5')
  assert.equal(shortSessionId('28df8704-ee65-444a-bbb4-bb9ce3a34cef'), '28df8704')
  assert.equal(shortSessionId('session-'), 'session-') // 极端：前缀即全部 → 原样
})

test('renderSourceLabelled：session- 前缀会话 id 的短码不含退化前缀', () => {
  const items = [
    sev({ id: 'x', content: '跨会话内容', sessionId: 'session-bf9fa4e5-bd66-43ed-bc7', sourceClass: 'agent_authored' }),
  ]
  const s = renderSourceLabelled(items, { currentSessionId: 'session-12345678-xxxx' })
  assert.ok(s.includes('session=bf9fa4e5'), s)
  assert.ok(!s.includes('session=session-'), s)
})



