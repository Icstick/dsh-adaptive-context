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

/**
 * 「进度快照」形态（ACP-B19，2026-09-24）。
 * 实测：consensus 51 条里可导出 5 条，其中 4 条是「进度快照 / 状态通报」——例如
 * 「当前在 dsh-desktop-shell 的某分支上先做提交…」「已读完三份报告…正复现…」。
 * 根因：Dreaming 按**复现次数**聚合，而「当前在做 X」天然会反复出现（每次压缩/交接都重提一次），
 * 于是复现次数很高、内容却是一次性的。**复现次数 != 价值**。
 *
 * 处置：**降权而不挡下**（只标注 + 降 confidence）—— 判据宁可漏也不要误杀：
 * 「已确认 X 只解第一帧」这类以「已」开头的**真知识**不能被牵连，所以只认「第一人称进行时」这一种最明确的形态。
 */
export const EPHEMERAL_PATTERNS = Object.freeze([
  /^(当前|目前|现在)(在|正在|已经|已)/,
  /^(正在|刚|刚刚)(做|跑|读|改|写|复现|排查|处理|提交)/,
  /^(已|刚)(读完|看了|完成|跑完|复现)/,
  // 2026-09-25（ACP-B19 补）：同一形态的常见变体。**只认「动作进行」**——
  // 刻意不认「已确认/已验证/已发现/已定位」这类「认知动词」，那些是真知识。宁可漏，不要误杀。
  /^(我|我们)正(在)?(做|跑|读|改|写|复现|排查|处理|提交|看|试|核对|整理|梳理|对齐|检查|验证|确认|收口|接手|推进|测)/,
  /^(进度|进展|状态|当前状态)\s*[:：]/,
])

/** @returns {boolean} true = 像「进度快照」，导出时降权 */
export function looksEphemeral(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  return EPHEMERAL_PATTERNS.some((re) => re.test(t))
}


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
    cloudOut: a['cloud-out'] || '',
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
  let conf = c.occurrences >= 3 ? 0.9 : c.occurrences === 2 ? 0.8 : 0.7
  // ACP-B19：进度快照降权（不挡下）—— 标注 + 减 confidence，让人一眼看出该复核
  const ephemeral = looksEphemeral(text)
  if (ephemeral) conf = Math.max(0.5, Number((conf - 0.2).toFixed(2)))
  const rec = {
    title: deriveTitle(text, c.subject),
    summary: text.slice(0, 200),
    body: text + provenanceFooter(c),
    source: 'acp-dreaming:' + c.id,
    tags: ephemeral ? ['acp-dreaming', c.claimDomain, 'ephemeral'] : ['acp-dreaming', c.claimDomain],
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
    if (!EXPORTABLE_DOMAINS.includes(c.claimDomain)) {
      // 2026-09-24：原先 block 不带 reason，输出层用「画像域」兜底 → 把 experience 这类
      // 「只是不在白名单」的域误标成画像域（实测 46 条里大半是 experience）。这里把两种原因分开。
      const isProfile = BLOCKED_DOMAINS.includes(c.claimDomain)
      blocked.push({
        id: c.id,
        domain: c.claimDomain,
        reason: isProfile ? '画像域，永不出 ACP' : '不在导出白名单（仅 work / external_fact）',
      })
      continue
    }
    if ((c.evidenceIds ?? []).length === 0) { blocked.push({ id: c.id, domain: c.claimDomain, reason: '无证据回链' }); continue }
    records.push(toWeaverRecord(c, opts))
  }
  return { records, blocked }
}

/**
 * 候选 → **云端 staging 记录**（DREAMING §11 通道的入口格式，2026-09-24）。
 * 与 toWeaverRecord 的区别：那个是「给 wv import 的记录」，这个是「给云端接纳器的记录」。
 * 候选**还没有 lib** —— 那是精馏要决定的事，所以这里不猜、不填。
 */
export function toStagingRecord(c, rec) {
  return {
    schema: 'dsh.acp.candidate/v1',
    candId: c.id,
    // ★ 跨机复现的判据用 subject 而不是 candId（2026-09-24 修正）：
    //   candId = hash(scopeId|claimDomain|subject|observationIds)，而 observationIds 是**各机本地的**，
    //   所以同一件事在三机算出的是**不同的 id** —— 拿 id 比对永远算不出「跨机复现」。
    subject: c.subject ?? null,
    claimDomain: c.claimDomain ?? null,
    title: rec.title,
    summary: rec.summary,
    body: rec.body,
    source: rec.source,
    tags: rec.tags,
    confidence: rec.confidence,
    // 2026-09-25（DREAMING 收尾实测）：**必须输出 occurrences**——promote 的判据 B（本机复现 >= N）
    // 读的就是这个字段，此前没输出它 → staging 记录里没有该键 → occ 恒为 0、判据 B 永不成立。
    // sessions 出条数（不是数组）避免把各机会话 id 固化进 staging。
    occurrences: c.occurrences ?? 0,
    sessions: Array.isArray(c.sessions) ? c.sessions.length : (c.sessions ?? null),
    days: c.days ?? null,
  }
}

/** 组装 staging 文件正文：首行 manifest + 每行候选（与 wv-sync 的 inbound 同构，但走**独立通道**） */
export function toStagingPayload(records, deviceId, exportedAt) {
  const man = {
    schema: 'dsh.acp.staging/v1',
    deviceId: deviceId || 'unknown',
    exportedAt: exportedAt || new Date().toISOString(),
    count: records.length,
  }
  const NL = String.fromCharCode(10)
  return [JSON.stringify(man), ...records.map((r) => JSON.stringify(r))].join(NL) + NL
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
      console.log('  [挡下] ' + b.domain + '（' + (b.reason || '被挡下') + '）  ' + b.id)
    }
    console.log('  可导出 ' + records.length + ' 条，挡下 ' + blocked.length + ' 条')
    const jsonl = records.map((r) => JSON.stringify(r)).join('\n')
    if (opts.cloudOut) {
      // 用 source 反查候选：buildExport 会挡掉不合规的，索引与 res.items 并不一一对应
      const byId = new Map(res.items.map((x) => [x.id, x]))
      const staging = records.map((r) => {
        const id = String(r.source || '').replace('acp-dreaming:', '')
        return toStagingRecord(byId.get(id) || { id }, r)
      })
      writeFileSync(opts.cloudOut, toStagingPayload(staging, opts.deviceId || '', opts.exportedAt || ''), 'utf8')
      console.log('[export] 已写 staging 格式 ' + opts.cloudOut + '（' + staging.length + ' 条，供云端接纳器）')
      console.log('[export] 下一步：scp 到 <weaver>/inbound-acp/<slot>/ 后跑 wv-staging-accept.mjs')
    }
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
