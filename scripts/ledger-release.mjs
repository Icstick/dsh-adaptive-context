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
import { gateVerdict } from '../src/release-gate.mjs'

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
    allowNoise: a['allow-noise'] === '1' || a['allow-noise'] === 'true',
    softPass: a['soft-pass'] === '1' || a['soft-pass'] === 'true',
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
    // 质量闸门：默认开（--allow-noise 可关，用于「我知道这批次脏、但我要它」的场合）。
    // 2026-09-24 第二批：判据搬到 src/release-gate.mjs（七类 + 三档）。三档语义：
    //   pass            → 放行
    //   soft_tag        → **默认不放行**（漏放会污染所有下游机，误杀只花审核工时）→ --soft-pass 可放
    //   hard_quarantine → 不放行，留在隔离区（= 人工队列）
    const judged = inScope.map((r) => ({ r, v: gateVerdict(r) }))
    const hardRows = opts.allowNoise ? [] : judged.filter((x) => x.v.decision === 'hard_quarantine')
    const softRows = opts.allowNoise ? [] : judged.filter((x) => x.v.decision === 'soft_tag')
    const passed = opts.allowNoise
      ? judged.map((x) => x.r)
      : judged.filter((x) => x.v.decision === 'pass' || (opts.softPass && x.v.decision === 'soft_tag')).map((x) => x.r)
    const byHard = {}, bySoft = {}
    for (const x of hardRows) byHard[x.v.class] = (byHard[x.v.class] ?? 0) + 1
    for (const x of softRows) bySoft[x.v.class] = (bySoft[x.v.class] ?? 0) + 1
    const fmt = (x) => '[' + x.v.class + '] ' + x.r.from + '/' + x.r.claim_domain + ' · ' + x.r.subject + ' · ' + String(x.v.evidence_span).slice(0, 40) + (x.v.tags.length ? ' · #' + x.v.tags.join(',') : '')
    const byDomain = {}, byAuthority = {}, byFrom = {}
    for (const r of passed) {
      byDomain[r.claim_domain] = (byDomain[r.claim_domain] ?? 0) + 1
      byAuthority[r.authority ?? '(null)'] = (byAuthority[r.authority ?? '(null)'] ?? 0) + 1
      byFrom[r.from] = (byFrom[r.from] ?? 0) + 1
    }
    const out = {
      mode: opts.apply ? 'APPLY' : 'DRY-RUN',
      db: path.join(opts.dir, 'acp-ledger.db'),
      qualityGate: opts.allowNoise ? 'OFF (--allow-noise)' : 'ON · 七类判据 src/release-gate.mjs',
      softPolicy: opts.softPass ? '放行（--soft-pass）' : '不放行（进人工队列；--soft-pass 可放）',
      rejectedByGate: hardRows.length,
      byReject: byHard, // 兼容旧字段名；内容改为新类名（english/selfref/ephemeral/env-bound/one-shot-path/stale-version/empty-emotion）
      rejectSample: hardRows.slice(0, 6).map(fmt),
      softHeld: opts.softPass ? 0 : softRows.length,
      bySoft,
      softSample: softRows.slice(0, 6).map(fmt),
      manifests: opts.manifests,
      domains: opts.domains ?? '(全部)',
      authorities: opts.authorities ?? '(全部)',
      importedRows: rows.length,
      alreadyActive: rows.length - pending.length,
      toRelease: passed.length,
      byDomain, byAuthority, byFrom,
      sample: passed.slice(0, opts.sample).map((r) => '[' + r.from + '/' + r.claim_domain + '] ' + r.subject + ' ' + r.predicate + ' → ' + String(r.text).slice(0, 60)),
    }
    if (opts.apply) {
      const stmt = ledger.db.prepare("UPDATE observation SET state = 'active' WHERE id = ? AND state = 'quarantined'")
      let n = 0
      for (const r of passed) n += Number(stmt.run(r.id).changes)
      out.released = n
      const f = path.join(path.dirname(opts.manifests[0]), 'released-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json')
      writeFileSync(f, JSON.stringify({
        releasedAt: new Date().toISOString(),
        domains: opts.domains,
        authorities: opts.authorities,
        qualityGate: out.qualityGate,
        softPolicy: out.softPolicy,
        rejected: hardRows.length,
        softHeld: softRows.length,
        ids: passed.map((r) => r.id),
        heldIds: [...hardRows, ...(opts.softPass ? [] : softRows)].map((x) => x.r.id),
      }, null, 1), 'utf8')
      out.releaseList = f
    }
    console.log(JSON.stringify(out, null, 1))
  } finally {
    ledger.close?.()
  }
}

// ===================== 质量闸门（第二批起搬到 src/release-gate.mjs）=====================
// 旧实现是这里的三个正则一票否决（见 docs/ops/s3-batch1-release-20260922.md §4.5）。
// 2026-09-24 第二批按云端判据（docs/plans/cloud-batch-2-20260923.md 任务 2）重写为
// 七类 + 三档，实现与阈值集中在 src/release-gate.mjs；这里只做**转出**，
// 保持旧导入路径不变（test 与运维脚本仍从 scripts/ledger-release.mjs 取这两个符号）。
export { qualityVerdict, isEnglishOnly, SELFREF_SUBJECT_RE, gateVerdict, GATE_CONFIG } from '../src/release-gate.mjs'

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-release.mjs'))
})()
if (isMain) main()
