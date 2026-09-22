// scripts/dream-review.mjs — Dreaming 候选池的人工审入口（2026-09-22）
// ---------------------------------------------------------------------------
// 方案 4 的人工门：候选池里 candidate/consensus → approved/rejected。
// 没有这一步，导出器就没有可导的行——「人工审」会变成一句空话。
//
// 与 ledger-quarantine-apply.mjs 的差别：那边是**批量**动作，默认 dry-run；
// 这边是**逐条点名**（你指定 id），所以直接生效，靠 audit + 反向操作回滚。
//
// 用法：
//   node scripts/dream-review.mjs --dir <ledgerDir> --list [--state candidate] [--domain work]
//   node scripts/dream-review.mjs --dir <ledgerDir> --approve cm_xxx cm_yyy [--reason "..."]
//   node scripts/dream-review.mjs --dir <ledgerDir> --reject  cm_zzz
//
// 状态迁移不做白名单限制（人改了主意是常事），但每一次都记 from→to 审计。

import path from 'node:path'
import { existsSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME, CANDIDATE_MEMORY_STATES } from '../src/constants.mjs'
import { openEvidenceLedger } from '../src/store.mjs'

// 布尔开关：**不消费下一个 token**——否则 `--approve cm_1 cm_2` 会把 cm_1 当成 --approve 的值，
// 剩下两个 id 也进不了 positional（首次写测试时就踩了这个）。
const BOOLEAN_FLAGS = new Set(['list', 'approve', 'reject', 'json'])

export function parseArgs(argv) {
  const a = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k) continue
    if (k.startsWith('--')) {
      const name = k.replace(/^--/, '')
      if (BOOLEAN_FLAGS.has(name)) { a[name] = '1'; continue }
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { a[name] = next; i += 1 } else { a[name] = '1' }
    } else positional.push(k)
  }
  return {
    dir: a.dir || path.join(resolveDshHome(), 'acp'),
    list: Boolean(a.list),
    state: a.state || '',
    domain: a.domain || '',
    limit: Number(a.limit || 20) || 20,
    reason: a.reason || '',
    json: Boolean(a.json),
    ids: positional,
    approve: a.approve === '1',
    reject: a.reject === '1',
  }
}

/** 逐条迁移状态 + 审计。返回 {moved, errors}，**不吞错**：失败的 id 逐条报出。 */
export function reviewCandidates(ledger, ids, toState, reason = '') {
  if (!CANDIDATE_MEMORY_STATES.includes(toState)) {
    throw new TypeError('state must be one of ' + CANDIDATE_MEMORY_STATES.join('|') + ', got ' + JSON.stringify(toState))
  }
  const errors = []
  const moved = []
  for (const id of ids) {
    try {
      const row = ledger.getCandidateMemoryById(id)
      if (!row) { errors.push({ id, error: 'not found' }); continue }
      ledger.db.prepare('UPDATE candidate_memory SET state = ?, updated_at = ? WHERE id = ?')
        .run(toState, Date.now(), id)
      ledger.auditStore.appendAudit({
        op: 'dream_review',
        targetId: id,
        scopeId: row.scopeId,
        actor: 'user',
        reason: reason || ('dream candidate ' + row.state + ' -> ' + toState),
        payload: { from: row.state, to: toState, claimDomain: row.claimDomain, subject: row.subject },
      })
      moved.push({ id, from: row.state, to: toState })
    } catch (err) {
      errors.push({ id, error: String((err && err.message) || err) })
    }
  }
  return { moved, errors }
}

export function renderList(items, total) {
  if (items.length === 0) return '（没有匹配的候选）'
  const L = []
  for (const c of items) {
    L.push('[' + c.state + '] ' + c.id)
    L.push('    ' + c.claimDomain + ' / ' + c.subject + '   复现 ' + c.occurrences
      + ' · session ' + c.sessions.length + ' · 日 ' + c.days)
    L.push('    ' + String(c.text).replace(/\n/g, ' ').slice(0, 88))
  }
  L.push('')
  L.push('共 ' + total + ' 条匹配，显示 ' + items.length + ' 条')
  return L.join('\n')
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'dream-review.mjs'))
})()

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) { console.error('[review] 账本不存在: ' + file); process.exit(2) }
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    if (opts.approve || opts.reject) {
      if (opts.ids.length === 0) { console.error('[review] 需要一个或多个候选 id'); process.exit(2) }
      const to = opts.approve ? 'approved' : 'rejected'
      const r = reviewCandidates(ledger, opts.ids, to, opts.reason)
      for (const m of r.moved) console.log('  ' + m.from + ' -> ' + m.to + '  ' + m.id)
      console.log('[review] 已处理 ' + r.moved.length + ' 条' + (r.errors.length ? '，失败 ' + r.errors.length + ' 条' : ''))
      for (const e of r.errors) console.error('  ! ' + e.id + ' ' + e.error)
      return
    }
    const res = ledger.queryCandidateMemory({ state: opts.state || undefined, claimDomain: opts.domain || undefined, limit: opts.limit })
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return }
    console.log(renderList(res.items, res.total))
  } finally { ledger.close() }
}

if (isMain) main()
