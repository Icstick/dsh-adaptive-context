// scripts/candidate-export.mjs — ACP 侧「候选只读导出」（4.3 · ACP-B18）
// ---------------------------------------------------------------------------
// 绑定设计：docs/plans/sync-boundary-protocol-20260922.md §7（工作区文档）
//   导出=ACP（本脚本，只读）→ 传输=weaver 通道 → 写入=WC（唯一写者，写 next_steps）→ 回流=不做
//   理由：work 服务只有整份 upsert，ACP 若直写就得 read-modify-write，与 /checkpoint、todo 自动捕获、
//         work_state 工具三方并发写，撞 WC 单写者铁律。
//
// 三条纪律：
//   1. **只读**：绝不写 ACP 侧任何数据（不 transition、不写 candidate_events、不建表）；
//   2. **只给 id 不给正文**：evidence 只导出 id 列表，绝不导出 evidence 正文（与 L0 永不跨机同一理由）；
//   3. **不新造语义**：hint 由既有字段拼装，不做摘要、不做生成。
//
// 用法：
//   node scripts/candidate-export.mjs [--dir <ledgerDir>] [--state proposed] [--out f.jsonl] [--json] [--limit N]
//   不给 --out 只打印预览（不落盘）。

import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'
import { openEvidenceLedger } from '../src/store.mjs'

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
    state: a.state || 'proposed',
    out: a.out || '',
    limit: Number(a.limit || 0) || 200,
    json: a.json === '1' || a.json === 'true',
  }
}

/** 候选行 → 导出记录（纯函数，可测）。字段全部来自既有数据；不生成、不摘要、不带正文。 */
export function toExportRecord(c) {
  const ev = Array.isArray(c.evidenceIds) ? c.evidenceIds.map(String) : []
  const state = c.state || 'proposed'
  return {
    id: c.id,
    domain: c.domain ?? null,
    state,
    evidenceIds: ev,
    evidenceCount: ev.length,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
    policy: c.policy ?? null,
    hint: '[acp:' + c.id + '] ' + (c.domain ?? '?') + ' · 证据 ' + ev.length + ' 条 · ' + state,
  }
}

export function buildExport(rows) {
  return (Array.isArray(rows) ? rows : []).map(toExportRecord)
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'candidate-export.mjs'))
})()

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) { console.error('[cand-export] 账本不存在: ' + file); process.exit(2) }
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const rows = ledger.candidateStore.listCandidates({ state: opts.state, limit: opts.limit })
    const records = buildExport(rows)
    if (opts.json) { console.log(JSON.stringify({ state: opts.state, count: records.length, records }, null, 2)); return }
    console.log('[cand-export] state=' + opts.state + '  导出 ' + records.length + ' 条（只读，未改动账本）')
    const jsonl = records.map((r) => JSON.stringify(r)).join(String.fromCharCode(10))
    if (opts.out) {
      writeFileSync(opts.out, jsonl + String.fromCharCode(10), 'utf8')
      console.log('[cand-export] 已写 ' + opts.out)
      console.log('[cand-export] 下一步（WC 侧，唯一写者）：按 hint 里的 [acp:<id>] 前缀判重后写入 next_steps')
    } else {
      console.log('--- 预览（给 --out <file> 才落盘）---')
      console.log(jsonl.slice(0, 1600) || '(无候选)')
    }
  } finally { ledger.close() }
}

if (isMain) main()
