// scripts/ledger-quarantine-apply.mjs — 存量隔离执行器（2026-09-22）
// ---------------------------------------------------------------------------
// 把 ledger-quarantine-candidates.mjs 选出的候选**逐条隔离**（state → quarantined）。
//
// 纪律：
//   1. **不删**。走 src/lifecycle.mjs 的 quarantine()（state 迁移 + reviewStatus 留痕），
//      rollback() 可逐条放行。ADR-0001 append-only。
//   2. **默认 dry-run**：不给 --apply 只打印将要发生什么，一行都不改。
//   3. --apply 前**自动备份**（db + -wal + -shm 三件一起拷，WAL 语义下可恢复）。
//   4. 每批写一条 audit（op='quarantine_noise'，actor='user'），带层名与 id 清单摘要。
//   5. 分层判定**复用** candidates 脚本的 classify()，不复制一份——复制会漂移。
//
// 注意：dsh 正在运行时，本脚本与会话内进程共用同一个 WAL 库（busy_timeout=5000 串行化）。
//       逐条隔离是短事务，能跑；但更稳妥的是停掉 dsh 再执行（备份已保证可回滚）。
//
// 用法：
//   node scripts/ledger-quarantine-apply.mjs --dir <ledgerDir> --tier C            # 预演
//   node scripts/ledger-quarantine-apply.mjs --dir <ledgerDir> --tier C --apply    # 执行
//   --tier A|B|C|D 预设；或 --tiers T1a,T1b,... 自选；--limit N 只做前 N 条试跑。

import path from 'node:path'
import { existsSync, copyFileSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'
import { openEvidenceLedger } from '../src/store.mjs'
import { quarantine, rollback } from '../src/lifecycle.mjs'
import { classify, TIER_LABELS } from './ledger-quarantine-candidates.mjs'

/** 预设档（与 candidates 脚本的 simulate 保持一致） */
export const TIER_PRESETS = Object.freeze({
  A: ['T1a', 'T1b', 'T1c'],
  B: ['T1a', 'T1b', 'T1c', 'T2'],
  C: ['T1a', 'T1b', 'T1c', 'T2', 'T3'],
  D: ['T1a', 'T1b', 'T1c', 'T2', 'T3', 'T4', 'T5'],
})

/** 本批隔离在 reviewStatus 上留下的标记（回滚就认它——不依赖另存 id 清单） */
export const REVERT_MARKER = 'quarantine_noise:2026-09-22'

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  const preset = String(a.tier || '').toUpperCase()
  const tiers = a.tiers
    ? String(a.tiers).split(',').map((s) => s.trim()).filter(Boolean)
    : (TIER_PRESETS[preset] ?? [])
  return {
    dir: a.dir || path.join(resolveDshHome(), 'acp'),
    tiers,
    preset: preset || '(自选)',
    apply: a.apply === '1' || a.apply === 'true',
    backup: a.backup !== '0' && a.backup !== 'false',
    limit: Number(a.limit || 0) || 0,
    revert: a.revert === '1' || a.revert === 'true',
    marker: a.marker || REVERT_MARKER,
  }
}

/** 备份 db + wal + shm（三件一起拷，WAL 语义下可恢复） */
export function backupLedger(dir, stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)) {
  const copies = []
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(dir, DEFAULT_DB_NAME + suffix)
    if (!existsSync(src)) continue
    const dst = path.join(dir, DEFAULT_DB_NAME + '.bak-' + stamp + '-quarantine' + suffix)
    copyFileSync(src, dst)
    copies.push(path.basename(dst))
  }
  return copies
}

/**
 * 逐条隔离。dry-run 时只挑 id 不改状态。
 * @returns {{ids: string[], applied: number, errors: object[]}}
 */
export function selectAndQuarantine(db, ledger, opts) {
  const { tiers, apply, limit } = opts
  const rep = classify(db)
  const ids = tiers.flatMap((t) => (rep.tiers[t] ?? []).map((r) => r.id))
  const picked = limit > 0 ? ids.slice(0, limit) : ids

  if (!apply) return { ids: picked, applied: 0, errors: [] }

  const errors = []
  let applied = 0
  for (const id of picked) {
    try {
      quarantine(id, { ledger, reason: 'quarantine_noise:2026-09-22 tier=' + tiers.join('+') })
      applied += 1
    } catch (err) {
      errors.push({ id, error: String((err && err.message) || err) })
    }
  }
  // 审计：一批一条，带层名与计数（对齐 2026-08-30 A 机那次 op=quarantine_noise）
  try {
    ledger.auditStore.appendAudit({
      op: 'quarantine_noise',
      scopeId: 'user-global',
      actor: 'user',
      reason: '存量噪声隔离 tier=' + tiers.join('+') + ' applied=' + applied,
      payload: { tiers, applied, errors: errors.length, sample: picked.slice(0, 20) },
    })
  } catch { /* 审计失败不阻断（已隔离的行可 rollback） */ }
  return { ids: picked, applied, errors }
}

