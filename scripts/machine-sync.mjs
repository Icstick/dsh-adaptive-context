// scripts/machine-sync.mjs — 单机接续：把本机对齐到仓库当前版本（2026-09-22）
// ---------------------------------------------------------------------------
// 背景：ACP 的**代码**在 GitHub 上（git pull 即可），但每个机器还有三件**本机动作**
//   ① profile 配置：MemOS 摘除（disabled + recallProviders: []）
//   ② weaver 全库转 WAL（kb-to-wal.mjs 早期写死过 A 机路径，只对当时那台机器生效）
//   ③ 重启 dsh 让新代码生效（**本脚本不做**——会杀掉当前会话）
// 本脚本把 ①② 做成幂等的一步，③ 只提示。
//
// 纪律：
//   - **默认 dry-run**：不给 --apply 只打印将要做什么。
//   - 改配置前**自动备份**（<file>.bak-<ts>-machine-sync）。
//   - **只做加法**：只插入缺失的行，绝不改写/删除既有内容。
//   - **不碰账本数据**：存量隔离、候选池落库等都是**每机不同**的本地数据，脚本一律不代劳。
//
// 用法：
//   cd <repo> && git pull
//   node scripts/machine-sync.mjs              # 预演
//   node scripts/machine-sync.mjs --apply      # 执行 ①②
//   node scripts/machine-sync.mjs --verify     # 只读自检（随时可跑）
//   --home <dir>  覆盖 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
//   --json        机器可读

import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'

export const SYNC_MARKER = 'machine-sync'

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  return {
    home: a.home || resolveDshHome(),
    apply: a.apply === '1' || a.apply === 'true',
    verify: a.verify === '1' || a.verify === 'true',
    json: a.json === '1' || a.json === 'true',
  }
}

/** 在一个 `- id: <id>` entry 里，确保紧随其后有 `  disabled: true`（幂等、只插入） */
export function ensureDisabled(text, id) {
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((l) => l.trim() === '- id: ' + id)
  if (idx < 0) return { changed: false, reason: 'entry 不存在' }
  let j = idx + 1
  const end = (() => { for (let i = idx + 1; i < lines.length; i += 1) if (lines[i].startsWith('- id:')) return i; return lines.length })()
  const hasIt = lines.slice(j, end).some((l) => /^\s+disabled:\s*true\s*$/.test(l))
  if (hasIt) return { changed: false, reason: '已是 disabled: true' }
  lines.splice(idx + 1, 0, '  disabled: true')
  return { changed: true, text: lines.join('\n') }
}

/** 在 `- id: adaptive-context` 的 config 块里，确保有 `    recallProviders: []`（幂等、只插入） */
export function ensureRecallProviders(text) {
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((l) => l.trim() === '- id: adaptive-context')
  if (idx < 0) return { changed: false, reason: 'entry 不存在' }
  const end = (() => { for (let i = idx + 1; i < lines.length; i += 1) if (lines[i].startsWith('- id:')) return i; return lines.length })()
  const block = lines.slice(idx, end)
  if (!block.some((l) => /^\s+config:\s*$/.test(l))) return { changed: false, reason: '该 entry 没有 config 块（跳过，人工确认）' }
  if (block.some((l) => /^\s+recallProviders:/.test(l))) return { changed: false, reason: '已设置 recallProviders' }
  let ins = end
  while (ins > idx && !lines[ins - 1].trim()) ins -= 1
  lines.splice(ins, 0, '    recallProviders: []')
  return { changed: true, text: lines.join('\n') }
}

/** 找出所有含 adaptive-context entry 的 cordis.patch.yml */
export function findProfilePatches(home) {
  const root = path.join(home, 'profiles')
  if (!existsSync(root)) return []
  const out = []
  for (const d of readdirSync(root)) {
    const f = path.join(root, d, 'cordis.patch.yml')
    if (!existsSync(f)) continue
    const t = readFileSync(f, 'utf8')
    if (t.includes('- id: adaptive-context')) out.push({ profile: d, file: f, text: t })
  }
  return out
}

/** 探测一块 SQLite 库的 journal_mode（只读；不依赖 openEvidenceLedger） */
export async function probeJournalModes(dbDir, libs) {
  const { DatabaseSync } = await import('node:sqlite')
  const out = []
  if (!existsSync(dbDir)) return out
  for (const lib of libs) {
    const f = path.join(dbDir, lib + '.db')
    if (!existsSync(f)) continue
    try {
      const d = new DatabaseSync(f, { readOnly: true })
      const m = String(d.prepare('PRAGMA journal_mode').get().journal_mode)
      d.close()
      out.push({ lib, mode: m })
    } catch (err) { out.push({ lib, mode: 'ERR:' + (err && err.message ? err.message.slice(0, 30) : '?') }) }
  }
  return out
}

