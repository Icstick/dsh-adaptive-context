// test/backlink-guard.test.mjs — 写入侧「无回链」护栏（2026-09-25，方案 3 的 B 部分）
// ---------------------------------------------------------------------------
// 现状（K 报告 §6 末段实测）：\`parseObservations\` 接受 \`evidenceIds: []\`，prompt 只「劝阻」
// 从未要求 ≥1，store 也不拒绝（空 → authority 兜底 single_observation）。
// 今天 \`local & active & empty = 0\`，但这条路**敞开着且无日志无测试拦截**——
// 模型只要输出一次空数组，就静默产生一条无回链、authority 被兜底成最弱的观测。
//
// 本文件锁定：这条路仍然**能走**（append-only、fail-open，不抛错），但**必须留痕**。
// 运行：node test/backlink-guard.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { importJsonl } from '../src/export-import.mjs'
import { parseObservations, buildConsolidationPrompt, createConsolidator } from '../src/consolidate.mjs'

let bl = {}
try { bl = await import('../src/backlink.mjs') } catch { /* 未实现 → 断言红 */ }

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-blguard-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => {
    try { ledger.close() } catch { /* closed */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
  })
  return ledger
}

const baseEv = (n, over = {}) => ({
  sourceClass: 'user_input', authority: 'user_explicit',
  confidence: 0.9, durability: 0.5, sensitivity: 'private',
  claimDomain: 'user_preference', content: '用户偏好 Bun ' + n,
  sourceRef: { sessionEventId: 'g' + n }, ...over,
})

// ===================== parseObservations：空回链要出声 =====================

test('parseObservations：evidenceIds 为空的条目 → warnings 点名（且不因此判 ok:false）', () => {
  const text = JSON.stringify({ observations: [
    { subject: '包管理器', predicate: '偏好', claimDomain: 'user_preference', text: '用 bun', evidenceIds: ['ev_1'] },
    { subject: '存储', predicate: '偏好', claimDomain: 'user_preference', text: '用 S3', evidenceIds: [] },
    { subject: '语言', predicate: '使用', claimDomain: 'user_fact', text: '用 TS' },
  ] })
  const r = parseObservations(text)
  assert.equal(r.ok, true, '空回链是「合法但可疑」，不是解析失败（否则水位卡死重试烧 LLM）')
  assert.equal(r.observations.length, 3)
  assert.ok(Array.isArray(r.warnings), 'parseObservations 必须回 warnings')
  assert.equal(r.warnings.length, 2, '两条无回链的条目各出一条告警')
  assert.ok(r.warnings.every((w) => /无\s*evidenceIds|无回链/.test(w)), '告警要说清是什么：' + JSON.stringify(r.warnings))
  assert.ok(r.warnings.some((w) => w.includes('用 S3')) && r.warnings.some((w) => w.includes('用 TS')),
    '告警要能定位到具体条目')
  // 全部合法且有回链 → 无告警（不噪声）
  assert.deepEqual(parseObservations(JSON.stringify({ observations: [
    { subject: 'a', predicate: 'b', claimDomain: 'work', text: 't', evidenceIds: ['ev_1'] },
  ] })).warnings, [])
})

// ===================== prompt：从「劝阻」改为「要求」 =====================

test('buildConsolidationPrompt：明确要求每条 observation 至少 1 条 evidenceIds', () => {
  const { system } = buildConsolidationPrompt([{ id: 'ev_1', claimDomain: 'work', content: 'x' }])
  assert.ok(/MUST (list|reference|include) at least one/i.test(system), '必须把「至少一条回链」写成硬要求')
  assert.ok(/evidenceIds/i.test(system))
})

// ===================== store：本机空回链要留痕；外机导入不算异常 =====================

test('upsertObservation：本机空回链写入仍在（append-only），但返回值标记 missing_backlink', (t) => {
  const ledger = freshLedger(t)
  const r = ledger.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'work', text: '无溯源' })
  assert.equal(r.inserted, true, '不拒绝写入——账本 append-only，护栏是留痕不是拦死')
  assert.ok(r.backlink && typeof r.backlink.tier === 'string', '写入结果必须带回链档位')
  assert.equal(r.backlink.tier, 'missing_backlink')
  assert.equal(r.backlink.alert, true, '本机缺回链 = 告警')
  // 幂等路径也要带
  const again = ledger.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'work', text: '无溯源' })
  assert.equal(again.inserted, false)
  assert.equal(again.backlink.tier, 'missing_backlink')
  // 有回链 → verifiable，不告警
  const ev = ledger.append(baseEv(1))
  const ok = ledger.upsertObservation({ subject: 's2', predicate: 'p', claimDomain: 'work', text: '有溯源', evidenceIds: [ev.id] })
  assert.equal(ok.backlink.tier, 'verifiable')
  assert.equal(ok.backlink.alert, false)
})

test('upsertObservation：外机导入行（显式 id + 清空回链）不被标成本机缺陷', (t) => {
  const ledger = freshLedger(t)
  const id = (bl.observationIdOf
    ? bl.observationIdOf({ scopeId: 'user-global', subject: '用户', predicate: '偏好', claimDomain: 'user_preference', text: '外机来的', evidenceIds: ['ev_A1', 'ev_A2'] })
    : 'obs_' + 'e'.repeat(24))
  importJsonl(JSON.stringify({ kind: 'observation', version: 1, ts: 1, data: {
    id, scopeId: 'user-global', subject: '用户', predicate: '偏好', claimDomain: 'user_preference',
    text: '外机来的', authority: 'user_explicit', evidenceIds: [], supersedes: [], state: 'active',
    observedAt: '2026-09-10T00:00:00.000Z', createdAt: 1786000000000,
  } }) + '\n', { ledger })
  const row = ledger.getObservationById(id)
  assert.equal(bl.classifyBacklink?.(row)?.tier, 'unverifiable_foreign')
  // 导入走的是 export-import 的原始 INSERT，不经 upsertObservation —— 再走一次 upsert 幂等路径，
  // 它也必须认出「这条不是本机缺回链」
  const again = ledger.upsertObservation({ id, subject: '用户', predicate: '偏好', claimDomain: 'user_preference', text: '外机来的', evidenceIds: [] })
  assert.equal(again.inserted, false)
  assert.equal(again.backlink.tier, 'unverifiable_foreign', '幂等命中已有行时，档位按**库里那行**判，不按入参判')
  assert.equal(again.backlink.alert, false)
})

// ===================== 端到端：LLM 输出空回链 → runOnce 必须留日志 =====================

test('端到端：LLM 输出 evidenceIds=[] → runOnce 落库 + logger.warn 留痕', async (t) => {
  const ledger = freshLedger(t)
  ledger.append(baseEv(1))
  const logs = []
  const c = createConsolidator({
    ledger, minEvidence: 1, minTurns: 100,
    llmCall: async () => JSON.stringify({ observations: [
      { subject: '包管理器', predicate: '偏好', claimDomain: 'user_preference', text: '用 bun', evidenceIds: [] },
    ] }),
    logger: { warn: (...a) => logs.push(a.join(' ')), debug: (...a) => logs.push(a.join(' ')), info: () => {} },
  })
  const r = await c.runOnce()
  assert.equal(r.observations, 1, '仍然落库（不因缺回链丢结论）')
  const hit = logs.filter((l) => l.includes('observation_without_backlink'))
  assert.equal(hit.length, 1, '必须有一条可 grep 的告警；实际日志: ' + JSON.stringify(logs))
  assert.ok(hit[0].includes('acp:degraded'), '沿用 [acp] acp:degraded 前缀，便于与既有降级日志一起 grep')
})
