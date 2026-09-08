// test/clear-memento.test.mjs — PLAN-S2 §4.3（D1 迁后清空）：memento entries 清空脚本验收。
// 覆盖：dry-run 只读统计 / run（备份→清空→ACP audit 落账）/ 幂等护栏（重复 run 拒绝，--allow-repeat 可重清）/
//       只动 entries（proposals 等其他表不受影响）。
// 运行：node test/clear-memento.test.mjs（单文件直跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  dryRun, runClear, clearEntries, summarizeEntries, CLEAR_OP, CLEAR_REASON,
} from '../scripts/clear-memento-after-migration.mjs'

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), 'acp-clr-'))
}

/** 构造与真实库同形状的 memento memory.db（entries 列对齐真实 schema v4；另造 proposals 表验证不受影响） */
function seedMementoDb(t, entries) {
  const dir = freshDir()
  const p = path.join(dir, 'memory.db')
  const db = new DatabaseSync(p)
  db.exec(
    'CREATE TABLE entries (id TEXT PRIMARY KEY, track TEXT, scope TEXT, workspace_key TEXT, text TEXT, source TEXT, created_at INTEGER, updated_at INTEGER, session_id TEXT, agent_key TEXT, last_recalled INTEGER, recall_count INTEGER, tags TEXT, version INTEGER)',
  )
  db.exec('CREATE TABLE proposals (id TEXT PRIMARY KEY, kind TEXT, text TEXT, created_at INTEGER, status TEXT)')
  const ins = db.prepare('INSERT INTO entries (id, track, scope, workspace_key, text, source, created_at, updated_at, session_id, agent_key, tags, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const now = Date.now()
  for (const e of entries) {
    ins.run(e.id, e.track, e.scope, e.ws ?? 'd:\\dsh_workspace', e.text, 'memory-tool', now - 1000, now, e.session ?? '', 'mio', e.tags ?? '[]', 1)
  }
  db.prepare("INSERT INTO proposals (id, kind, text, created_at, status) VALUES ('p1', 'compaction-summary', 'history digest', ?, 'pending')").run(now)
  db.close()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, dbPath: p }
}

const SAMPLE = [
  { id: 'u1', track: 'user', scope: 'user-global', text: '凭据处理偏好：密码/token 不要写进 memory（用户明确要求）' },
  { id: 'u2', track: 'user', scope: 'user-global', text: '用户 GitHub 账号是 github.com/Icstick' },
  { id: 'a1', track: 'agent', scope: 'workspace', text: 'DSH 正式实例运行树是 D:/deepseek-harness-alpha5' },
  { id: 'a2', track: 'agent', scope: 'user-global', text: 'dsh 沙箱实测：node 可运行但捕获外部输出受限' },
]

test('dry-run：只读统计（分布/字符/清单），不写任何库', (t) => {
  const { dbPath } = seedMementoDb(t, SAMPLE)
  const before = new DatabaseSync(dbPath, { readOnly: true })
  const nBefore = before.prepare('SELECT COUNT(*) c FROM entries').get().c
  before.close()
  const r = dryRun(dbPath)
  assert.equal(nBefore, 4)
  assert.equal(r.entries, 4)
  assert.equal(r.by['user/user-global'], 2)
  assert.equal(r.by['agent/user-global'], 1)
  assert.equal(r.by['agent/workspace'], 1)
  assert.equal(r.list.length, 4)
  // dry-run 后 entries 仍在
  const after = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(after.prepare('SELECT COUNT(*) c FROM entries').get().c, 4)
  after.close()
})

test('summarizeEntries：空列表与常规统计', () => {
  assert.deepEqual(summarizeEntries([]), { entries: 0, chars: 0, by: {} })
  const s = summarizeEntries([{ track: 'user', scope: 'user-global', text: 'abc' }])
  assert.equal(s.entries, 1); assert.equal(s.chars, 3)
})

test('runClear：备份 → 清空 → ACP audit 落账（payload 完整）', (t) => {
  const { dbPath, dir } = seedMementoDb(t, SAMPLE)
  const ledgerDir = freshDir(); t.after(() => rmSync(ledgerDir, { recursive: true, force: true }))
  const backupDir = path.join(dir, 'backup')
  const r = runClear({ mementoDbPath: dbPath, ledgerDir, backupDir })
  assert.equal(r.deleted, 4)
  assert.equal(r.remaining, 0)
  assert.equal(r.audit, CLEAR_OP)
  assert.ok(existsSync(path.join(backupDir, 'memory.db')), '备份 db 存在')
  // entries 空、proposals 不受影响
  const db = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM entries').get().c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM proposals').get().c, 1)
  db.close()
  // audit 行落账
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  const q = ledger.auditStore.queryAudit({ op: CLEAR_OP })
  assert.equal(q.total, 1)
  const row = q.items[0]
  assert.equal(row.op, CLEAR_OP)
  assert.equal(row.reason, CLEAR_REASON)
  assert.equal(row.payload.before.entries, 4)
  assert.equal(row.payload.deleted, 4)
  assert.equal(row.payload.remaining, 0)
  assert.ok(row.payload.backupDir.includes('backup'))
  ledger.close()
})

test('幂等护栏：重复 runClear 默认拒绝（防误删观察期新数据）；--allow-repeat 可重清', (t) => {
  const { dbPath, dir } = seedMementoDb(t, SAMPLE)
  const ledgerDir = freshDir(); t.after(() => rmSync(ledgerDir, { recursive: true, force: true }))
  const backupDir = path.join(dir, 'backup')
  const r1 = runClear({ mementoDbPath: dbPath, ledgerDir, backupDir })
  assert.equal(r1.deleted, 4)
  assert.throws(() => runClear({ mementoDbPath: dbPath, ledgerDir, backupDir }), /已清空过/)
  // 观察期窗口模拟：清空后新写入 1 条 → 默认拒绝保住它
  const db = new DatabaseSync(dbPath)
  db.prepare("INSERT INTO entries (id, track, scope, workspace_key, text, source, created_at, updated_at, version) VALUES ('n1','user','user-global','d:\\dsh_workspace','观察期新写入','memory-tool',?,?,1)").run(Date.now(), Date.now())
  db.close()
  assert.throws(() => runClear({ mementoDbPath: dbPath, ledgerDir, backupDir }), /已清空过/)
  const db2 = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM entries').get().c, 1, '默认拒绝后观察期新数据仍在')
  db2.close()
  const r2 = runClear({ mementoDbPath: dbPath, ledgerDir, backupDir, allowRepeat: true })
  assert.equal(r2.deleted, 1)
})

test('clearEntries：只删 entries 表', (t) => {
  const { dbPath } = seedMementoDb(t, SAMPLE)
  const n = clearEntries(dbPath)
  assert.equal(n, 4)
})
