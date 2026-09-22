// scripts/ledger-import.mjs — 跨机 observation 导入（P1-4.1 S2）
// ---------------------------------------------------------------------------
// 协议：docs/plans/sync-boundary-protocol-20260922.md §2/§3/§4
//
// 三条不变量（改这个脚本前先读一遍）：
//   1. **只导 L1 observation**。evidence 永不跨机；本脚本遇到别的 kind 直接忽略并计数。
//   2. **落库即 quarantined**：跨机行一律先隔离（不注入），人工审过再放行。因此
//      「导入」这个动作**永远不会改变注入面** —— 这也是它的回滚方案（什么都不用回滚）。
//   3. **append-only 不破**：只 INSERT 新行，不改任何本地既有行。
//
// 跨机行的处理：
//   - 保留源 id（幂等：重复导入同一文件 = 全部 skipped）
//   - `evidenceIds` / `supersedes` **清空** —— evidence 不同步，跨机引用必然是悬空的
//     （本地读侧解析不到那些 ev_* 会当作证据缺失；留着比清掉更误导）
//   - `authority` 原样保留（**不提升**：协议 §3.3）
//   - 溯源写进同目录的 <in>.manifest.json（源文件、源机、被导入的 id 列表、时间）
//
// 去重（两道）：
//   a) id 命中 → importJsonl 自己 skipped
//   b) **内容键** (scopeId|subject|predicate|claimDomain|text) 命中本地任意 observation
//      （含 superseded / quarantined）→ 本脚本跳过 —— 这是「同一件事在两台机器各蒸了一遍」的情形
//
// 用法：
//   node scripts/ledger-import.mjs --in <file.jsonl> [--from W]           # 预演
//   node scripts/ledger-import.mjs --in <file.jsonl> --from W --apply     # 执行
//   --domains user_fact,user_preference,user_correction,work,external_fact,style   # 缺省（排除 experience）
//   --include-experience                                                  # 显式放行 experience（默认禁止）

import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { openEvidenceLedger } from '../src/store.mjs'
import { importJsonl } from '../src/export-import.mjs'
import { resolveDshHome } from '../src/home.mjs'

export const DEFAULT_DOMAINS = ['user_fact', 'user_preference', 'user_correction', 'work', 'external_fact', 'style']

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  return {
    dir: a.dir || path.join(resolveDshHome(), 'acp'),
    inFile: a.in || '',
    from: a.from || '(unknown)',
    apply: a.apply === '1' || a.apply === 'true',
    release: a.release || '',
    domains: a['include-experience'] === '1'
      ? null
      : (a.domains ? a.domains.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_DOMAINS),
  }
}

const keyOf = (o) => [o.scopeId ?? 'user-global', o.subject, o.predicate, o.claimDomain, o.text].join('|')

/** 本地全部 observation 的内容键集合（含非 active —— 判重要保守） */
export function localKeys(ledger) {
  const rows = ledger.db.prepare('SELECT scope_id, subject, predicate, claim_domain, text FROM observation').all()
  return new Set(rows.map((r) => [r.scope_id, r.subject, r.predicate, r.claim_domain, r.text].join('|')))
}

/** 过滤 + 改写，返回 {keep:[], stats:{}} —— 纯函数，便于测试 */
export function planImport(lines, keys, domains) {
  const stats = { total: 0, notObservation: 0, domainFiltered: 0, dupKey: 0, dupId: 0, keep: 0 }
  const keep = []
  const seen = new Set()
  for (const line of lines) {
    let o
    try { o = JSON.parse(line) } catch { stats.notObservation += 1; continue }
    if (o?.kind !== 'observation') { stats.notObservation += 1; continue }
    stats.total += 1
    const d = o.data || {}
    if (domains && !domains.includes(d.claimDomain)) { stats.domainFiltered += 1; continue }
    const k = keyOf(d)
    if (keys.has(k) || seen.has(k)) { stats.dupKey += 1; continue }
    seen.add(k)
    keep.push({
      ...o,
      data: { ...d, evidenceIds: [], supersedes: [], state: 'quarantined' },
    })
    stats.keep += 1
  }
  return { keep, stats }
}

/** 放行：把 manifest 里记的 id 由 quarantined 翻回 active（唯一的「生效」入口） */
function release(ledger, manifestFile, apply) {
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const ids = Array.isArray(m.ids) ? m.ids : []
  const rows = ids.map((id) => ledger.db.prepare('SELECT id, state FROM observation WHERE id = ?').get(id)).filter(Boolean)
  const pending = rows.filter((r) => r.state === 'quarantined')
  const out = { mode: apply ? 'APPLY' : 'DRY-RUN', action: 'release', manifest: manifestFile, from: m.from ?? '(unknown)', found: rows.length, toRelease: pending.length, notQuarantined: rows.length - pending.length }
  if (apply) {
    const stmt = ledger.db.prepare("UPDATE observation SET state = 'active' WHERE id = ? AND state = 'quarantined'")
    let n = 0
    for (const r of pending) n += Number(stmt.run(r.id).changes)
    out.released = n
  }
  console.log(JSON.stringify(out, null, 1))
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.release) {
    const ledger = openEvidenceLedger({ dir: opts.dir })
    try { release(ledger, opts.release, opts.apply) } finally { ledger.close?.() }
    return
  }
  if (!opts.inFile) {
    console.error('用法: node scripts/ledger-import.mjs --in <file.jsonl> [--from W] [--apply]')
    process.exit(2)
  }
  const text = readFileSync(opts.inFile, 'utf8')
  const lines = text.split(/\r?\n/).filter(Boolean)
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const keys = localKeys(ledger)
    const { keep, stats } = planImport(lines, keys, opts.domains)
    const out = {
      mode: opts.apply ? 'APPLY' : 'DRY-RUN',
      db: path.join(opts.dir, 'acp-ledger.db'),
      from: opts.from,
      in: opts.inFile,
      domains: opts.domains ?? '(全部，含 experience)',
      stats,
    }
    if (!opts.apply) {
      console.log(JSON.stringify(out, null, 1))
      console.log('（DRY-RUN，未写入。加 --apply 执行）')
      return
    }
    const payload = keep.map((o) => JSON.stringify(o)).join('\n') + (keep.length ? '\n' : '')
    const res = importJsonl(payload, { ledger })
    out.imported = res.inserted
    out.skippedById = res.skipped
    out.errors = res.errors.slice(0, 5)
    const manifest = opts.inFile + '.manifest.json'
    writeFileSync(manifest, JSON.stringify({
      importedAt: new Date().toISOString(),
      from: opts.from,
      source: opts.inFile,
      db: out.db,
      count: res.inserted,
      ids: keep.map((o) => o.data.id),
    }, null, 1), 'utf8')
    out.manifest = manifest
    console.log(JSON.stringify(out, null, 1))
  } finally {
    ledger.close?.()
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-import.mjs'))
})()
if (isMain) main()
