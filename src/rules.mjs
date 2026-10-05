// src/rules.mjs — 反馈通道规则视图渲染（T4 M4.1）。
// 铁律对齐 ACP 核心原则：Evidence is truth; views are rebuildable——
// rule 表（ledger 侧）是真相，~/.dsh/rules/<domain>.md 是人类可读视图，可从 ledger 重建。
// 本模块只做纯函数渲染（零 I/O、零依赖）；写文件/重建编排由调用方（rebuild 扩展）负责。

/** 生成单个规则域的 markdown 视图（frontmatter 头 + active/superseded 分节）。 */
export function renderRulesView(rows, opts = {}) {
  const updatedAt = opts.updatedAt ?? new Date().toISOString()
  const domain = opts.domain ?? (rows[0]?.domain ?? '')
  const active = (rows ?? []).filter((r) => r.state === 'active')
  const superseded = (rows ?? []).filter((r) => r.state === 'superseded')
  const other = (rows ?? []).filter((r) => r.state !== 'active' && r.state !== 'superseded')
  const lines = []
  lines.push('---')
  lines.push('kind: acp-rules')
  lines.push('domain: ' + domain)
  lines.push('updated_at: ' + updatedAt)
  lines.push('count: ' + (rows ?? []).length)
  lines.push('note: 本文件由 ACP ledger 生成（视图可重建），勿手改——改规则请走审批/工具')
  lines.push('---')
  lines.push('')
  lines.push('# 规则：' + domain)
  lines.push('')
  lines.push('## active（生效）')
  if (active.length === 0) lines.push('_（无）_')
  for (const r of active) pushRule(lines, r)
  lines.push('')
  lines.push('## superseded / rejected（历史）')
  if (superseded.length === 0 && other.length === 0) lines.push('_（无）_')
  for (const r of superseded) pushRule(lines, r)
  for (const r of other) pushRule(lines, r)
  return lines.join('\n') + '\n'
}

function pushRule(lines, r) {
  lines.push('')
  lines.push('- **[' + r.state + '] ' + r.title + '**  id=' + r.id)
  const meta = []
  if (r.gates && r.gates.length > 0) meta.push('gates: ' + r.gates.join(','))
  if (r.evidenceIds && r.evidenceIds.length > 0) meta.push('evidence: ' + r.evidenceIds.join(','))
  if (r.supersedes) meta.push('supersedes: ' + r.supersedes)
  if (r.activeFrom) meta.push('since: ' + new Date(r.activeFrom).toISOString().slice(0, 10))
  if (r.activeUntil) meta.push('until: ' + new Date(r.activeUntil).toISOString().slice(0, 10))
  if (meta.length > 0) lines.push('  ' + meta.join(' · '))
  lines.push('  > ' + String(r.text ?? '').replace(/\n/g, ' '))
}

/** 视图文件名（按域分文件） */
export function viewFileName(domain) {
  const safe = String(domain ?? '').trim().replace(/[^\w\u4e00-\u9fff-]/g, '_')
  return safe ? safe + '.md' : 'rules.md'
}

// ===================== 写盘编排（M4.1b，2026-09-07） =====================
// rules/ 目录 = 人类可读、git 版本化的视图（~/.dsh/rules/<domain>.md），
// 可从 ledger 全量重建（Evidence is truth; views are rebuildable）。
// 原子写（temp+rename）；陈旧清理只删 kind: acp-rules 标记的文件，不碰用户其他 md。
// **空域集守卫（2026-10-02 事故）**：域集为空时整个陈旧清理跳过——见 writeRulesDir 内注释。

import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 把规则视图落盘到 dir（按 domain 分文件）。
 * 1) 按 domain 分组（域排序稳定）→ renderRulesView 渲染
 * 2) 陈旧清理：目录内 kind: acp-rules 的 .md 若不在本次域集 → 删除（防残留失效域）
 *    —— **但域集为空时整个清理跳过**（2026-10-02 事故守卫，见函数内注释）
 * 3) 每文件原子写：<tmp> → rename
 * @param {object[]} rows - rule 行（通常 queryRules({state:'active'}).items）
 * @param {object} opts - { dir: string, logger?: {warn?: Function} }
 *   dir 必填（生产 = config.rulesDir ?? ~/.dsh/rules）；
 *   logger 可选，只在「域集为空 → 跳过清理」时用来打一条 warn（不传则静默跳过，跳过本身是安全方向）
 * @returns {{ok: boolean, dir: string, files: string[], domains: string[], removed: number,
 *   skippedStaleCleanup: boolean}} skippedStaleCleanup=true 表示本次因域集为空而未做任何删除
 */
export function writeRulesDir(rows, opts = {}) {
  const dir = String(opts.dir ?? '').trim()
  if (!dir) throw new TypeError('writeRulesDir requires opts.dir')
  mkdirSync(dir, { recursive: true })
  const byDomain = new Map()
  for (const r of rows ?? []) {
    const d = r?.domain ?? ''
    if (!d || !r?.text) continue
    if (!byDomain.has(d)) byDomain.set(d, [])
    byDomain.get(d).push(r)
  }
  const domains = [...byDomain.keys()].sort()
  const names = new Set(domains.map((d) => viewFileName(d)))
  let removed = 0
  // ---- 空域集守卫（2026-10-02 15:37 事故）----
  // 事故：一次域集为空的 apply()（未传 config.rulesDir → 回落 ~/.dsh/rules；此刻账本侧
  // 一条 active 规则都没读到）走到下面这个清理循环，把 ~/.dsh/rules 下的 security.md /
  // workflow.md 等真视图全当「陈旧域」删了（事后从账本重建）。
  // 根因：清理循环的前提是「域集 = 本次的全部有效域，其余皆陈旧」。域集为空时这个前提
  // 不成立——空域集既可能是「域真的全失效了」，也可能只是「这一次没读到域」（装配时序、
  // 账本未打开、查询为空……）。两种情况在目录侧长得一模一样，无法区分；而误删是不可逆的。
  // 抉择：域集为空 → 一个都不删，只 warn。宁可留下一个失效域的视图（可从账本重建、可手删，
  // 且下一次带非空域集的刷新会正常把它收走），也不冒删光真规则的风险。
  // 域集非空时行为完全不变：下面的清理循环原样保留。
  let skippedStaleCleanup = false
  if (domains.length === 0) {
    skippedStaleCleanup = true
    const kept = readdirSync(dir).filter((f) => f.endsWith('.md')).length
    const msg = '[acp] rules view: 域集为空，跳过清理以防误删 dir=' + dir
      + (kept > 0 ? ' kept_md=' + kept : '')
    try { opts.logger?.warn?.(msg) } catch { /* 日志失败不影响写盘 */ }
  } else {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || names.has(f)) continue
      const p = path.join(dir, f)
      try {
        const head = readFileSync(p, 'utf8').slice(0, 120)
        if (head.includes('kind: acp-rules')) {
          rmSync(p)
          removed += 1
        }
      } catch { /* 读取失败不动（可能正被占用） */ }
    }
  }
  const now = new Date().toISOString()
  const written = []
  for (const d of domains) {
    const name = viewFileName(d)
    const content = renderRulesView(byDomain.get(d), { domain: d, updatedAt: now })
    const tmp = path.join(dir, '.' + name + '.' + randomUUID() + '.tmp')
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path.join(dir, name))
    written.push(name)
  }
  return { ok: true, dir, files: written.sort(), domains, removed, skippedStaleCleanup }
}

export default { renderRulesView, viewFileName, writeRulesDir }
