// scripts/ledger-audit.mjs — ACP 账本只读体检（2026-09-22，把 W 机手工审计固化）
// ---------------------------------------------------------------------------
// 目的：把 2026-09-22 那次手工审计的每个数字变成可重跑的命令。后续每次「精炼 / 隔离 /
// 调参」动作都能自证，不用再手算一遍。
//
// 硬约束（写进产物，不要只记在脑子里）：
//   1. **只读**。用 new DatabaseSync(path, { readOnly: true }) 打开，**不走**
//      openEvidenceLedger——那条路径会 PRAGMA journal_mode=WAL + 跑迁移 = 写。
//      因此本脚本可以在 dsh 运行中安全执行（WAL 允许并发读）。
//   2. **不写任何行**：不 append、不 setState、不写 audit。全部是 SELECT。
//   3. 规则表（读矩阵 / 归段 / token 估算 / 蒸馏跳过判据）**从 src 导入**，
//      不复制一遍——复制会漂移，导入不会。
//
// 每个数字的口径来源（可指回代码）：
//   - 蒸馏跳过    src/consolidate.mjs  isConsolidationSkippable()
//   - 蒸馏水位    acp_meta.consolidation_watermark_ts
//   - 召回窗      src/index.mjs:583-584（本会话 / 跨会话 各 <=recall 条，observed_at DESC）
//   - 归段        src/composer.mjs  sectionOf()
//   - 单条上限    src/composer.mjs  maxBody = floor(quota*0.6) - labelTokens
//   - 读资格矩阵  src/governance.mjs authorityMayClaimDomain()
//   - token 估算  src/budget.mjs    estimateTokens() + LINE_LABEL_TOKENS
//
// 用法：
//   node scripts/ledger-audit.mjs [--dir <ledgerDir>] [--session <id>] [--recall 20]
//     [--quota '{"user_model":800,"work_state":250,"memory":290,"expression":120,"rules":140}']
//     [--json] [--top 5]
//   缺省 --dir = $DSH_HOME/acp（回落 ~/.dsh/acp，见 src/home.mjs）
//   缺省 --session = 账本里最近出现的 session_id

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'
import { isConsolidationSkippable } from '../src/consolidate.mjs'
import { sectionOf } from '../src/composer.mjs'
import { authorityMayClaimDomain } from '../src/governance.mjs'
import { estimateTokens, LINE_LABEL_TOKENS } from '../src/budget.mjs'

// 生产配额（cordis.patch.yml 的 adaptive-context.sectionQuota，2026-09-22 实测值）。
// 与代码缺省 MVP_SECTION_QUOTA 不同——生产覆盖过，所以写这里而不是 import。
export const PRODUCTION_QUOTA = Object.freeze({
  user_model: 800, work_state: 250, memory: 290, expression: 120, rules: 140,
})

/** 机器消息特征（2026-09-22 审计实测的三类） */
const MACHINE_PATTERNS = [
  { key: 'skill-reviewer', label: 'background skill reviewer 任务提示', like: '%You are the background skill reviewer%' },
  { key: 'maid-archive', label: 'context-maid 压缩归档', like: '%【maid 压缩归档】%' },
  { key: 'bg-subagent', label: 'Background subagent 完成横幅', like: '%Background subagent%' },
]

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  let quota = PRODUCTION_QUOTA
  if (a.quota) {
    try { quota = { ...PRODUCTION_QUOTA, ...JSON.parse(a.quota) } } catch { /* 非法 JSON -> 用生产缺省 */ }
  }
  return {
    dir: a.dir || path.join(resolveDshHome(), 'acp'),
    session: a.session || '',
    recall: Number(a.recall || 0) || 20,
    quota,
    json: a.json === '1' || a.json === 'true',
    top: Number(a.top || 0) || 5,
  }
}

/** snake_case 行 -> 规则函数要的 camelCase 形状 */
const ev = (r) => ({
  id: r.id, sessionId: r.session_id, sourceClass: r.source_class, authority: r.authority,
  claimDomain: r.claim_domain, content: r.content, contentHash: r.content_hash,
  observedAt: r.observed_at, state: r.state,
})

