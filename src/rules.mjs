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

export default { renderRulesView, viewFileName }
