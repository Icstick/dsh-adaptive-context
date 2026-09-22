// scripts/dream-export.mjs — Dreaming 候选 → weaver 导入格式的导出器（2026-09-22）
// ---------------------------------------------------------------------------
// 方案 4 的单向通道（见 docs/design/DREAMING.md §10）：
//   候选池 approved 且 claimDomain ∈ {work, external_fact} → JSONL → **人工跑** wv import
//
// 三条硬纪律：
//   1. **weaver 侧零改动**：本脚本只写一个本地 JSONL 文件，不碰任何 weaver 库。
//   2. **画像域永不导出**：user_preference / user_fact / style 一律拒绝，无论状态。
//   3. **不新造语义**：title 是正文的**截取**，不是生成；body 原文照抄 + 附溯源。
//
// 输出格式对齐 .tooling/lib/wv.mjs 的 putOne/import 契约：
//   title(必填) / summary / body / source / tags / confidence / category / game / node_type / id
//   （逐条 library 字段可覆盖 --lib；重名会被 wv 判 DUPLICATE_TITLE 跳过）
//
// 用法：
//   node scripts/dream-export.mjs --dir <ledgerDir> [--lib work-skill] [--out f.jsonl]
//   --state approved|candidate|consensus   （默认 approved）
//   不给 --out 就只打印预览

import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'
import { openEvidenceLedger } from '../src/store.mjs'

/** 允许导出的域（方案 4 的白名单）。画像三域**永不**在内。 */
export const EXPORTABLE_DOMAINS = Object.freeze(['work', 'external_fact'])
/** 不允许出 ACP 的域（显式写出来，免得后来人以为漏了） */
export const BLOCKED_DOMAINS = Object.freeze(['user_preference', 'user_fact', 'style'])

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
    state: a.state || 'approved',
    lib: a.lib || '',
    out: a.out || '',
    limit: Number(a.limit || 0) || 0,
    json: a.json === '1' || a.json === 'true',
  }
}

/** title = 正文截取（不做摘要、不改写）。优先在标点处收尾，收不到就硬截。 */
export function deriveTitle(text, subject = '', max = 48) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return subject || '(无正文)'
  const head = t.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'),
    head.lastIndexOf('.'), head.lastIndexOf(';'), head.lastIndexOf(','))
  return (cut >= 12 ? head.slice(0, cut) : head).trim()
}

/** 溯源脚注：weaver 条目要能回到 ACP 的证据链（对应 CONTRACTS 的可回溯要求） */
export function provenanceFooter(c, minEvidence = 12) {
  const ev = (c.evidenceIds ?? []).slice(0, 20)
  return [
    '',
    '---',
    '来源：ACP dreaming 候选 ' + c.id + '（claimDomain=' + c.claimDomain + '）',
    '复现：' + c.occurrences + ' 次 · ' + (c.sessions ?? []).length + ' 个会话 · ' + c.days + ' 个自然日',
    '区间：' + (c.firstSeen || '?') + ' → ' + (c.lastSeen || '?'),
    '证据回链（' + (c.evidenceIds ?? []).length + ' 条，示前 ' + Math.min(minEvidence, ev.length) + '）：' + ev.join(' '),
  ].join('\n')
}

/** 候选 → wv import 记录（纯函数，可测） */
export function toWeaverRecord(c, opts = {}) {
  const text = String(c.text ?? '').trim()
  const conf = c.occurrences >= 3 ? 0.9 : c.occurrences === 2 ? 0.8 : 0.7
  const rec = {
    title: deriveTitle(text, c.subject),
    summary: text.slice(0, 200),
    body: text + provenanceFooter(c),
    source: 'acp-dreaming:' + c.id,
    tags: ['acp-dreaming', c.claimDomain],
    confidence: conf,
  }
  if (opts.lib) rec.library = opts.lib
  return rec
}

/** 白名单过滤 + 组装。返回 {records, blocked, skipped} */
export function buildExport(candidates, opts = {}) {
  const records = []
  const blocked = []
  for (const c of candidates) {
    if (!EXPORTABLE_DOMAINS.includes(c.claimDomain)) { blocked.push({ id: c.id, domain: c.claimDomain }); continue }
    if ((c.evidenceIds ?? []).length === 0) { blocked.push({ id: c.id, domain: c.claimDomain, reason: '无证据回链' }); continue }
    records.push(toWeaverRecord(c, opts))
  }
  return { records, blocked }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'dream-export.mjs'))
})()

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) { console.error('[export] 账本不存在: ' + file); process.exit(2) }
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const res = ledger.queryCandidateMemory({ state: opts.state, limit: opts.limit || 500 })
    const { records, blocked } = buildExport(res.items, { lib: opts.lib })
    if (opts.json) { console.log(JSON.stringify({ records, blocked }, null, 2)); return }
    console.log('[export] state=' + opts.state + '  匹配 ' + res.total + ' 条'
      + (opts.lib ? '  --lib ' + opts.lib : '  （未给 --lib，导入时需 wv import --lib <lib>）'))
    for (const b of blocked) {
      console.log('  [挡下] ' + b.domain + (b.reason ? '（' + b.reason + '）' : '（画像域，永不出 ACP）') + '  ' + b.id)
    }
    console.log('  可导出 ' + records.length + ' 条，挡下 ' + blocked.length + ' 条')
    const jsonl = records.map((r) => JSON.stringify(r)).join('\n')
    if (opts.out) {
      writeFileSync(opts.out, jsonl + '\n', 'utf8')
      console.log('[export] 已写 ' + opts.out)
      console.log('[export] 下一步（人工）：wv import ' + opts.out + (opts.lib ? ' --lib ' + opts.lib : ' --lib <lib>'))
    } else {
      console.log('--- 预览（给 --out <file> 才落盘）---')
      console.log(jsonl.slice(0, 1600))
    }
  } finally { ledger.close() }
}

if (isMain) main()
