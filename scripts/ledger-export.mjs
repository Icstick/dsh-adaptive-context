// scripts/ledger-export.mjs — ACP 账本 → JSONL（P1-4.1 S1：跨机差异比对的第一步）
// ---------------------------------------------------------------------------
// 用途：把本机账本的某一层导出成 JSONL，供跨机比对（S1）与跨机合并（S2）。
//
// 为什么复用 src/export-import.mjs：
//   `exportJsonl` / `importJsonl` 是既有实现（同格式、导入幂等、坏行不中断）。
//   自己再造一套格式 = 多一份会漂移的契约。这里只加一层 CLI。
//
// 边界（协议 docs/plans/sync-boundary-protocol-20260922.md §2）：
//   **默认只导 observation（L1）** —— L0 原始证据不出机（含真实原话）。
//   要导别的层必须显式 --stream，且自己承担隐私与体积后果。
//
// 只读性说明：
//   本脚本用 openEvidenceLedger 打开（会跑 PRAGMA journal_mode=WAL + schema 迁移，幂等）。
//   **严格要求零写入的场景请用 ledger-audit.mjs**（那是纯 readOnly 连接）。
//
// 用法：
//   node scripts/ledger-export.mjs --out D:/tmp/a-obs.jsonl
//   node scripts/ledger-export.mjs --dir <ledgerDir> --stream observation,rule --out <file>
//   缺省 --dir = $DSH_HOME/acp（回落 ~/.dsh/acp，见 src/home.mjs）
//
// 输出到 stdout 的是一份摘要（不打印正文）；--json 输出机器可读摘要。

import path from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { openEvidenceLedger } from '../src/store.mjs'
import { exportJsonl } from '../src/export-import.mjs'
import { resolveDshHome } from '../src/home.mjs'

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
    streams: (a.stream || 'observation').split(',').map((s) => s.trim()).filter(Boolean),
    out: a.out || '',
    json: a.json === '1' || a.json === 'true',
  }
}

/** 摘要：按 kind / claim_domain / authority / state 计数（不含正文） */
export function summarize(lines) {
  const byKind = {}, byDomain = {}, byAuthority = {}, byState = {}
  const bump = (m, k) => { const key = k || '(empty)'; m[key] = (m[key] || 0) + 1 }
  for (const line of lines) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    bump(byKind, o.kind)
    const d = o.data || {}
    bump(byDomain, d.claimDomain ?? d.claim_domain)
    bump(byAuthority, d.authority)
    bump(byState, d.state)
  }
  return { total: lines.length, byKind, byDomain, byAuthority, byState }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const text = exportJsonl({ ledger, streams: opts.streams })
    const lines = text.split(/\r?\n/).filter(Boolean)
    const summary = summarize(lines)
    summary.db = path.join(opts.dir, 'acp-ledger.db')
    summary.streams = opts.streams
    summary.out = opts.out || null
    if (opts.out) {
      mkdirSync(path.dirname(opts.out), { recursive: true })
      writeFileSync(opts.out, text, 'utf8')
    }
    if (opts.json) console.log(JSON.stringify(summary))
    else {
      console.log('=== ACP 导出 ===')
      console.log('库   : ' + summary.db)
      console.log('层   : ' + opts.streams.join(', '))
      console.log('条数 : ' + summary.total)
      if (opts.out) console.log('产物 : ' + opts.out)
      console.log('域分布   : ' + JSON.stringify(summary.byDomain))
      console.log('authority: ' + JSON.stringify(summary.byAuthority))
      console.log('state    : ' + JSON.stringify(summary.byState))
    }
  } finally {
    ledger.close?.()
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-export.mjs'))
})()
if (isMain) main()
