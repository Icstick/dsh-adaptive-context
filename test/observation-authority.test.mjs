// test/observation-authority.test.mjs — PLAN-S2 P3：observation 溯源权威列（v5）。
// 覆盖：upsertObservation 溯源聚合（确定性秩）、显式 authority 优先、v4→v5 迁移（旧行 NULL 回退）、
//       export/import JSONL 往返携带 authority、旧格式导入兼容。
// 运行：node test/observation-authority.test.mjs（单文件直跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openEvidenceLedger, deriveObservationAuthority } from '../src/store.mjs'
import { createAcpService } from '../src/service.mjs'
import { SCHEMA_VERSION } from '../src/constants.mjs'
import { exportJsonl, importJsonl } from '../src/export-import.mjs'

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), 'acp-obs-auth-'))
}

function freshLedger(t) {
  const dir = freshDir()
  const ledger = openEvidenceLedger({ dir })
  t.after(() => {
    try { ledger.close() } catch { /* closed */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
  })
  return ledger
}

const evInput = (authority, content, ref) => ({
  sourceClass: authority === 'user_correction' ? 'user_correction'
    : authority === 'external_information' ? 'external_tool'
    : authority === 'single_observation' || authority.startsWith('agent_') ? 'agent_authored'
    : 'user_input',
  authority,
  confidence: 0.9, durability: 0.5, sensitivity: 'private',
  claimDomain: authority === 'user_correction' ? 'user_preference' : 'user_fact',
  content,
  sourceRef: { sessionEventId: ref },
})

// ===================== deriveObservationAuthority（纯函数） =====================

test('聚合秩：user_correction > user_explicit > system_policy > external_information > single_observation > agent_inference > agent_self_evaluation', () => {
  assert.equal(deriveObservationAuthority(['single_observation', 'user_explicit']), 'user_explicit')
  assert.equal(deriveObservationAuthority(['user_explicit', 'user_correction']), 'user_correction')
  assert.equal(deriveObservationAuthority(['agent_inference', 'agent_self_evaluation']), 'agent_inference')
  assert.equal(deriveObservationAuthority(['external_information', 'single_observation']), 'external_information')
  assert.equal(deriveObservationAuthority(['system_policy', 'agent_inference']), 'system_policy')
})

test('聚合兜底：空 / 全非法 / 非数组 → single_observation', () => {
  assert.equal(deriveObservationAuthority([]), 'single_observation')
  assert.equal(deriveObservationAuthority(undefined), 'single_observation')
  assert.equal(deriveObservationAuthority(['unknown_authority']), 'single_observation')
})

// ===================== upsertObservation 聚合落库 =====================

test('upsert 无显式 authority：按 evidenceIds 聚合落库（纠正 > 声明）', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.append(evInput('user_explicit', '用户说要用 pnpm', 'a'))
  const b = ledger.append(evInput('user_correction', '更正：用 bun', 'b'))
  const r = ledger.upsertObservation({ subject: '包管理器', predicate: '偏好', claimDomain: 'user_preference', text: '用 bun', evidenceIds: [a.id, b.id] })
  assert.equal(r.inserted, true)
  assert.equal(r.row.authority, 'user_correction')
})

test('upsert 聚合：仅单次观察溯源 → single_observation（不得升级）', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.append(evInput('single_observation', '观察到一次用 TS', 'a'))
  const r = ledger.upsertObservation({ subject: '语言', predicate: '使用', claimDomain: 'user_fact', text: '观察到 TS', evidenceIds: [a.id] })
  assert.equal(r.row.authority, 'single_observation')
})

test('upsert 聚合：agent 自评溯源 → agent_self_evaluation（不进注入面，矩阵兜底）', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.append(evInput('agent_self_evaluation', '我评估会话顺畅', 'a'))
  const r = ledger.upsertObservation({ subject: '会话', predicate: '评估', claimDomain: 'experience', text: 'agent 自评', evidenceIds: [a.id] })
  assert.equal(r.row.authority, 'agent_self_evaluation')
})

test('upsert 显式 authority 优先于聚合；非法值拒绝', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.append(evInput('single_observation', '单次观察', 'a'))
  const r = ledger.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'work', text: 't', evidenceIds: [a.id], authority: 'user_explicit' })
  assert.equal(r.row.authority, 'user_explicit')
  assert.throws(() => ledger.upsertObservation({ subject: 's2', predicate: 'p', claimDomain: 'work', text: 't', authority: 'not-an-authority' }), TypeError)
})

