// scripts/ledger-profile-doc.mjs — 从账本生成「人读画像」USER.md（M2 / P3 决策）
// ---------------------------------------------------------------------------
// P3（2026-09-24 定）：画像档位 = ④事件级保持 + ②补一份人读 USER.md，不做⑤。
// 两条并存、互不替代：
//   - 事件级（ACP 云信箱）喂的是**机器**：注入时按预算取，条条可回链到证据；
//   - 这份 USER.md 喂的是**人**：一屏能读完的稳定结论，用于新会话冷启动、跨机对照、人工审计。
//
// 数据源：本机账本的 active observation（只取画像域 user_fact / user_preference），
// 经 src/profile.mjs 的 buildProfile（CONTRACTS §4 五数组）现算 —— 不另建一套口径。
// work / style / experience / external_fact **不进画像**（分别归 work_state / expression / memory 段）。
//
// 用法：
//   node scripts/ledger-profile-doc.mjs --dir <ledgerDir> --out <USER.md> [--host <名>]
//   --dir 缺省 = $DSH_HOME/acp

import path from 'node:path'
import os from 'node:os'
import { writeFileSync } from 'node:fs'
import { openEvidenceLedger } from '../src/store.mjs'
import { buildProfile } from '../src/profile.mjs'
import { gateVerdict } from '../src/release-gate.mjs'
import { resolveDshHome } from '../src/home.mjs'

export const PROFILE_DOC_DOMAINS = Object.freeze(['user_fact', 'user_preference'])

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
    host: a.host || os.hostname(),
  }
}

/** 账本行（snake_case）→ buildProfile 要的 observation（camelCase）。纯函数，便于测试。 */
export function rowsToObservations(rows) {
  return (rows ?? []).map((r) => ({
    id: r.id,
    scopeId: r.scope_id ?? r.scopeId ?? 'user-global',
    subject: r.subject ?? '',
    predicate: r.predicate ?? '',
    claimDomain: r.claim_domain ?? r.claimDomain ?? '',
    authority: r.authority ?? 'single_observation',
    text: String(r.text ?? ''),
    evidenceIds: Array.isArray(r.evidenceIds)
      ? r.evidenceIds
      : (() => { try { return JSON.parse(r.evidence_ids ?? '[]') } catch { return [] } })(),
    observedAt: r.observed_at ?? r.observedAt ?? null,
  }))
}

const ARR_TITLES = Object.freeze({
  stableFacts: '稳定事实',
  preferences: '偏好',
  recentState: '近期状态',
  interactionPatterns: '交互习惯',
  inferredTraits: '推断特征',
})

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const CELL = (s) => norm(s).replace(/\|/g, '/')

/**
 * Profile → 人读 markdown。纯函数（同样输入必然同样输出，便于测试与重跑）。
 * @param {object} profile - buildProfile 的产物
 * @param {{host?:string, generatedAt?:string, source?:string, maxTextChars?:number}} [opts]
 * @returns {string}
 */
