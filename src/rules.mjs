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

import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 把规则视图落盘到 dir（按 domain 分文件）。
 * 1) 按 domain 分组（域排序稳定）→ renderRulesView 渲染
 * 2) 陈旧清理：目录内 kind: acp-rules 的 .md 若不在本次域集 → 删除（防残留失效域）
 * 3) 每文件原子写：<tmp> → rename
 * @param {object[]} rows - rule 行（通常 queryRules({state:'active'}).items）
 * @param {object} opts - { dir: string }（必填；生产 = config.rulesDir ?? ~/.dsh/rules）
 * @returns {{ok: boolean, dir: string, files: string[], domains: string[], removed: number}}
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
  return { ok: true, dir, files: written.sort(), domains, removed }
}

export default { renderRulesView, viewFileName, writeRulesDir }