test('upsert 无证据 ids：回退 single_observation（幂等路径不重写旧行权威）', (t) => {
  const ledger = freshLedger(t)
  const r = ledger.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'work', text: '无溯源' })
  assert.equal(r.row.authority, 'single_observation')
  const again = ledger.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'work', text: '无溯源' })
  assert.equal(again.inserted, false)
  assert.equal(again.row.authority, 'single_observation')
})

test('聚合忽略不存在的证据 id（只数存在的）', (t) => {
  const ledger = freshLedger(t)
  const a = ledger.append(evInput('user_explicit', '存在', 'a'))
  const r = ledger.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'work', text: 't', evidenceIds: [a.id, 'ev_ghost'] })
  assert.equal(r.row.authority, 'user_explicit')
})

// ===================== v4 → v5 迁移 =====================

test('迁移 v4→v5：旧库（observation 无 authority 列）打开自动加列，旧行 authority=null，meta 升到当前版本', () => {
  const dir = freshDir()
  // 手工构造 v4 库：observation 11 列 + 一条旧行 + schema_version=4
  const raw = new DatabaseSync(path.join(dir, 'acp-ledger.db'))
  raw.exec('CREATE TABLE acp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  raw.exec("INSERT INTO acp_meta (key, value) VALUES ('schema_version', '4')")
  raw.exec(`CREATE TABLE observation (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL,
    claim_domain TEXT NOT NULL, text TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]',
    supersedes TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'active',
    observed_at TEXT NOT NULL, created_at INTEGER NOT NULL
  )`)
  raw.exec("INSERT INTO observation (id, scope_id, subject, predicate, claim_domain, text, observed_at, created_at) VALUES ('obs_old', 'user-global', '旧', '观察', 'work', '旧行', '2026-09-01T00:00:00.000Z', 1)")
  raw.close()

  const ledger = openEvidenceLedger({ dir })
  try {
    const cols = ledger.db.prepare('PRAGMA table_info(observation)').all().map((c) => c.name)
    assert.ok(cols.includes('authority'), 'authority 列应已加')
    assert.equal(ledger.getMeta('schema_version'), String(SCHEMA_VERSION))
    const old = ledger.getObservationById('obs_old')
    assert.equal(old.authority, null, '旧行 authority 应为 null（读侧回退 single_observation）')
    // 新行正常写（含聚合）
    const b = ledger.append(evInput('user_correction', '更正', 'b'))
    const nr = ledger.upsertObservation({ subject: '新', predicate: '观察', claimDomain: 'user_preference', text: '新行', evidenceIds: [b.id] })
    assert.equal(nr.row.authority, 'user_correction')
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===================== export/import 往返 =====================

test('导出携带 authority、导入还原、往返字节一致', (t) => {
  const src = freshLedger(t)
  const a = src.append(evInput('user_explicit', '用户偏好', 'a'))
  src.upsertObservation({ subject: 's', predicate: 'p', claimDomain: 'user_preference', text: 't', evidenceIds: [a.id] })
  const text1 = exportJsonl({ ledger: src, candidateStore: src.candidateStore, auditStore: src.auditStore, ts: 7 })
  const obsLine = JSON.parse(text1.split('\n').find((l) => l.includes('"kind":"observation"')))
  assert.equal(obsLine.data.authority, 'user_explicit')

  const dst = freshLedger(t)
  const res = importJsonl(text1, { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(res.errors.length, 0)
  const text2 = exportJsonl({ ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore, ts: 7 })
  assert.equal(text2, text1)
})

test('旧格式导入（observation 行无 authority 字段）→ 行 authority=null，不报错', (t) => {
  const dst = freshLedger(t)
  const oldLine = JSON.stringify({ kind: 'observation', version: 1, ts: 1, data: {
    id: 'obs_legacy', scopeId: 'user-global', subject: '旧', predicate: '格式', claimDomain: 'work',
    text: '无 authority 字段', evidenceIds: [], supersedes: [], state: 'active',
    observedAt: '2026-09-01T00:00:00.000Z', createdAt: 1,
  } })
  const res = importJsonl(oldLine + '\n', { ledger: dst, candidateStore: dst.candidateStore, auditStore: dst.auditStore })
  assert.equal(res.errors.length, 0)
  assert.equal(dst.getObservationById('obs_legacy').authority, null)
})

// ===================== queryObservations（service 面，2026-09-07 maid P0-1） =====================

test('queryObservations：authorities IN 过滤 + 默认 active', (t) => {
  const ledger = freshLedger(t)
  const svc = createAcpService({ ledger })
  // 直接落 observation（upsertObservation 需 evidence 溯源；这里用内部 append 路径验证 service 透传）
  const mk = (id, authority, text) => ledger.upsertObservation({
    id, scopeId: 'user-global', subject: 's', predicate: 'p', claimDomain: 'user_fact',
    text, evidenceIds: [], supersedes: [], state: 'active', observedAt: Date.now(), createdAt: Date.now(), authority,
  })
  mk('obs_hi_1', 'user_explicit', '必须用 pnpm')
  mk('obs_hi_2', 'user_correction', '不要用 yarn')
  mk('obs_lo_1', 'single_observation', '普通观察')

  const hi = svc.queryObservations({ scopeId: 'user-global', authorities: ['user_explicit', 'user_correction'], limit: 10 })
  assert.equal(hi.total, 2)
  const texts = hi.items.map((o) => o.text).join('|')
  assert.ok(texts.includes('必须用 pnpm'))
  assert.ok(texts.includes('不要用 yarn'))
  assert.ok(!texts.includes('普通观察'), '低权威被 authorities 过滤')

  const all = svc.queryObservations({ scopeId: 'user-global', limit: 10 })
  assert.equal(all.total, 3, '无 authorities 参数 → 不过滤')
})

test('queryObservations：state 过滤生效（冲突翻转产生 superseded）', (t) => {
  const ledger = freshLedger(t)
  const svc = createAcpService({ ledger })
  const base = { scopeId: 'user-global', subject: '键', predicate: '冲突', claimDomain: 'user_fact', evidenceIds: [], supersedes: [], observedAt: Date.now(), createdAt: Date.now() }
  ledger.upsertObservation({ ...base, id: 'obs_v1', text: '第一版', authority: 'user_explicit' })
  ledger.upsertObservation({ ...base, id: 'obs_v2', text: '第二版（冲突翻转 v1）', authority: 'user_explicit' })
  const active = svc.queryObservations({ scopeId: 'user-global', state: 'active', limit: 10 })
  assert.equal(active.total, 1)
  assert.equal(active.items[0].id, 'obs_v2')
  const old = svc.queryObservations({ scopeId: 'user-global', state: 'superseded', limit: 10 })
  assert.equal(old.total, 1)
  assert.equal(old.items[0].id, 'obs_v1')
})

test('queryObservation：order desc 最新在前（T2 注入用）', (t) => {
  const ledger = freshLedger(t)
  const svc = createAcpService({ ledger })
  for (let i = 1; i <= 3; i++) {
    ledger.upsertObservation({
      id: 'obs_order_' + i, scopeId: 'user-global', subject: 's' + i, predicate: 'p', claimDomain: 'user_fact',
      text: '第' + i + '条', evidenceIds: [], supersedes: [], state: 'active',
      observedAt: new Date(Date.now() + i * 60000).toISOString(), authority: 'user_explicit',
    })
  }
  const asc = svc.queryObservations({ scopeId: 'user-global', authorities: ['user_explicit'], limit: 10 })
  assert.equal(asc.items[0].id, 'obs_order_1')
  const desc = svc.queryObservations({ scopeId: 'user-global', authorities: ['user_explicit'], limit: 10, order: 'desc' })
  assert.equal(desc.items[0].id, 'obs_order_3', 'desc 应最新在前')
  assert.equal(desc.total, 3)
})

test('queryObservation：authorities 白名单过滤混合轨（T2 权威闸门语义）', (t) => {
  const ledger = freshLedger(t)
  const svc = createAcpService({ ledger })
  const mk = (id, authority, text) => ledger.upsertObservation({
    id, scopeId: 'user-global', subject: id, predicate: 'p', claimDomain: 'user_fact',
    text, evidenceIds: [], supersedes: [], state: 'active', observedAt: Date.now(), createdAt: Date.now(), authority,
  })
  mk('obs_gate_hi1', 'user_explicit', '必须用 pnpm')
  mk('obs_gate_hi2', 'user_correction', '不要用 yarn')
  mk('obs_gate_lo1', 'single_observation', '用户 处于：工作')
  mk('obs_gate_lo2', 'agent_inference', '我猜用户喜欢 bun')
  const gate = svc.queryObservations({ scopeId: 'user-global', authorities: ['user_explicit', 'user_correction'], limit: 10 })
  assert.equal(gate.total, 2, '闸门只放行高权威')
  const all = svc.queryObservations({ scopeId: 'user-global', limit: 10 })
  assert.equal(all.total, 4, '无闸门全量')
})
