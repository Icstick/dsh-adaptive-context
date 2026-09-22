// scripts/dream.mjs — Dreaming 离线运行器（第一增量，2026-09-22）
// ---------------------------------------------------------------------------
// 把 src/dream.mjs 的三个确定性件跑一遍，产出候选池与冷存清单。
//
// 纪律：
//   1. **默认 dry-run**：不给 --apply 只打印计划，一行都不写。
//   2. **物理分离**：只写 candidate_memory 与 dream_run，**绝不写 observation**。
//      「候选绝不直接变成 observation」是「错误知识被自动晋升」的唯一硬防线。
//   3. **不覆盖人的决定**：库里已是 approved/rejected 的候选，重跑只更新统计字段。
//   4. 零 LLM、零新依赖。
//
// 用法：
//   node scripts/dream.mjs --dir <ledgerDir>            # 预演（默认）
//   node scripts/dream.mjs --dir <ledgerDir> --apply    # 落库（写候选池 + 台账 + audit）
//   --ttl-days N   遗忘阈值（默认 90）    --json  机器可读

import path from 'node:path'
import { existsSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME, DREAM_ARCHIVE_DAYS } from '../src/constants.mjs'
import { openEvidenceLedger } from '../src/store.mjs'
import { runDream } from '../src/dream.mjs'

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
    apply: a.apply === '1' || a.apply === 'true',
    ttlDays: Number(a['ttl-days'] || 0) || DREAM_ARCHIVE_DAYS,
    json: a.json === '1' || a.json === 'true',
  }
}

/** 从账本读出 dreaming 需要的两批行（脚本层直接读，不新增 store 公共 API） */
export function readRows(ledger) {
  const observations = ledger.db.prepare('SELECT * FROM observation').all().map((r) => ({
    id: r.id, scopeId: r.scope_id, state: r.state, subject: r.subject, predicate: r.predicate,
    claimDomain: r.claim_domain, authority: r.authority, text: r.text,
    evidenceIds: JSON.parse(r.evidence_ids || '[]'), observedAt: r.observed_at, createdAt: r.created_at,
  }))
  const evidence = ledger.db.prepare('SELECT * FROM evidence').all().map((r) => ({
    id: r.id, state: r.state, sessionId: r.session_id, claimDomain: r.claim_domain,
    observedAt: r.observed_at, createdAt: r.created_at, updatedAt: r.updated_at,
  }))
  return { observations, evidence }
}

/** 落库：写候选池（幂等）+ 台账 + audit。绝不碰 observation。 */
export function applyPlan(ledger, plan) {
  let inserted = 0
  let updated = 0
  for (const c of plan.candidates) {
    const r = ledger.upsertCandidateMemory(c)
    if (r.inserted) inserted += 1
    else updated += 1
  }
  const runId = ledger.recordDreamRun({
    windowFrom: plan.candidates.reduce((m, c) => (!m || (c.firstSeen && c.firstSeen < m) ? c.firstSeen : m), '') || null,
    windowTo: plan.candidates.reduce((m, c) => (c.lastSeen && c.lastSeen > m ? c.lastSeen : m), '') || null,
    scanned: plan.stats.scannedObservations,
    clustered: plan.stats.clusters,
    promoted: plan.stats.consensus,
    archived: plan.archival.stats.staleObservations + plan.archival.stats.staleEvidence,
    note: 'dream P1: cluster/occurrence/archive',
  })
  ledger.auditStore.appendAudit({
    op: 'dream',
    scopeId: 'user-global',
    actor: 'system',
    reason: 'dreaming run id=' + runId,
    payload: {
      runId, inserted, updated,
      clusters: plan.stats.clusters, consensus: plan.stats.consensus,
      archivedObservations: plan.archival.stats.staleObservations,
      archivedEvidence: plan.archival.stats.staleEvidence,
    },
  })
  return { runId, inserted, updated }
}

function render(plan, opts) {
  const L = []
  L.push('=== Dreaming（离线巩固，第一增量） ===')
  L.push('模式: ' + (opts.apply ? 'APPLY' : 'DRY-RUN') + '   遗忘 TTL: ' + opts.ttlDays + ' 天')
  L.push('')
  L.push('[扫描]')
  L.push('  observation 共 ' + plan.stats.scannedObservations + ' 条（active ' + plan.stats.activeObservations + '）')
  L.push('  聚成 ' + plan.stats.clusters + ' 簇；其中多成员簇 ' + plan.stats.multiMember)
  L.push('  晋升 consensus ' + plan.stats.consensus + ' · 留 candidate ' + plan.stats.candidate)
  L.push('')
  L.push('[候选池前 10]')
  for (const c of plan.candidates.slice(0, 10)) {
    L.push('  [' + c.state + '] ' + c.claimDomain + ' / ' + c.subject
      + '  成员 ' + c.observationIds.length + ' · session ' + c.sessions.length + ' · 日 ' + c.days)
    L.push('      ' + String(c.text).replace(/\n/g, ' ').slice(0, 76))
  }
  L.push('')
  L.push('[冷存清单（只标记，不删）]')
  L.push('  superseded observation: ' + plan.archival.stats.staleObservations + ' 条（TTL 前于 ' + plan.archival.stats.cutoffIso.slice(0, 10) + '）')
  L.push('  quarantined evidence:   ' + plan.archival.stats.staleEvidence + ' 条')
  return L.join('\n')
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'dream.mjs'))
})()

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) {
    console.error('[dream] 账本不存在: ' + file)
    process.exit(2)
  }
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const { observations, evidence } = readRows(ledger)
    const plan = runDream({ observations, evidence }, { ttlDays: opts.ttlDays })
    if (opts.json) {
      console.log(JSON.stringify({ apply: opts.apply, stats: plan.stats, archival: plan.archival.stats, candidates: plan.candidates }, null, 2))
    } else {
      console.log(render(plan, opts))
    }
    if (!opts.apply) {
      if (!opts.json) console.log('\n[DRY-RUN] 未改动任何行。加 --apply 落库（只写 candidate_memory / dream_run）。')
      return
    }
    const res = applyPlan(ledger, plan)
    console.log('[dream] 已落库：候选 新增 ' + res.inserted + ' / 更新 ' + res.updated + '，run id=' + res.runId)
  } finally {
    ledger.close()
  }
}

if (isMain) main()