export function renderProfileDoc(profile, opts = {}) {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const host = opts.host ?? ''
  const maxChars = Number(opts.maxTextChars ?? 160)
  const L = []
  L.push('# USER.md — 人读用户画像')
  L.push('')
  L.push('<!-- 由 scripts/ledger-profile-doc.mjs 生成，不要手改：改的是账本，不是这份文件。 -->')
  L.push('')
  L.push('> **这是什么**：一屏能读完的稳定结论，喂给人 —— 新会话冷启动、跨机对照、人工审计。')
  L.push('> **机器侧不读它**：注入走 ACP 的事件级同步（P3 决策：④事件级保持 + ②这份人读档，两条并存）。')
  L.push('> **口径**：只含账本里 active 的 user_fact / user_preference；work / style / experience / external_fact 不进画像。')
  L.push('')
  L.push('- 生成时间：' + generatedAt)
  if (host) L.push('- 生成主机：' + host)
  if (opts.source) L.push('- 账本：' + opts.source)
  L.push('- 参与构建：**' + (profile?.sourceVersion ?? 0) + ' 条**（稳定事实 ' + (profile?.stableFacts?.length ?? 0) + ' · 偏好 ' + (profile?.preferences?.length ?? 0) + '）')
  L.push('')

  // 闸门自检（2026-09-24）：**本机蒸馏的行不走跨机放行闸门**，所以画像里会混进
  // 「今天先休息」「用户表示暂时没有其他需求」这类会话过程残留。这里复用同一套判据做自检：
  //   pass  → 进正文（稳定结论）
  //   soft  → 单列「待核」，人工确认后才当结论用
  //   hard  → 不进正文，只留计数与少量样本（让缺口可见，而不是悄悄消失）
  const useGate = opts.gate !== false
  const judge = (it) => (useGate
    ? gateVerdict({ subject: it.subject, text: it.text })
    : { decision: 'pass', class: null, tags: [] })

  for (const arr of ['stableFacts', 'preferences']) {
    const all = [...(profile?.[arr] ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || norm(a.text).localeCompare(norm(b.text)))
    const kept = [], soft = [], hard = []
    for (const it of all) {
      const v = judge(it)
      if (v.decision === 'pass') kept.push(it)
      else if (v.decision === 'soft_tag') soft.push({ it, v })
      else hard.push({ it, v })
    }
    L.push('## ' + ARR_TITLES[arr] + '（' + arr + '，正文 ' + kept.length + ' 条）')
    if (useGate && (soft.length || hard.length)) {
      L.push('')
      L.push('*闸门自检：另有待核 ' + soft.length + ' 条、被挡下 ' + hard.length + ' 条（见本节末）。*')
    }
    L.push('')
    if (kept.length === 0) {
      L.push('（空）')
      L.push('')
    }
    const groups = new Map()
    for (const it of kept) {
      const g = norm(it.subject) || '（未标注主语）'
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(it)
    }
    const ordered = [...groups.entries()].sort((a, b) => (b[1][0].weight ?? 0) - (a[1][0].weight ?? 0) || a[0].localeCompare(b[0]))
    for (const [g, list] of ordered) {
      L.push('### ' + g + (list.length > 1 ? '（' + list.length + '）' : ''))
      for (const it of list) {
        const t0 = norm(it.text)
        const t = t0.length > maxChars ? t0.slice(0, maxChars) + '…' : t0
        const bits = []
        if (it.predicate) bits.push(CELL(it.predicate))
        bits.push('权重 ' + (it.weight ?? 0).toFixed(2))
        bits.push('id ' + String(it.observationId ?? '').slice(0, 10))
        if (it.observedAt) bits.push(String(it.observedAt).slice(0, 10))
        L.push('- ' + t + '　*(' + bits.join(' · ') + ')*')
      }
      L.push('')
    }
    if (soft.length) {
      L.push('### 待核（' + soft.length + ' 条 · 闸门判 soft_tag）')
      L.push('')
      L.push('> 这些**可能是**稳定结论，但判据上存疑（会话临时态 / 环境绑定 / 时效断言）。人工确认后再上移。')
      L.push('')
      for (const { it, v } of soft) {
        const t0 = norm(it.text)
        L.push('- ' + (t0.length > maxChars ? t0.slice(0, maxChars) + '…' : t0) + '　*(' + (v.class ?? '?') + (v.tags?.length ? ' · ' + v.tags.join(',') : '') + ' · id ' + String(it.observationId ?? '').slice(0, 10) + ')*')
      }
      L.push('')
    }
    if (hard.length) {
      L.push('### 已由闸门挡下（' + hard.length + ' 条 · 不进正文）')
      L.push('')
      for (const { it, v } of hard.slice(0, 3)) {
        const t0 = norm(it.text)
        L.push('- ' + (t0.length > 80 ? t0.slice(0, 80) + '…' : t0) + '　*(' + (v.class ?? '?') + ' · id ' + String(it.observationId ?? '').slice(0, 10) + ')*')
      }
      if (hard.length > 3) L.push('- …另 ' + (hard.length - 3) + ' 条同因被挡')
      L.push('')
      L.push('> 挡下的都是英文残留 / 会话临时态 / 环境绑定一类。**它们仍在账本里**（不删），只是不当画像结论用。')
      L.push('')
    }
  }
  return L.join('\n')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const ph = PROFILE_DOC_DOMAINS.map(() => '?').join(',')
    const rows = ledger.db.prepare(
      "SELECT id, scope_id, subject, predicate, claim_domain, authority, text, evidence_ids, observed_at " +
      "FROM observation WHERE state = 'active' AND claim_domain IN (" + ph + ") ORDER BY observed_at",
    ).all(...PROFILE_DOC_DOMAINS)
    const profile = buildProfile(rowsToObservations(rows), { scopeId: 'user-global', generatedAt: new Date().toISOString() })
    const doc = renderProfileDoc(profile, { host: opts.host, generatedAt: new Date().toISOString(), source: path.join(opts.dir, 'acp-ledger.db') })
    if (opts.out) {
      writeFileSync(opts.out, doc, 'utf8')
      console.log(JSON.stringify({ wrote: opts.out, bytes: Buffer.byteLength(doc, 'utf8'), lines: doc.split('\n').length, stableFacts: profile.stableFacts.length, preferences: profile.preferences.length }, null, 1))
    } else {
      process.stdout.write(doc)
    }
  } finally {
    ledger.close?.()
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'ledger-profile-doc.mjs'))
})()
if (isMain) main()
