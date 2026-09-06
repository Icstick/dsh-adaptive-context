// test/migrate-memento.test.mjs — PLAN-S2 P5：memento→ACP 迁移管道验收。
// 覆盖：内容分类（偏好启发）/ 超长切分 / dry-run 只读统计 / run 幂等重跑 /
//       对账（kind=memento 证据数）/ 批次审计 / writeGuard 拦截 / scope 保留。
// 运行：node test/migrate-memento.test.mjs（单文件直跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  classifyUserDomain, splitLongText, planMappings, dryRun, runMigration, backupMementoDb,
  sourceRefOf, MAX_PART_CHARS,
} from '../scripts/migrate-memento.mjs'

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), 'acp-mig-'))
}

/** 构造与真实库同形状的 memento memory.db（entries 列对齐真实 schema） */
function seedMementoDb(t, entries) {
  const dir = freshDir()
  const p = path.join(dir, 'memory.db')
  const db = new DatabaseSync(p)
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, track TEXT, scope TEXT, workspace_key TEXT, text TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, session_id TEXT, agent_key TEXT, last_recalled INTEGER, recall_count INTEGER, tags TEXT, version INTEGER)')
  const ins = db.prepare('INSERT INTO entries (id, track, scope, workspace_key, text, source, created_at, updated_at, session_id, agent_key, tags, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const now = Date.now()
  for (const e of entries) {
    ins.run(e.id, e.track, e.scope, e.ws ?? 'd:\\dsh_workspace', e.text, 'memory-tool', now - 1000, now, e.session ?? '', 'mio', e.tags ?? '[]', 1)
  }
  db.close()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, dbPath: p }
}

const SAMPLE = [
  { id: 'u1', track: 'user', scope: 'user-global', text: '凭据处理偏好：密码/token 不要写进 memory，只放本地文档（用户明确要求）' },
  { id: 'u2', track: 'user', scope: 'user-global', text: '用户 GitHub 账号是 github.com/Icstick' },
  { id: 'u3', track: 'user', scope: 'workspace', text: '插件 README 用中文为主，配小故事例子' },
  { id: 'a1', track: 'agent', scope: 'user-global', text: 'DSH 正式实例运行树是 D:/deepseek-harness-alpha5' },
  { id: 'a2', track: 'agent', scope: 'workspace', text: 'dsh 沙箱实测：node/python 可运行但捕获外部输出受限' },
  { id: 'a3', track: 'agent', scope: 'user-global', text: '长条目'.repeat(180) }, // 900 字符 → 2 段
]

// ===================== 纯函数 =====================

test('classifyUserDomain：偏好/要求/习惯关键词 → user_preference，一般事实 → user_fact', () => {
  assert.equal(classifyUserDomain('凭据处理偏好：不要写进 memory'), 'user_preference')
  assert.equal(classifyUserDomain('README 用中文为主（用户反馈）'), 'user_preference')
  assert.equal(classifyUserDomain('用户 GitHub 账号是 Icstick'), 'user_fact')
  assert.equal(classifyUserDomain('OpenAI Codex Plus 订阅存在'), 'user_fact')
})

test('splitLongText：≤500 原样；超长按段切分且段序/总数正确', () => {
  const short = splitLongText('abc')
  assert.deepEqual(short, [{ content: 'abc', part: 1, of: 1 }])
  const long = splitLongText('x'.repeat(1200))
  assert.equal(long.length, 3)
  assert.equal(long[0].part, 1); assert.equal(long[2].part, 3); assert.equal(long[2].of, 3)
  assert.ok(long.every((p) => p.content.length <= MAX_PART_CHARS))
  assert.equal(long.map((p) => p.content).join(''), 'x'.repeat(1200))
})

test('planMapping：user/agent 映射 + 切分 + sourceRef 幂等结构', () => {
  const um = planMappings([{ id: 'x1', track: 'user', scope: 'user-global', text: '用户喜欢中文（明确）' }])[0]
  assert.equal(um.sourceClass, 'user_input'); assert.equal(um.authority, 'user_explicit')
  assert.equal(um.claimDomain, 'user_preference')
  const am = planMappings([{ id: 'x2', track: 'agent', scope: 'workspace', text: '某环境事实' }])[0]
  assert.equal(am.sourceClass, 'agent_authored'); assert.equal(am.authority, 'single_observation')
  assert.equal(am.claimDomain, 'experience')
  const ref = sourceRefOf(um, 0)
  assert.equal(ref.kind, 'memento'); assert.equal(ref.id, 'x1')
  const multi = planMappings([{ id: 'x3', track: 'agent', scope: 'user-global', text: 'y'.repeat(900) }])[0]
  assert.equal(multi.parts.length, 2)
  const r1 = sourceRefOf(multi, 0); const r2 = sourceRefOf(multi, 1)
  assert.equal(r1.part, 1); assert.equal(r2.part, 2); assert.equal(r1.of, 2)
})

// ===================== dry-run =====================

test('dry-run：只读统计（分类/切分/guard 预检），不写任何库', (t) => {
  const { dbPath } = seedMementoDb(t, SAMPLE)
  const before = new DatabaseSync(dbPath, { readOnly: true })
  const nBefore = before.prepare('SELECT COUNT(*) c FROM entries').get().c
  before.close()
  const r = dryRun(dbPath)
  assert.equal(r.stats.entries, 6)
  assert.equal(r.stats.parts, 7) // 6 条 + a3 900 字符切 2 段
  assert.equal(r.stats.over500, 1)
  const after = new DatabaseSync(dbPath, { readOnly: true })
  const nAfter = after.prepare('SELECT COUNT(*) c FROM entries').get().c
  after.close()
  assert.equal(nAfter, nBefore, 'dry-run 不得写 memento.db')
  const userPref = r.list.filter((c) => c.track === 'user' && c.claimDomain === 'user_preference')
  assert.ok(userPref.length >= 2)
})

