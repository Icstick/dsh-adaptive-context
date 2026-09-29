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
import { attachQuotes, planSedimentation } from '../src/chapter.mjs'
import { planArchival } from '../src/dream.mjs'

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
  const ch = opts.chapter
  if (ch) {
    L.push('## 原话核对（user-line-gate）')
    L.push('')
    L.push('> 判据出自 Herta：**用户台词必须是真实消息的连续引用**，不许把转述当原话。')
    L.push('> 这一节不判真假，只标「这条引了多少原话、本机能核到什么程度」。**核不到 ≠ 伪造** ——')
    L.push('> 外机导入的条目按设计不带回链（src/backlink.mjs 的分层判据）。')
    L.push('')
    const qs = ch.quotes ?? []
    const withQ = qs.filter((x) => (x.quotes ?? []).length > 0)
    // 三类分开：只有第二类是真异常 —— 有回链，却对不上自己引的那句。
    const rows3 = { ok: [], foreign: [], mismatch: [] }
    for (const x of withQ) {
      const anyOk = x.quotes.some((q) => q.supported)
      if (anyOk) rows3.ok.push(x)
      else if ((x.evidenceCount ?? 0) === 0) rows3.foreign.push(x)
      else rows3.mismatch.push(x)
    }
    L.push('- 有引文的条目 **' + withQ.length + '** / 参与核对 ' + qs.length + '（纯转述 ' + (qs.length - withQ.length) + ' 条）')
    L.push('- 逐字可核 ' + rows3.ok.length + ' · 外机导入（本机无证据，按设计）' + rows3.foreign.length + ' · **有回链却对不上 ' + rows3.mismatch.length + '**')
    if (rows3.mismatch.length) {
      L.push('')
      L.push('### ⚠️ 引文对不上（本机有证据，但证据里没有这句话）')
      L.push('')
      for (const x of rows3.mismatch.slice(0, 8)) {
        for (const q of x.quotes.filter((q) => !q.supported)) L.push('- 「' + norm(q.text).slice(0, 80) + '」　*(id ' + String(x.id).slice(0, 10) + ' · 证据 ' + String(x.evidenceCount) + ' 条)*')
      }
    }
    if (rows3.ok.length) {
      L.push('')
      for (const x of rows3.ok.slice(0, 5)) for (const q of x.quotes.filter((q) => q.supported)) L.push('- ✅ 逐字可核：「' + norm(q.text).slice(0, 80) + '」　*(id ' + String(x.id).slice(0, 10) + ')*')
    }
    L.push('')
    L.push('## 冷存前的沉淀检查（遗忘前先落笔）')
    L.push('')
    L.push('> 条目会被 dream 归档。归档**不删数据**，但它会从这份画像里消失。')
    L.push('> 这一节列的是「即将冷存、而画像里还没有它」的用户域结论 —— **先沉淀，再冷存**。')
    L.push('')
    const sed = ch.sedimentation
    if (sed) {
      L.push('- 即将冷存 ' + sed.checked + ' 条；画像未覆盖 **' + sed.missing.length + '** 条')
      for (const m of sed.missing.slice(0, 10)) L.push('  - 〔' + m.claimDomain + '〕' + norm(m.text).slice(0, 100) + '　*(id ' + String(m.id).slice(0, 10) + ')*')
      if ((sed.missing ?? []).length === 0) L.push('- 没有缺口：要冷存的都已在画像里。')
    }
    L.push('')
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
    // ── chapter：原话核对 + 冷存前沉淀检查（2026-09-29，对应 WP3 剩下两条）──
    const evById = new Map(ledger.db.prepare('SELECT id, content FROM evidence').all().map((e) => [e.id, { content: e.content ?? '' }]))
    const allObs = ledger.db.prepare('SELECT id, text, claim_domain, state, created_at, evidence_ids FROM observation').all()
      .map((r) => ({
        id: r.id,
        text: String(r.text ?? ''),
        claimDomain: r.claim_domain,
        state: r.state,
        createdAt: Number(r.created_at ?? 0),
        evidenceIds: (() => { try { return JSON.parse(r.evidence_ids ?? '[]') } catch { return [] } })(),
      }))
    const bodyEntries = [...(profile?.stableFacts ?? []), ...(profile?.preferences ?? [])]
      .map((it) => ({ id: it.observationId ?? it.id ?? '', text: it.text ?? '', evidenceIds: it.evidenceIds ?? [] }))
    const archival = planArchival({
      observations: allObs.map((o) => ({ id: o.id, state: o.state, createdAt: o.createdAt })),
      evidence: ledger.db.prepare('SELECT id, state, updated_at FROM evidence').all()
        .map((e) => ({ id: e.id, state: e.state, updatedAt: Number(e.updated_at ?? 0) })),
    })
    const chapter = {
      quotes: attachQuotes(bodyEntries, evById),
      sedimentation: planSedimentation({
        observations: allObs,
        archivalIds: archival.observations,
        representedTexts: bodyEntries.map((x) => x.text),
      }),
      archivalStats: archival.stats,
    }
    const doc = renderProfileDoc(profile, { host: opts.host, generatedAt: new Date().toISOString(), source: path.join(opts.dir, 'acp-ledger.db'), chapter })
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
