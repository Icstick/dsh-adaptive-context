// test/ledger-release.test.mjs — P1-4.1 S2/S3 跨机导入与放行的纯函数验收
// 运行：node --test test/ledger-release.test.mjs
// 覆盖：质量闸门三类拒因 / planImport 的域过滤·内容键去重·改写为 quarantined
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qualityVerdict, isEnglishOnly, EPHEMERAL_RE, SELFREF_SUBJECT_RE } from '../scripts/ledger-release.mjs'
import { planImport, DEFAULT_DOMAINS } from '../scripts/ledger-import.mjs'

const row = (over = {}) => ({ subject: '用户', predicate: '偏好', claimDomain: 'user_preference', text: '偏好先出计划文档', ...over })

test('质量闸门：三类噪声各自被拦，正常行通过', () => {
  assert.equal(qualityVerdict(row()), null)
  assert.equal(qualityVerdict(row({ text: '用户同意继续当前任务' })), 'ephemeral')
  assert.equal(qualityVerdict(row({ subject: 'user-assistant address', text: '用户称呼助手为姐姐' })), 'selfref-subject')
  assert.equal(qualityVerdict(row({ subject: 'approval', text: 'User changed the approval policy from ask to never' })), 'english-only')
  // 边界：含中文的英文混排不算 english-only；短英文口令不算
  assert.equal(qualityVerdict(row({ text: 'MCP 已安装：MCP 已安装完成。' })), 'ephemeral')
  assert.equal(isEnglishOnly('pnpm'), false)
  assert.equal(isEnglishOnly('用户 prefers A'), false)
  assert.equal(isEnglishOnly('User referred to the assistant as sister today'), true)
})

test('planImport：域过滤 / 内容键去重 / 一律改写为 quarantined 且清空跨机引用', () => {
  const mk = (id, domain, text, over = {}) => JSON.stringify({
    kind: 'observation', version: 1, ts: 1,
    data: { id, scopeId: 'user-global', subject: 's', predicate: 'p', claimDomain: domain, authority: 'user_explicit', text, evidenceIds: ['ev_x'], supersedes: ['obs_old'], state: 'active', observedAt: '2026-09-22T00:00:00.000Z', createdAt: 1, ...over },
  })
  const lines = [
    mk('obs_1', 'user_fact', 'a'),
    mk('obs_2', 'experience', 'b'),          // 域过滤
    mk('obs_3', 'user_fact', 'a'),           // 内容键重复（与 obs_1 同）
    mk('obs_4', 'work', 'c'),
    JSON.stringify({ kind: 'evidence', version: 1, ts: 1, data: { id: 'ev_1' } }), // 非 observation
    'not json {',
  ]
  const { keep, stats } = planImport(lines, new Set(), DEFAULT_DOMAINS)
  assert.equal(stats.total, 4)
  assert.equal(stats.domainFiltered, 1)
  assert.equal(stats.dupKey, 1)
  assert.equal(stats.notObservation, 2)
  assert.equal(keep.length, 2)
  for (const o of keep) {
    assert.equal(o.data.state, 'quarantined')
    assert.deepEqual(o.data.evidenceIds, [])
    assert.deepEqual(o.data.supersedes, [])
  }
  // 本地已有同内容键 → 全部跳过
  const localKey = ['user-global', 's', 'p', 'user_fact', 'a'].join('|')
  const again = planImport([mk('obs_1', 'user_fact', 'a')], new Set([localKey]), DEFAULT_DOMAINS)
  assert.equal(again.keep.length, 0)
  assert.equal(again.stats.dupKey, 1)
})

test('planImport：--include-experience 时域过滤关闭', () => {
  const line = JSON.stringify({ kind: 'observation', version: 1, ts: 1, data: { id: 'obs_e', scopeId: 'user-global', subject: 's', predicate: 'p', claimDomain: 'experience', text: 'x', evidenceIds: [], supersedes: [], state: 'active', observedAt: '2026-09-22T00:00:00.000Z', createdAt: 1 } })
  assert.equal(planImport([line], new Set(), DEFAULT_DOMAINS).keep.length, 0)
  assert.equal(planImport([line], new Set(), null).keep.length, 1)
})
