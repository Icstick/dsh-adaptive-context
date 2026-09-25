// test/backlink.test.mjs — 读侧「回链可核验性」分层（2026-09-25，方案 3）
// ---------------------------------------------------------------------------
// 要修的是什么：W 机上 918 条 active observation 的 evidence_ids='[]'，一直被读侧
// 当成「本机数据缺陷」（本机无法核验 = 这条结论没有支撑）。实测那 918 条 100% 是
// 跨机导入行，回链是 scripts/ledger-import.mjs:84 按设计清空的（evidence 不跨机，
// 留着必然悬空）。真正的本机异常是另一件事：本机写出的行却没有回链。
//
// 本文件锁定三条：
//   1. 两类必须**分开**（unverifiable_foreign ≠ missing_backlink）；
//   2. 外机档**不是**告警，本机档才是；
//   3. 分层只做标注，**不改任何打分**（confidence / 权重一律不动）。
//
// 运行：node test/backlink.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { importJsonl } from '../src/export-import.mjs'
import { observationToCandidate } from '../src/candidates.mjs'

// 用 catch 包住动态 import：模块未实现时表现为**断言失败**（红得可读），不是加载错误。
let bl = {}
let loadError = null
try { bl = await import('../src/backlink.mjs') } catch (err) { loadError = err }
const fn = (name) => {
  assert.equal(typeof bl[name], 'function', 'src/backlink.mjs 必须导出 ' + name
    + (loadError ? '（模块加载失败：' + loadError.message + '）' : ''))
  return bl[name]
}

function freshLedger(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-backlink-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => {
    try { ledger.close() } catch { /* closed */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
  })
  return ledger
}

const evInput = (content, ref) => ({
  sourceClass: 'user_input', authority: 'user_explicit',
  confidence: 0.9, durability: 0.5, sensitivity: 'private',
  claimDomain: 'user_preference', content, sourceRef: { sessionEventId: ref },
})

/** 按「外机导入」的真实签名造一条行：id 由源机按**原证据集**派生，回链被清空。
 *  scripts/ledger-import.mjs:82-85 做的就是这件事（保留源 id + evidenceIds: []），
 *  src/export-import.mjs:324 用显式 id 原样 INSERT。 */
function importedRow(ledger, { text, subject = '用户', predicate = '偏好', claimDomain = 'user_preference', sourceEvidenceIds = ['ev_from_A_1', 'ev_from_A_2'] }) {
  const id = bl.observationIdOf
    ? bl.observationIdOf({ scopeId: 'user-global', subject, predicate, claimDomain, text, evidenceIds: sourceEvidenceIds })
    : 'obs_' + 'f'.repeat(24)
  const line = JSON.stringify({ kind: 'observation', version: 1, ts: 1, data: {
    id, scopeId: 'user-global', subject, predicate, claimDomain, text,
    authority: 'user_explicit', evidenceIds: [], supersedes: [], state: 'active',
    observedAt: '2026-09-10T00:00:00.000Z', createdAt: 1786000000000,
  } })
  importJsonl(line + '\n', { ledger })
  return ledger.getObservationById(id)
}

// ===================== 导出面 =====================

test('BACKLINK_TIERS：三档语义齐备（可核验 / 不可核验（外机） / 本机缺回链）', () => {
  assert.ok(Array.isArray(bl.BACKLINK_TIERS), 'BACKLINK_TIERS 必须是数组')
  for (const t of ['verifiable', 'unverifiable_foreign', 'missing_backlink']) {
    assert.ok(bl.BACKLINK_TIERS.includes(t), 'BACKLINK_TIERS 缺 ' + t)
  }
  fn('observationIdOf'); fn('classifyBacklink'); fn('summarizeBacklinks')
})

// ===================== observationIdOf 与写入路径同源 =====================

test('observationIdOf 与 store 写入路径同源：真写入 → 读回 → 恒等', (t) => {
  const ledger = freshLedger(t)
  const ev = ledger.append(evInput('用户说用 S3 存储', 'a'))
  const { id } = ledger.upsertObservation({
    subject: '存储', predicate: '偏好', claimDomain: 'user_preference', text: '偏好使用 S3 存储', evidenceIds: [ev.id],
  })
  const row = ledger.getObservationById(id)
  assert.equal(fn('observationIdOf')(row), id, '读侧派生必须与写入路径算出同一个 id')
  assert.equal(bl.classifyBacklink(row).tier, 'verifiable')
})

// ===================== 本机档：真异常 =====================