export function auditLedger(db, opts) {
  const one = (sql, ...p) => db.prepare(sql).get(...p)
  const all = (sql, ...p) => db.prepare(sql).all(...p)
  const { quota, recall, top } = opts

  // ---------- 规模 ----------
  const scale = {
    total: one('SELECT COUNT(*) n FROM evidence').n,
    active: one("SELECT COUNT(*) n FROM evidence WHERE state='active'").n,
    byState: all('SELECT state, COUNT(*) n FROM evidence GROUP BY state ORDER BY n DESC'),
    byDomain: all('SELECT claim_domain d, COUNT(*) n FROM evidence GROUP BY d ORDER BY n DESC'),
    byAuthority: all('SELECT authority a, COUNT(*) n FROM evidence GROUP BY a ORDER BY n DESC'),
    dupGroups: one('SELECT COUNT(*) g, COALESCE(SUM(n-1),0) e FROM (SELECT content_hash, COUNT(*) n FROM evidence GROUP BY content_hash HAVING n>1)'),
    size: one('SELECT SUM(CASE WHEN LENGTH(content)>400 THEN 1 ELSE 0 END) gt400,'
      + ' SUM(CASE WHEN LENGTH(content)>2000 THEN 1 ELSE 0 END) gt2000,'
      + ' SUM(CASE WHEN LENGTH(TRIM(content))<16 THEN 1 ELSE 0 END) tiny FROM evidence'),
  }

  // ---------- 摄入面：机器消息 ----------
  const machine = MACHINE_PATTERNS.map((p) => {
    const r = one('SELECT COUNT(*) n, SUM(CASE WHEN state=\'active\' THEN 1 ELSE 0 END) active,'
      + ' MIN(observed_at) f, MAX(observed_at) l FROM evidence WHERE content LIKE ?', p.like)
    const auth = all('SELECT authority, claim_domain, COUNT(*) n FROM evidence WHERE content LIKE ?'
      + ' GROUP BY authority, claim_domain ORDER BY n DESC', p.like)
    // 可注入性 = 任一 (authority, claimDomain) 组合能过读矩阵
    const injectable = auth.some((x) => authorityMayClaimDomain(x.authority, x.claim_domain))
    return { key: p.key, label: p.label, n: r.n, active: r.active, f: r.f, l: r.l, authorityMix: auth, injectable }
  })

  // ---------- 蒸馏 ----------
  const watermark = one("SELECT value v FROM acp_meta WHERE key='consolidation_watermark_ts'")?.v ?? ''
  const activeRows = all("SELECT * FROM evidence WHERE state='active'").map(ev)
  const skippable = activeRows.filter((e) => isConsolidationSkippable(e))
  const queue = activeRows
    .filter((e) => (watermark ? String(e.observedAt ?? '') > watermark : true))
    .filter((e) => !isConsolidationSkippable(e))
  const queueByCat = {}
  for (const e of queue) {
    const k = e.authority + ' / ' + e.claimDomain
    queueByCat[k] = (queueByCat[k] ?? 0) + 1
  }
  const distill = {
    watermark,
    queue: queue.length,
    queueByCat: Object.entries(queueByCat).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n),
    skippedTotal: skippable.length,
    skippedRatio: activeRows.length ? skippable.length / activeRows.length : 0,
    recentRuns: all("SELECT datetime(ts/1000,'unixepoch') t, reason, payload FROM audit"
      + " WHERE op='consolidate' ORDER BY ts DESC LIMIT ?", Math.max(top, 5)),
  }

  // ---------- 召回窗（index.mjs:583-584 口径） ----------
  const session = opts.session || (one('SELECT session_id s FROM evidence ORDER BY observed_at DESC LIMIT 1')?.s ?? '')
  const sameSession = all('SELECT * FROM evidence WHERE state=\'active\' AND session_id=?'
    + ' ORDER BY observed_at DESC LIMIT ?', session, recall).map(ev)
  const crossSession = all('SELECT * FROM evidence WHERE state=\'active\' AND session_id!=?'
    + ' ORDER BY observed_at DESC LIMIT ?', session, recall).map(ev)
  const composition = {}
  for (const e of crossSession) {
    const k = e.sourceClass + ' / ' + e.authority + ' / ' + e.claimDomain
    composition[k] = (composition[k] ?? 0) + 1
  }

  const pool = [...sameSession, ...crossSession]
  const eligible = pool.filter((e) => authorityMayClaimDomain(e.authority, e.claimDomain))
  const seen = new Set()
  const deduped = []
  for (const e of eligible) {
    if (seen.has(e.contentHash)) continue
    seen.add(e.contentHash)
    deduped.push(e)
  }

  // ---------- 注入分档（composer 口径） ----------
  const bySection = {}
  for (const e of deduped) {
    const section = sectionOf(e)
    const cap = quota[section] ?? 300
    const maxBody = Math.max(40, Math.floor(cap * 0.6) - LINE_LABEL_TOKENS)
    const raw = estimateTokens(e.content)
    const highAuthority = e.authority === 'user_explicit' || e.authority === 'user_correction'
    const oversize = raw > maxBody && highAuthority          // 整条保留 -> 超配即整条丢
    const truncated = raw > maxBody && !highAuthority        // 截到 ~maxBody
    const tokens = (truncated ? maxBody : raw) + LINE_LABEL_TOKENS
    const s = bySection[section] ?? (bySection[section] = {
      section, quota: cap, n: 0, tokens: 0, oversize: 0, truncated: 0, biggest: [],
    })
    s.n += 1
    s.tokens += tokens
    if (oversize) s.oversize += 1
    if (truncated) s.truncated += 1
    s.biggest.push({ tokens, authority: e.authority, domain: e.claimDomain, preview: String(e.content).slice(0, 60) })
  }
  const injection = {
    pool: pool.length,
    eligible: eligible.length,
    afterContentDedup: deduped.length,
    sections: Object.values(bySection).map((s) => ({
      section: s.section, quota: s.quota, n: s.n, tokens: s.tokens,
      oversize: s.oversize, truncated: s.truncated,
      biggest: s.biggest.sort((a, b) => b.tokens - a.tokens).slice(0, 3),
      fill: s.quota ? Math.round((s.tokens / s.quota) * 100) : null,
    })).sort((a, b) => b.tokens - a.tokens),
  }

  // ---------- observation ----------
  const observation = {
    byState: all('SELECT state, COUNT(*) n FROM observation GROUP BY state ORDER BY n DESC'),
    byAuthority: all("SELECT authority, claim_domain, COUNT(*) n FROM observation"
      + " WHERE state='active' GROUP BY authority, claim_domain ORDER BY n DESC"),
    range: one("SELECT MIN(observed_at) f, MAX(observed_at) l FROM observation WHERE state='active'"),
  }

  return {
    ledger: opts.dir,
    scale,
    machine,
    distill,
    window: {
      session,
      sameSession: sameSession.length,
      crossSession: crossSession.length,
      composition,
    },
    injection,
    observation,
  }
}

