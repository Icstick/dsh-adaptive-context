// scripts/ledger-quarantine-candidates.mjs — 存量隔离候选清单（只读，2026-09-22）
// ---------------------------------------------------------------------------
// 目的：把「哪些旧证据该隔离」从一次手算变成可复跑的清单。**只出清单，不动数据。**
//
// 硬约束：
//   1. 只读：new DatabaseSync(path, { readOnly: true })，不走 openEvidenceLedger（那条路会写）。
//   2. 不写账本、不写 audit。产出只有 stdout，或 --out <dir> 下的两个文件。
//   3. **不动溯源链**：被 active observation 的 evidence_ids 引用的证据一律进 KEEP。
//
// 分层（互斥，按此顺序判定，先命中先归）：
//   T1a background skill reviewer 任务提示   —— 模板命中
//   T1b context-maid 压缩归档                —— 【maid 压缩归档】前缀
//   T1c Background subagent 完成横幅         —— 模板命中
//   T2  子代理会话的模型独白                  —— session_id 非 session- 前缀 + single_observation
//   T3  主会话的模型自述                      —— session- 前缀 + agent_authored/single_observation
//   T4  同内容重复行（第 2..n 条）            —— 同 content_hash
//   T5  极短用户消息（<=15 字）               —— 真人输入但无语义
//   KEEP                                     —— 溯源链 + 正常用户消息 + 重复组首条
//
// 用法：
//   node scripts/ledger-quarantine-candidates.mjs [--dir <ledgerDir>] [--out <dir>] [--json]
//   给 --out 时写 quarantine-candidates-<date>.jsonl（明细）+ .md（摘要）。
//   不落全量正文，只留 90 字预览——账本里是私人对话。

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'

export const TIER_LABELS = Object.freeze({
  T1a: 'background skill reviewer 任务提示',
  T1b: 'context-maid 压缩归档',
  T1c: 'Background subagent 完成横幅',
  T2: '子代理会话的模型独白',
  T3: '主会话的模型自述',
  T4: '同内容重复行（第 2..n 条）',
  T5: '极短用户消息（<=15 字）',
})

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
    out: a.out || '',
    json: a.json === '1' || a.json === 'true',
    shortChars: Number(a['short-chars'] || 15) || 15,
  }
}

/** 被 active observation 引用的证据 id（溯源链，不动） */
export function protectedIds(db) {
  const out = new Set()
  for (const o of db.prepare("SELECT evidence_ids FROM observation WHERE state='active'").all()) {
    try { for (const id of JSON.parse(o.evidence_ids)) out.add(id) } catch { /* 脏行忽略 */ }
  }
  return out
}

/**
 * 分层。tiers: { [tier]: row[] }，含 KEEP。
 * @returns {{tiers: object, total: number, candidates: number}}
 */
export function classify(db, { shortChars = 15 } = {}) {
  const prot = protectedIds(db)
  const rows = db.prepare(`SELECT id, source_class, authority, claim_domain, session_id, session_type,
      LENGTH(content) len, substr(content,1,90) preview, content_hash
    FROM evidence WHERE state='active'`).all()

  const hashCount = new Map()
  for (const r of rows) hashCount.set(r.content_hash, (hashCount.get(r.content_hash) ?? 0) + 1)
  const dupSeen = new Set()

  const tiers = {}
  for (const k of [...Object.keys(TIER_LABELS), 'KEEP']) tiers[k] = []

  for (const r of rows) {
    const c = r.preview ?? ''
    const bare = !!r.session_id && !r.session_id.startsWith('session-')
    let tier
    if (c.includes('You are the background skill reviewer')) tier = 'T1a'
    else if (c.includes('【maid 压缩归档】')) tier = 'T1b'
    else if (c.includes('Background subagent')) tier = 'T1c'
    else if (prot.has(r.id)) tier = 'KEEP'
    else if (bare && r.authority === 'single_observation') tier = 'T2'
    else if (r.session_id?.startsWith('session-') && r.source_class === 'agent_authored'
      && r.authority === 'single_observation') tier = 'T3'
    else if ((hashCount.get(r.content_hash) ?? 0) > 1) {
      if (dupSeen.has(r.content_hash)) tier = 'T4'
      else { dupSeen.add(r.content_hash); tier = 'KEEP' }
    } else if (r.source_class === 'user_input' && r.len <= shortChars) tier = 'T5'
    else tier = 'KEEP'

    tiers[tier].push({ ...r, tier })
  }
  const candidates = Object.entries(tiers)
    .filter(([k]) => k !== 'KEEP')
    .reduce((n, [, v]) => n + v.length, 0)
  return { tiers, total: rows.length, candidates, protectedCount: prot.size }
}