test('本机产出却无回链 → missing_backlink（真异常，要告警）', (t) => {
  const ledger = freshLedger(t)
  // 走**本机写入路径**、evidenceIds 为空：id 由空证据集派生 → id 自洽 = 本机行
  const { row } = ledger.upsertObservation({
    subject: '存储', predicate: '偏好', claimDomain: 'user_preference', text: '没有回链的本地行',
  })
  const v = bl.classifyBacklink(row)
  assert.equal(v.tier, 'missing_backlink')
  assert.equal(v.foreign, false)
  assert.equal(bl.observationIdOf(row), row.id, '本机空回链行的 id 必然自洽 —— 这正是判据')
  const sum = bl.summarizeBacklinks([row])
  assert.deepEqual(sum.alerts.map((a) => a.id), [row.id], '本机缺回链必须进告警清单')
})

// ===================== 外机档：不是缺陷 =====================

test('外机导入（源 id 保留 + 回链按设计清空）→ unverifiable_foreign，不是本机缺陷', (t) => {
  const ledger = freshLedger(t)
  const row = importedRow(ledger, { text: '用户指定当前 session 处理范围' })
  assert.ok(row, '导入行应已落库')
  assert.deepEqual(row.evidenceIds, [], '导入侧确实清空了回链（前置事实）')
  const v = fn('classifyBacklink')(row)
  assert.equal(v.tier, 'unverifiable_foreign')
  assert.notEqual(v.tier, 'missing_backlink', '外机行不得被误判成本机数据缺陷')
  assert.equal(v.foreign, true)
  assert.equal(bl.observationIdOf(row) === row.id, false, 'id 由源机的原证据集派生 → 与本机的空集不自洽')
  const sum = bl.summarizeBacklinks([row])
  assert.deepEqual(sum.alerts, [], '不可核验（外机）不是缺陷，不进告警清单')
  assert.equal(sum.byTier.unverifiable_foreign, 1)
})

// ===================== 有回链但本机解析不到 =====================

test('回链非空但本机一条都解析不到 → unverifiable_foreign（带解析器时才主张已核验）', () => {
  const classify = fn('classifyBacklink')
  const row = { id: 'obs_' + 'a'.repeat(24), evidenceIds: ['ev_from_A_1'], subject: 's', predicate: 'p', claimDomain: 'work', text: 't', scopeId: 'user-global' }
  const miss = classify(row, { resolvableEvidence: new Set(['ev_local']) })
  assert.equal(miss.tier, 'unverifiable_foreign')
  assert.equal(miss.checked, true)
  assert.equal(miss.evidenceIds.unresolvable, 1)

  const hit = classify({ ...row, evidenceIds: ['ev_local'] }, { resolvableEvidence: new Set(['ev_local']) })
  assert.equal(hit.tier, 'verifiable')
  assert.equal(hit.checked, true)
  assert.equal(hit.evidenceIds.resolvable, 1)

  // 没给解析器 → 不主张「已核验」，但档位仍是 verifiable（有回链），由 checked=false 区分
  const unchecked = classify(row)
  assert.equal(unchecked.tier, 'verifiable')
  assert.equal(unchecked.checked, false)
})

// ===================== 不误报 =====================

test('无溯源信息的行（id 非派生形状 / 缺 id）→ unknown，既不告警也不标外机', () => {
  const classify = fn('classifyBacklink')
  for (const row of [{ id: 'f', evidenceIds: [], subject: 's', predicate: 'p', claimDomain: 'work', text: 't' },
    { evidenceIds: [], subject: 's', predicate: 'p', claimDomain: 'work', text: 't' },
    {}]) {
    const v = classify(row)
    assert.equal(v.tier, 'unknown', '不能凭「缺信息」判成任何一类：' + JSON.stringify(row))
  }
  const sum = bl.summarizeBacklinks([{ id: 'f', evidenceIds: [] }])
  assert.deepEqual(sum.alerts, [])
})

// ===================== 只标注，不改打分 =====================

test('读侧分层**不动打分**：候选 confidence 与画像权重不因档位改变', (t) => {
  const ledger = freshLedger(t)
  const local = ledger.upsertObservation({ subject: '存储', predicate: '偏好', claimDomain: 'user_preference', text: '没有回链的本地行' }).row
  const foreign = importedRow(ledger, { text: '外机导入的无回链行' })
  const cLocal = observationToCandidate(local)
  const cForeign = observationToCandidate(foreign)
  assert.equal(cLocal.confidence, 0.6, 'confidence 是 observationToCandidate 的固定值，不随回链档变化')
  assert.equal(cForeign.confidence, 0.6, '外机档**不是**「confidence 恒 0」——见 M 报告对 K 前提的实测纠正')
  assert.equal(cLocal.backlinkTier, 'missing_backlink', '候选上要能看出档位（只标注）')
  assert.equal(cForeign.backlinkTier, 'unverifiable_foreign')
})