export function render(rep) {
  const L = []
  const pct = (x) => (x * 100).toFixed(1) + '%'
  L.push('=== ACP 账本体检（只读） ===')
  L.push('库: ' + rep.ledger)
  L.push('')
  L.push('[规模]')
  L.push('  evidence ' + rep.scale.total + ' 条（active ' + rep.scale.active + '）')
  L.push('  重复: ' + rep.scale.dupGroups.g + ' 组 / ' + rep.scale.dupGroups.e + ' 条冗余（同 content_hash）')
  L.push('  体量: >400 字 ' + rep.scale.size.gt400 + ' · >2000 字 ' + rep.scale.size.gt2000 + ' · <16 字 ' + rep.scale.size.tiny)
  L.push('  域: ' + rep.scale.byDomain.map((d) => d.d + ' ' + d.n).join(' · '))
  L.push('')
  L.push('[摄入面] 机器消息')
  for (const m of rep.machine) {
    L.push('  ' + m.label + ': ' + m.n + ' 条（active ' + m.active + '）  可注入=' + (m.injectable ? '是' : '否'))
    L.push('     ' + (m.f ?? '-') + ' -> ' + (m.l ?? '-'))
    L.push('     ' + m.authorityMix.map((x) => x.authority + '/' + x.claim_domain + ' ' + x.n).join(' · '))
  }
  L.push('')
  L.push('[蒸馏]')
  L.push('  水位: ' + (rep.distill.watermark || '(无)'))
  L.push('  队列（未消化，已过 skip 过滤）: ' + rep.distill.queue + ' 条'
    + (rep.distill.queueByCat.length ? '  [' + rep.distill.queueByCat.map((q) => q.k + ' ' + q.n).join(' · ') + ']' : ''))
  L.push('  永久跳过（agent_authored + experience）: ' + rep.distill.skippedTotal + ' 条 = ' + pct(rep.distill.skippedRatio))
  L.push('  近 ' + rep.distill.recentRuns.length + ' 次 run:')
  for (const r of rep.distill.recentRuns) {
    let pl = {}
    try { pl = JSON.parse(r.payload ?? '{}') } catch { /* 旧行 payload 未必是 JSON */ }
    L.push('     ' + r.t + '  ' + (String(r.reason).startsWith('consolidation ok') ? 'ok  ' : 'FAIL')
      + (pl.batchSize != null ? ' batch=' + pl.batchSize : '') + (pl.observations != null ? ' -> obs ' + pl.observations : '')
      + (pl.error ? ' err=' + String(pl.error).slice(0, 70) : ''))
  }
  L.push('')
  L.push('[召回窗] 会话 ' + (rep.window.session || '(无)'))
  L.push('  本会话 ' + rep.window.sameSession + ' 条 · 跨会话 ' + rep.window.crossSession + ' 条')
  for (const [k, n] of Object.entries(rep.window.composition)) L.push('     ' + k + '  ' + n)
  L.push('')
  L.push('[注入分档] 池 ' + rep.injection.pool + ' -> 过读矩阵 ' + rep.injection.eligible + ' -> 内容去重后 ' + rep.injection.afterContentDedup)
  for (const s of rep.injection.sections) {
    L.push('  ' + String(s.section).padEnd(11) + s.n + ' 条  ' + s.tokens + ' tok / ' + s.quota
      + '  (' + (s.fill ?? 0) + '%)' + (s.oversize ? '  整条丢 ' + s.oversize : '') + (s.truncated ? '  截断 ' + s.truncated : ''))
    for (const b of s.biggest) {
      L.push('       ' + String(b.tokens).padStart(5) + ' tok  ' + b.authority + '/' + b.domain + '  ' + b.preview.replace(/\n/g, ' '))
    }
  }
  L.push('')
  L.push('[observation]')
  L.push('  ' + rep.observation.byState.map((o) => o.state + ' ' + o.n).join(' · '))
  L.push('  区间 ' + (rep.observation.range.f ?? '-') + ' -> ' + (rep.observation.range.l ?? '-'))
  return L.join('\n')
}

// 注意：profile 的 node_modules/dsh-adaptive-context 是**junction** 指向
// D:\DSH_workspace\my-plugins\dsh-adaptive-context，所以 import.meta.url 是 realpath、
// process.argv[1] 是 junction 路径——直接比较字符串会不等，脚本会静默不执行。
// 用 realpath 两边对齐后再比。
const isMain = (() => {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) {
    console.error('[ledger-audit] 账本不存在: ' + file)
    process.exit(2)
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rep = auditLedger(db, opts)
    console.log(opts.json ? JSON.stringify(rep, null, 2) : render(rep))
  } finally {
    db.close()
  }
}