test('dry-run：secret 内容 guard 预检标 block（不落库）', (t) => {
  const { dbPath } = seedMementoDb(t, [
    { id: 's1', track: 'user', scope: 'user-global', text: '服务器的 api_key=abcdefghijklmnopqrst 放这里' },
  ])
  const r = dryRun(dbPath)
  assert.equal(r.stats.blocked, 1)
  assert.equal(r.list[0].guard, 'block')
})

// ===================== run =====================

test('run：全量迁移 + 对账一致 + 批次审计（op=import_memento）', (t) => {
  const { dbPath } = seedMementoDb(t, SAMPLE)
  const dir = freshDir()
  const ledgerDir = path.join(dir, 'acp')
  const report = runMigration({ mementoDbPath: dbPath, ledgerDir })
  assert.equal(report.totalParts, 7)
  assert.equal(report.inserted, 7)
  assert.equal(report.skipped, 0)
  assert.equal(report.failed.length, 0)
  assert.equal(report.reconciled, 7, '对账：ledger 内 kind=memento 证据数')
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  try {
    // 批次审计存在且幂等
    const audits = ledger.auditStore.queryAudit({ op: 'import_memento' })
    assert.equal(audits.items.length, 1)
    // user 候选 authority/domain 正确
    const rows = ledger.db.prepare("SELECT * FROM evidence WHERE source_ref LIKE ?").all('%"kind":"memento"%')
    const u1 = rows.find((r2) => r2.source_ref.includes('"id":"u1"'))
    assert.equal(u1.authority, 'user_explicit'); assert.equal(u1.claim_domain, 'user_preference')
    assert.equal(u1.scope_id, 'user-global')
    assert.equal(u1.session_id, '', '稳定内容轨不落会话属性')
    // workspace 层 scope 保留
    const a2 = rows.find((r2) => r2.source_ref.includes('"id":"a2"'))
    assert.equal(a2.scope_id, 'workspace')
    // 超长条目切分为 2 条独立证据（part/of 标注）
    const a3s = rows.filter((r2) => r2.source_ref.includes('"id":"a3"'))
    assert.equal(a3s.length, 2)
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run 幂等：重跑全部 skip，对账不变，审计不重复', (t) => {
  const { dbPath } = seedMementoDb(t, SAMPLE)
  const dir = freshDir()
  const ledgerDir = path.join(dir, 'acp')
  runMigration({ mementoDbPath: dbPath, ledgerDir })
  const second = runMigration({ mementoDbPath: dbPath, ledgerDir })
  assert.equal(second.inserted, 0)
  assert.equal(second.skipped, 7)
  assert.equal(second.reconciled, 7)
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  try {
    assert.equal(ledger.auditStore.queryAudit({ op: 'import_memento' }).items.length, 1)
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run：secret 内容被 writeGuard block（不进 ledger），批次审计仍落', (t) => {
  const { dbPath } = seedMementoDb(t, [
    { id: 's1', track: 'user', scope: 'user-global', text: '内部 api_key=abcdefghijklmnopqrst 记录' },
    { id: 'ok1', track: 'user', scope: 'user-global', text: '正常内容' },
  ])
  const dir = freshDir()
  const ledgerDir = path.join(dir, 'acp')
  const report = runMigration({ mementoDbPath: dbPath, ledgerDir })
  assert.equal(report.blocked.length, 1)
  assert.equal(report.inserted, 1)
  assert.equal(report.reconciled, 1)
  rmSync(dir, { recursive: true, force: true })
})

// ===================== backup =====================

test('backup：checkpoint 后复制 db（+wal/shm 如有），目录含文件', (t) => {
  const { dir, dbPath } = seedMementoDb(t, SAMPLE)
  const bk = path.join(dir, 'backup')
  const r = backupMementoDb(dbPath, bk)
  assert.ok(existsSync(path.join(bk, 'memory.db')))
  assert.ok(r.files.includes('memory.db'))
  assert.equal(r.backupDir, bk)
})


test('scopeMap=flatten：workspace 层升 user-global（用户拍板 A1），幂等重跑仍 skip', (t) => {
  const { dbPath } = seedMementoDb(t, SAMPLE)
  const dir = freshDir()
  const ledgerDir = path.join(dir, 'acp')
  const report = runMigration({ mementoDbPath: dbPath, ledgerDir, scopeMap: 'flatten' })
  assert.equal(report.inserted, 7)
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  try {
    const rows = ledger.db.prepare("SELECT * FROM evidence WHERE source_ref LIKE ?").all('%"kind":"memento"%')
    assert.equal(rows.length, 7)
    for (const r of rows) assert.equal(r.scope_id, 'user-global', 'flatten 后全部 user-global')
    const a2 = rows.find((r2) => r2.source_ref.includes('"id":"a2"'))
    assert.equal(a2.scope_id, 'user-global')
    // 幂等：同一 ledger 上重跑全 skip
    const second = runMigration({ mementoDbPath: dbPath, ledgerDir, scopeMap: 'flatten' })
    assert.equal(second.inserted, 0)
    assert.equal(second.skipped, 7)
    assert.equal(ledger.auditStore.queryAudit({ op: 'import_memento' }).items.length, 1, '批次审计仍只记一次')
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