/** 隔离后的账面：域分布变了多少 */
export function simulate(db, tiers, keepTiers) {
  const kill = new Set(keepTiers.flatMap((t) => tiers[t] ?? []).map((r) => r.id))
  const byDomain = {}
  let kept = 0
  for (const rows of Object.values(tiers)) {
    for (const r of rows) {
      if (kill.has(r.id)) continue
      kept += 1
      byDomain[r.claim_domain] = (byDomain[r.claim_domain] ?? 0) + 1
    }
  }
  return { quarantined: Object.values(tiers).flat().length - kept, kept, byDomain }
}

export function render(rep, sims) {
  const L = []
  L.push('=== ACP 存量隔离候选清单（只读） ===')
  L.push('库: ' + rep.dir)
  L.push('')
  L.push('active 证据 ' + rep.total + ' 条 → 候选 ' + rep.candidates + '，保留 ' + (rep.total - rep.candidates)
    + '（含 ' + rep.protectedCount + ' 条溯源链）')
  L.push('')
  for (const k of Object.keys(TIER_LABELS)) {
    L.push('  ' + k.padEnd(4) + rep.tiers[k].length.toString().padStart(5) + '  ' + TIER_LABELS[k])
  }
  L.push('  ' + 'KEEP'.padEnd(4) + rep.tiers.KEEP.length.toString().padStart(5) + '  保留')
  L.push('')
  L.push('隔离后账面（模拟，未执行）：')
  for (const [name, s] of Object.entries(sims)) {
    L.push('  ' + name.padEnd(34) + '隔离 ' + String(s.quarantined).padStart(5) + ' → 剩 ' + String(s.kept).padStart(5)
      + '  [' + Object.entries(s.byDomain).map(([d, n]) => d + ' ' + n).join(' · ') + ']')
  }
  return L.join('\n')
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-quarantine-candidates.mjs'))
})()

if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) {
    console.error('[candidates] 账本不存在: ' + file)
    process.exit(2)
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rep = classify(db, { shortChars: opts.shortChars })
    const sims = {
      'A  T1': simulate(db, rep.tiers, ['T1a', 'T1b', 'T1c']),
      'B  T1+T2': simulate(db, rep.tiers, ['T1a', 'T1b', 'T1c', 'T2']),
      'C  T1+T2+T3': simulate(db, rep.tiers, ['T1a', 'T1b', 'T1c', 'T2', 'T3']),
      'D  全量': simulate(db, rep.tiers, ['T1a', 'T1b', 'T1c', 'T2', 'T3', 'T4', 'T5']),
    }
    if (opts.json) {
      console.log(JSON.stringify({ total: rep.total, candidates: rep.candidates, counts: Object.fromEntries(Object.entries(rep.tiers).map(([k, v]) => [k, v.length])), sims }, null, 2))
    } else {
      console.log(render({ ...rep, dir: opts.dir }, sims))
    }
    if (opts.out) {
      const day = new Date().toISOString().slice(0, 10)
      const lines = Object.entries(rep.tiers).filter(([k]) => k !== 'KEEP').flatMap(([tier, rows]) =>
        rows.map((r) => JSON.stringify({ id: r.id, tier, tierLabel: TIER_LABELS[tier], authority: r.authority, claimDomain: r.claim_domain, sessionType: r.session_type, len: r.len, preview: r.preview })))
      const jsonl = path.join(opts.out, 'quarantine-candidates-' + day + '.jsonl')
      writeFileSync(jsonl, lines.join('\n') + '\n', 'utf8')
      console.log('\n明细已写: ' + jsonl + '（' + lines.length + ' 行）')
    }
  } finally {
    db.close()
  }
}