export function gitVersion(cwd) {
  try { return execFileSync('git', ['log', '-1', '--oneline'], { cwd, encoding: 'utf8' }).trim() } catch { return '(git 不可用)' }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'machine-sync.mjs'))
})()

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const L = []
  const checks = []
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  L.push('=== machine-sync ===')
  L.push('DSH_HOME : ' + opts.home)
  L.push('仓库版本 : ' + gitVersion(repo))
  L.push('模式     : ' + (opts.apply ? 'APPLY' : 'DRY-RUN'))
  L.push('')

  // ---- ① profile 配置 ----
  L.push('[① profile 配置：MemOS 摘除]')
  const patches = findProfilePatches(opts.home)
  if (patches.length === 0) L.push('  （未找到含 adaptive-context 的 cordis.patch.yml，跳过）')
  for (const p of patches) {
    const d1 = ensureDisabled(p.text, 'memos-local-memory')
    const d2 = ensureRecallProviders(d1.text ?? p.text)
    L.push('  ' + path.join('profiles', p.profile, 'cordis.patch.yml'))
    L.push('    memos-local-memory disabled : ' + (d1.changed ? '需插入' : d1.reason))
    L.push('    recallProviders: []         : ' + (d2.changed ? '需插入' : d2.reason))
    const memosOk = !d1.changed && d1.reason.includes('已是')
    if (p.profile === 'web') {
      checks.push({ name: 'profile/' + p.profile + ' MemOS 摘除', ok: memosOk && !d2.changed, detail: (d1.changed ? '缺 disabled' : '') + (d2.changed ? ' 缺 recallProviders' : '') })
    }
    if (opts.apply && (d1.changed || d2.changed)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const bak = p.file + '.bak-' + stamp + '-' + SYNC_MARKER
      copyFileSync(p.file, bak)
      writeFileSync(p.file, d2.text ?? d1.text ?? p.text, 'utf8')
      L.push('    已写入（备份 ' + path.basename(bak) + '）')
    }
  }
  L.push('')

  // ---- ② weaver WAL ----
  L.push('[② weaver journal_mode]')
  const kbDir = path.join(opts.home, 'weaver-kb', 'db')
  const libs = ['lore','project','hardware','software-code','software-config','web','work-skill','workflow','verbatim']
  const modes = await probeJournalModes(kbDir, libs)
  const nonWal = modes.filter((m) => m.mode !== 'wal')
  if (modes.length === 0) L.push('  （未找到 weaver-kb/db，跳过）')
  else {
    L.push('  ' + modes.length + ' 个库，wal ' + (modes.length - nonWal.length) + ' · 非 wal ' + nonWal.length)
    for (const m of nonWal) L.push('    ! ' + m.lib + ' = ' + m.mode)
    if (nonWal.length) {
      L.push('  → 需转 WAL：node <DSH_WORKSPACE>/.tooling/scripts/kb-to-wal.mjs')
      L.push('     （本脚本不代跑：它会写 11 个库的 header，请单独执行并复查）')
    }
    checks.push({ name: 'weaver journal_mode 全 wal', ok: nonWal.length === 0, detail: nonWal.length ? nonWal.map((m) => m.lib + '=' + m.mode).join(',') : '' })
  }
  L.push('')

  // ---- ③ 账本 schema（只读）----
  L.push('[③ 账本 schema（只读探测）]')
  const ledger = path.join(opts.home, 'acp', DEFAULT_DB_NAME)
  if (!existsSync(ledger)) L.push('  （本机还没有账本，首次启动 dsh 时自动创建）')
  else {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const d = new DatabaseSync(ledger, { readOnly: true })
      const v = d.prepare("SELECT value v FROM acp_meta WHERE key='schema_version'").get()
      const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('candidate_memory','dream_run')").all().map((r) => r.name)
      L.push('  schema_version = ' + (v ? v.v : '(无)') + '   期望 7')
      L.push('  v7 新表: ' + (tables.length ? tables.join(', ') : '(缺——重启 dsh 后自动建)'))
      d.close()
      checks.push({ name: '账本 schema v7', ok: v && Number(v.v) === 7 && tables.length === 2, detail: 'db=' + (v ? v.v : '-') + ' tables=' + tables.length })
    } catch (err) {
      L.push('  探测失败：' + (err && err.message ? err.message : err))
      checks.push({ name: '账本 schema v7', ok: false, detail: '探测失败' })
    }
  }
  L.push('')
  // ---- --verify：只打印判定 + 退出码（供重启后自检 / 计划任务调用）----
  if (opts.verify) {
    const V = []
    V.push('=== machine-sync --verify ===')
    V.push('仓库版本 : ' + gitVersion(repo))
    let bad = 0
    for (const c of checks) {
      if (!c.ok) bad += 1
      V.push('  ' + (c.ok ? '[PASS]' : '[FAIL]') + ' ' + c.name + (c.ok || !c.detail ? '' : '  (' + c.detail + ')'))
    }
    V.push('')
    V.push(bad === 0 ? '全部通过。' : (bad + ' 项未通过——见上。'))
    V.push('注：注入面是否已换血（[acp:user_input] 行归零）要在会话里肉眼看，脚本看不到。')
    console.log(V.join('\n'))
    process.exitCode = bad === 0 ? 0 : 1
    return
  }

  L.push('[下一步]')
  L.push('  重启 dsh —— 新代码与配置都要重启才生效（本脚本不代做，会杀掉当前会话）')
  L.push('  重启后跑：node scripts/machine-sync.mjs --verify')
  console.log(L.join('\n'))
}

if (isMain) main().catch((err) => { console.error('[machine-sync] ' + (err && err.message ? err.message : err)); process.exit(1) })