/**
 * 按 reviewStatus 标记回滚：把本批隔离的行放回 active（lifecycle.rollback，逐条可逆）。
 * 选择器用 marker 而不是另存 id 清单——标记就写在被改的行上，自描述、不依赖侧车文件。
 * @returns {{ids: string[], reverted: number, errors: object[]}}
 */
export function revertByMarker(db, ledger, { marker = REVERT_MARKER, apply } = {}) {
  const ids = db.prepare("SELECT id FROM evidence WHERE state='quarantined' AND metadata LIKE ?")
    .all('%' + marker + '%').map((r) => r.id)
  if (!apply) return { ids, reverted: 0, errors: [] }
  const errors = []
  let reverted = 0
  for (const id of ids) {
    try {
      rollback(id, { ledger })
      reverted += 1
    } catch (err) {
      errors.push({ id, error: String((err && err.message) || err) })
    }
  }
  try {
    ledger.auditStore.appendAudit({
      op: 'rollback',
      scopeId: 'user-global',
      actor: 'user',
      reason: '存量隔离回滚 marker=' + marker + ' reverted=' + reverted,
      payload: { marker, reverted, errors: errors.length },
    })
  } catch { /* 审计失败不阻断（回滚本身已生效） */ }
  return { ids, reverted, errors }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-quarantine-apply.mjs'))
})()

// main 抽成函数：里面有 return（revert 分支提前退出），顶层作用域不允许 return
function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.revert && opts.tiers.length === 0) {
    console.error('[quarantine] 需要 --tier A|B|C|D 或 --tiers T1a,T1b,...；或用 --revert 回滚本批')
    process.exit(2)
  }
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) {
    console.error('[quarantine] 账本不存在: ' + file)
    process.exit(2)
  }
  console.log('[quarantine] 库: ' + opts.dir)
  console.log(opts.revert
    ? '[quarantine] 回滚标记: ' + opts.marker + '  模式: ' + (opts.apply ? 'APPLY' : 'DRY-RUN')
    : '[quarantine] 层: ' + opts.tiers.join(', ') + '（预设 ' + opts.preset + '）  模式: ' + (opts.apply ? 'APPLY' : 'DRY-RUN'))

  if (opts.apply && opts.backup) {
    const made = backupLedger(opts.dir)
    console.log('[quarantine] 已备份: ' + made.join(', '))
  }

  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    if (opts.revert) {
      const rv = revertByMarker(ledger.db, ledger, { marker: opts.marker, apply: opts.apply })
      console.log('[quarantine] 命中 ' + rv.ids.length + ' 条，已回滚 ' + rv.reverted
        + (rv.errors.length ? '，失败 ' + rv.errors.length : ''))
      if (!opts.apply) console.log('[quarantine] DRY-RUN：未改动任何行。加 --apply 执行。')
      return
    }
    // 分层明细（先让人看清这次要动哪几层、各多少条，再决定加不加 --apply）
    const rep = classify(ledger.db)
    for (const t of opts.tiers) {
      console.log('[quarantine]   ' + t.padEnd(4) + String((rep.tiers[t] ?? []).length).padStart(5) + '  ' + (TIER_LABELS[t] ?? t))
    }
    const res = selectAndQuarantine(ledger.db, ledger, opts)
    console.log('[quarantine] 选中 ' + res.ids.length + ' 条，已隔离 ' + res.applied
      + (res.errors.length ? '，失败 ' + res.errors.length : ''))
    if (!opts.apply) console.log('[quarantine] DRY-RUN：未改动任何行。加 --apply 执行。')
    for (const e of res.errors.slice(0, 5)) console.error('  ! ' + e.id + ' ' + e.error)
  } finally {
    ledger.close()
  }
}

if (isMain) main()
