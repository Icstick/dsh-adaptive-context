// scripts/ledger-quarantine-cascade.mjs — 隔离级联（P1-4.1 补丁，2026-09-24）
// ---------------------------------------------------------------------------
// 问题（docs/ops/acp-ingest-cascade-20260924.md）：隔离只改 evidence.state ——
// observation 不看证据状态、Profile 也不看，于是「已隔离」≠「已止血」。
// 实测：1669 条 evidence 处于 quarantined/redacted，101 条 active observation 仍引用它们，
// 其中 **54 条的全部证据都已隔离**，28 条已进 Profile 注入。
//
// 判据（三条同时满足才级联；**故意保守** —— 宁可漏清，不可误杀画像）：
//   1. 该 observation 的**全部** evidence 都处于 quarantined / redacted；
//   2. 其文本属「可客观判定为过程噪声」的一类：
//      a. 审批策略变更陈述 —— 同一件事的十几种措辞、且互相矛盾（ask↔never 反复）；
//         当前值由 settings.yaml 的 permission 键权威表达，画像记它没有增量信息
//      b. 放行闸门判为 english（英文残留）且非 pass
//      c. 放行闸门判为 ephemeral（会话临时态）且非 pass
//   3. 不做「按相似度聚类」那类启发式 —— 那会需要人为阈值，本脚本只做可解释的判定。
//
// 为什么**不**用「源证据全隔离」单条件：54 条里混着真画像
// （例：「中文用户，妹妹，跨多个 DSH 项目工作，有御影澪姐姐人设」「百合、巨大娘×缩小体型差、足部恋物内容」）
// —— 它们的源证据是 context-maid 归档之类「被隔离的载体」，结论本身是对的。
//
// 用法：
//   node scripts/ledger-quarantine-cascade.mjs [--dir <ledgerDir>] [--apply]
//   缺省 dry-run；--apply 时会先 cp 备份库文件，并写 cascade-<ts>.json（回滚依据）

import path from 'node:path'
import { copyFileSync, writeFileSync } from 'node:fs'
import { openEvidenceLedger } from '../src/store.mjs'
import { resolveDshHome } from '../src/home.mjs'
import { gateVerdict } from '../src/release-gate.mjs'

/** 审批策略的「变更陈述」：必须**同时**含策略词与变更动词。
 *  只匹配「审批策略」会把「用户要求审批策略保持询问」这类**真偏好**一起误伤 —— 那是要留的。 */
export const APPROVAL_SUBJECT_RE = /审批策略|approval policy/i
export const APPROVAL_CHANGE_RE = /改为|改成|changed|set to/i

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  return { dir: a.dir || path.join(resolveDshHome(), 'acp'), apply: a.apply === '1' || a.apply === 'true' }
}

const parseIds = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
const isBadEvidenceState = (st) => st === 'quarantined' || st === 'redacted'

/**
 * 判定一条 observation 是否该级联。纯函数（便于测试与重放）。
 * @param {{id:string, subject:string, text:string, evidence_ids:string, claim_domain:string}} o
 * @param {Map<string,string>} evState - evidenceId → state
 * @returns {string|null} 命中的理由码，null = 不动
 */
export function cascadeReason(o, evState) {
  const ids = parseIds(o.evidence_ids)
  if (ids.length === 0) return null
  if (!ids.every((id) => isBadEvidenceState(evState.get(id)))) return null
  const text = String(o.text ?? '')
  if (APPROVAL_SUBJECT_RE.test(text) && APPROVAL_CHANGE_RE.test(text)) return 'approval-duplicate'
  const g = gateVerdict({ subject: o.subject ?? '', text })
  if (g.class === 'english' && g.decision !== 'pass') return 'english-residue'
  if (g.class === 'ephemeral' && g.decision !== 'pass') return 'ephemeral'
  return null
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const dbPath = path.join(opts.dir, 'acp-ledger.db')
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const evState = new Map(ledger.db.prepare('SELECT id, state FROM evidence').all().map((r) => [r.id, r.state]))
    const rows = ledger.db.prepare("SELECT id, subject, text, evidence_ids, claim_domain FROM observation WHERE state='active'").all()
    const hits = []
    for (const o of rows) {
      const why = cascadeReason(o, evState)
      if (why) hits.push({ id: o.id, why, domain: o.claim_domain, text: String(o.text).slice(0, 70) })
    }
    const byReason = {}
    for (const h of hits) byReason[h.why] = (byReason[h.why] ?? 0) + 1
    const out = { mode: opts.apply ? 'APPLY' : 'DRY-RUN', db: dbPath, candidates: hits.length, byReason, sample: hits.slice(0, 8) }
    if (opts.apply) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const bak = dbPath + '.bak-' + stamp + '-cascade'
      copyFileSync(dbPath, bak)
      const stmt = ledger.db.prepare("UPDATE observation SET state = 'quarantined' WHERE id = ? AND state = 'active'")
      let n = 0
      for (const h of hits) n += Number(stmt.run(h.id).changes)
      const listFile = path.join(opts.dir, 'cascade-' + stamp + '.json')
      writeFileSync(listFile, JSON.stringify({ appliedAt: new Date().toISOString(), reason: 'isolation-cascade', ids: hits.map((h) => h.id), detail: hits }, null, 1), 'utf8')
      out.cascaded = n
      out.backup = bak
      out.rollbackList = listFile
    }
    console.log(JSON.stringify(out, null, 1))
  } finally {
    ledger.close?.()
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-quarantine-cascade.mjs'))
})()
if (isMain) main()
