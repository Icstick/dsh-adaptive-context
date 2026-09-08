// scripts/clear-memento-after-migration.mjs — PLAN-S2 §4.3（D1 迁后清空）：观察期开始前清空 memento entries。
//
// 语义：memento→ACP 迁移完成（migrate-memento.mjs run 32/32，2026-09-06）后，memento 插件仍挂
// bundle（观察期 2 周）。清空 entries → 冻结快照为空块（注入零成本），消除同事实双轨重复；
// 数据保全 = ACP ledger（source_ref.kind=memento，幂等可增量）+ 本脚本备份双保险；
// 回滚 = 从备份目录恢复 memory.db（+ wal/shm）。
//
// 只清 entries（user/agent 两层）；proposals/audit 等历史表不动（PLAN-S2 §4.1：proposals 不迁正文，
// db 备份即含）。审计：ACP audit 落 op=memento_cleared_after_migration。
// 幂等护栏：成功清空过（audit 有记录）→ 默认拒绝重复执行，防误删观察期新写入；确需重清传 --allow-repeat。
//
// 用法：
//   node scripts/clear-memento-after-migration.mjs dry-run [--memento-db P] [--json]
//   node scripts/clear-memento-after-migration.mjs run    [--memento-db P] [--ledger-dir L] [--backup-dir D] [--allow-repeat] [--json]
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openEvidenceLedger } from '../src/store.mjs'
import { readMementoEntries, backupMementoDb } from './migrate-memento.mjs'

export const CLEAR_OP = 'memento_cleared_after_migration'
export const CLEAR_REASON = 'memento clear after migration (S2 step 5)'

/** 摘要：按 track/scope 统计条目数与字符数 */
export function summarizeEntries(entries) {
  const by = {}
  let chars = 0
  for (const e of entries) {
    const key = e.track + '/' + e.scope
    by[key] = (by[key] ?? 0) + 1
    chars += String(e.text ?? '').length
  }
  return { entries: entries.length, chars, by }
}

/** dry-run：只读统计 + 逐条预览（不写任何库） */
export function dryRun(mementoDbPath) {
  const entries = readMementoEntries(mementoDbPath)
  return {
    ...summarizeEntries(entries),
    list: entries.map((e) => ({
      id: e.id, track: e.track, scope: e.scope,
      chars: String(e.text ?? '').length, head: String(e.text ?? '').slice(0, 60),
    })),
    generatedAt: new Date().toISOString(),
  }
}

/** 是否已成功清空（幂等护栏：audit 有 CLEAR_OP 成功记录） */
export function hasClearedAudit(ledger) {
  const r = ledger.db.prepare('SELECT COUNT(*) c FROM audit WHERE op = ? AND reason = ?').get(CLEAR_OP, CLEAR_REASON)
  return Number(r.c) > 0
}

/** 执行清空（只动 entries 表）→ 返回删除行数 */
export function clearEntries(mementoDbPath) {
  const db = new DatabaseSync(mementoDbPath)
  try {
    const r = db.prepare('DELETE FROM entries').run()
    return Number(r.changes)
  } finally {
    db.close()
  }
}

/**
 * run：备份（快照留档）→ 清空 entries → ACP audit 落账。
 * @throws 已清空过且未传 allowRepeat（防误删观察期新数据）
 */
export function runClear({ mementoDbPath, ledgerDir, backupDir, allowRepeat = false }) {
  const before = readMementoEntries(mementoDbPath)
  const summary = summarizeEntries(before)
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  try {
    if (hasClearedAudit(ledger) && !allowRepeat) {
      throw new Error('entries 已清空过（audit 有 ' + CLEAR_OP + ' 记录）——观察期新数据请走增量迁移，或显式传 --allow-repeat')
    }
    const bak = backupMementoDb(mementoDbPath, backupDir)
    const deleted = clearEntries(mementoDbPath)
    const remaining = readMementoEntries(mementoDbPath).length
    ledger.auditStore.appendAudit({
      op: CLEAR_OP,
      scopeId: 'user-global',
      actor: 'system',
      reason: CLEAR_REASON,
      payload: {
        at: new Date().toISOString(),
        before: summary,
        deleted,
        remaining,
        backupDir: bak.backupDir,
        files: bak.files,
      },
    })
    return { deleted, remaining, backup: bak, audit: CLEAR_OP }
  } finally {
    ledger.close()
  }
}

// ---- CLI ----
const USAGE = 'usage: node scripts/clear-memento-after-migration.mjs <dry-run|run> [--memento-db P] [--ledger-dir L] [--backup-dir D] [--allow-repeat] [--json]'
function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const argv = process.argv.slice(2)
  const mode = argv.find((a) => ['dry-run', 'run'].includes(a))
  if (!mode) { console.error(USAGE); process.exit(1) }
  const DSH_HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
  const mementoDb = argValue(argv, '--memento-db') ?? path.join(DSH_HOME, 'dsh-memento', 'memory.db')
  const ledgerDir = argValue(argv, '--ledger-dir') ?? path.join(DSH_HOME, 'acp')
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const backupDir = argValue(argv, '--backup-dir') ?? path.join(DSH_HOME, 'archive', 'memento-cleared-' + date)
  const asJson = argv.includes('--json')
  const allowRepeat = argv.includes('--allow-repeat')
  try {
    if (mode === 'dry-run') {
      const r = dryRun(mementoDb)
      if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
      console.log('== memento entries 清空 dry-run（PLAN-S2 §4.3 D1 迁后清空）==')
      console.log('memento.db:', mementoDb)
      console.log('entries:', r.entries, '| chars:', r.chars, '| 分布:', JSON.stringify(r.by))
      console.log('--- 条目清单 ---')
      for (const c of r.list) console.log([c.id.slice(0, 8), c.track + '/' + c.scope, c.chars + '字'].join(' | '), '|', c.head)
    } else {
      const r = runClear({ mementoDbPath: mementoDb, ledgerDir, backupDir, allowRepeat })
      if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
      console.log('== clear run ==')
      console.log('删除:', r.deleted, '| 剩余:', r.remaining, '| 备份:', r.backup.backupDir, '(' + r.backup.files.join(', ') + ')')
      console.log('审计:', r.audit + ' 落账 ledger:', ledgerDir)
    }
  } catch (err) {
    console.error(String((err && err.message) || err))
    process.exit(1)
  }
}
