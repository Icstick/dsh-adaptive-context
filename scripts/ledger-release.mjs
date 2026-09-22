// scripts/ledger-release.mjs — 跨机导入行的「放行 / 撤回」（P1-4.1 S3）
// ---------------------------------------------------------------------------
// 背景：S2 把跨机 observation 一律导成 state='quarantined'（读侧只取 active，故不注入）。
//       S3 就是**分批**把它们翻成 active —— 这是唯一会改变注入面的动作，因此要有三样东西：
//         ① 分批（按域 / 按 authority）
//         ② 每次都先给人看清单（预演）
//         ③ 可撤回（--revoke 用本次写出的 release 清单原路翻回）
//
// 用法：
//   node scripts/ledger-release.mjs --manifests <a.json.manifest.json>[,<b>...] \
//        [--domains user_fact,user_preference,user_correction] [--authorities user_explicit,user_correction] \
//        [--sample 12] [--apply]
//   node scripts/ledger-release.mjs --revoke <released-<ts>.json> [--apply]
//   --dir 缺省 = $DSH_HOME/acp
//
// 说明：只认「由 ledger-import.mjs 导入过的 id」（来自各次导入写的 manifest），
//       不会碰本机自己蒸馏出来的行。

import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { openEvidenceLedger } from '../src/store.mjs'
import { resolveDshHome } from '../src/home.mjs'

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null)
  return {
    dir: a.dir || path.join(resolveDshHome(), 'acp'),
    manifests: csv(a.manifests) ?? [],
    domains: csv(a.domains),
    authorities: csv(a.authorities),
    sample: Number(a.sample ?? 12),
    revoke: a.revoke || '',
    apply: a.apply === '1' || a.apply === 'true',
  }
}

/** 从若干导入 manifest 收集 id → 源机 */
export function collectIds(manifestFiles) {
  const map = new Map()
  for (const f of manifestFiles) {
    const m = JSON.parse(readFileSync(f, 'utf8'))
    for (const id of m.ids ?? []) if (!map.has(id)) map.set(id, m.from ?? '(unknown)')
  }
  return map
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    if (opts.revoke) {
      const list = JSON.parse(readFileSync(opts.revoke, 'utf8'))
      const ids = list.ids ?? []
      const out = { mode: opts.apply ? 'APPLY' : 'DRY-RUN', action: 'revoke', file: opts.revoke, ids: ids.length }
      if (opts.apply) {
        const stmt = ledger.db.prepare("UPDATE observation SET state = 'quarantined' WHERE id = ? AND state = 'active'")
        let n = 0
        for (const id of ids) n += Number(stmt.run(id).changes)
        out.revoked = n
      }
      console.log(JSON.stringify(out, null, 1))
      return
    }
    if (opts.manifests.length === 0) {
      console.error('用法: node scripts/ledger-release.mjs --manifests <m1.json,m2.json> [--domains ...] [--apply]')
      process.exit(2)
    }
    const fromMap = collectIds(opts.manifests)
    const rows = []
    for (const id of fromMap.keys()) {
      const r = ledger.db.prepare('SELECT id, subject, predicate, claim_domain, authority, state, text FROM observation WHERE id = ?').get(id)
      if (r) rows.push({ ...r, from: fromMap.get(id) })
    }
    const pending = rows.filter((r) => r.state === 'quarantined')
    const inScope = pending.filter((r) =>
      (!opts.domains || opts.domains.includes(r.claim_domain)) &&
      (!opts.authorities || opts.authorities.includes(r.authority)))
    const byDomain = {}, byAuthority = {}, byFrom = {}
    for (const r of inScope) {
      byDomain[r.claim_domain] = (byDomain[r.claim_domain] ?? 0) + 1
      byAuthority[r.authority ?? '(null)'] = (byAuthority[r.authority ?? '(null)'] ?? 0) + 1
      byFrom[r.from] = (byFrom[r.from] ?? 0) + 1
    }
    const out = {
      mode: opts.apply ? 'APPLY' : 'DRY-RUN',
      db: path.join(opts.dir, 'acp-ledger.db'),
      manifests: opts.manifests,
      domains: opts.domains ?? '(全部)',
      authorities: opts.authorities ?? '(全部)',
      importedRows: rows.length,
      alreadyActive: rows.length - pending.length,
      toRelease: inScope.length,
      byDomain, byAuthority, byFrom,
      sample: inScope.slice(0, opts.sample).map((r) => '[' + r.from + '/' + r.claim_domain + '] ' + r.subject + ' ' + r.predicate + ' → ' + String(r.text).slice(0, 60)),
    }
    if (opts.apply) {
      const stmt = ledger.db.prepare("UPDATE observation SET state = 'active' WHERE id = ? AND state = 'quarantined'")
      let n = 0
      for (const r of inScope) n += Number(stmt.run(r.id).changes)
      out.released = n
      const f = path.join(path.dirname(opts.manifests[0]), 'released-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json')
      writeFileSync(f, JSON.stringify({ releasedAt: new Date().toISOString(), domains: opts.domains, authorities: opts.authorities, ids: inScope.map((r) => r.id) }, null, 1), 'utf8')
      out.releaseList = f
    }
    console.log(JSON.stringify(out, null, 1))
  } finally {
    ledger.close?.()
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-release.mjs'))
})()
if (isMain) main()
