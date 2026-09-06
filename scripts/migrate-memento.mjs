// scripts/migrate-memento.mjs — PLAN-S2 P5（§4）：memento → ACP 迁移管道。
//
// 三段式：dry-run（只读 memento.db 生成映射清单）→ backup（db 快照归档）→ run（写入 ACP ledger）。
// 幂等：evidenceIdOf(sourceRef, contentHash) 稳定派生 → 重跑 INSERT OR IGNORE 天然跳过已迁条目。
// 映射（PLAN-S2 §4.1 细化，2026-09-07 定稿）：
//   memento user track   → user_input / user_explicit；claimDomain 按内容启发
//                          （偏好/习惯/要求类关键词 → user_preference，一般 → user_fact）
//   memento agent track  → agent_authored / single_observation / experience
//                          （偏离 §4.1 表的 agent_self_evaluation：该值矩阵全 ✗，17 条工作记忆
//                            将全部进不了注入面 = 观察期退化；single_observation 可进 factual 域，
//                            忠实表达"agent 记录的一次观察"——对齐 §3.2「按内容判 authority」语义）
//   sessionId 不落 evidence.session_id 列（''）：迁移内容 = 已提炼画像/记忆（非原始会话消息），
//     F7 跨会话闸门按 sessionId 判——无会话属性 = 稳定内容轨；原 memento 会话 id 保留在
//     sourceRef.sourceSession 供追溯。
//   scope 原样保留（user-global / workspace）：注意 ACP 注入面当前固定 user-global
//     （scopeOf MVP 简化），workspace 层条目迁入后暂不进注入（数据保全；报告含统计）。
//   >500 字符条目按 500 切分（sourceRef.part/of 标注）。
// 审计：逐条 append 内置 audit（actor=system）+ 批次 op=import_memento（幂等：已存在
//   sourceRef.kind=memento 的成功批次记录则 skip）。
//
// 用法：
//   node scripts/migrate-memento.mjs dry-run [--memento-db P] [--json]
//   node scripts/migrate-memento.mjs backup  [--memento-db P] [--backup-dir D]
//   node scripts/migrate-memento.mjs run     [--memento-db P] [--ledger-dir L] [--backup-dir D]
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { writeGuard } from '../src/governance.mjs'
import { hashHex } from '../src/constants.mjs'

export const MAX_PART_CHARS = 500
export const MEMENTO_SOURCE_KIND = 'memento'

/** 偏好/习惯/要求类关键词（内容启发，user track 域分类用）——保守：命中才升 user_preference */
const PREFERENCE_MARKERS = [
  '偏好', '习惯', '喜欢', '希望', '要求', '明确', '反馈', '指示', '决定', '拍板',
  'preference', 'prefer', '要求', '不要写', '不要用', '尽量', '优先', '请',
  '不想', '讨厌', '推荐', '只写', '一律', '为主', '倾向', '务必', '风格', '界面', 'README',
]

/** user track 内容 → claimDomain：偏好类 → user_preference，一般 → user_fact */
export function classifyUserDomain(text) {
  const t = String(text ?? '')
  return PREFERENCE_MARKERS.some((m) => t.includes(m)) ? 'user_preference' : 'user_fact'
}

/** 按 MAX_PART_CHARS 切分（保留代理对完整；单段原样返回） */
export function splitLongText(text, max = MAX_PART_CHARS) {
  const s = String(text ?? '')
  if (s.length <= max) return [{ content: s, part: 1, of: 1 }]
  const parts = []
  for (let start = 0; start < s.length;) {
    let end = Math.min(start + max, s.length)
    // 防切开代理对：end 落在低代理位则回退 1
    const code = s.charCodeAt(end - 1)
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    parts.push({ content: s.slice(start, end), part: parts.length + 1 })
    start = end
  }
  return parts.map((p) => ({ ...p, of: parts.length }))
}

/** entry → 映射清单（一条 memento entry 可能切分为多条 evidence 候选） */
export function planMapping(entry) {
  const track = String(entry.track ?? '')
  const scope = String(entry.scope ?? 'user-global')
  const text = String(entry.text ?? '')
  const parts = splitLongText(text)
  if (track === 'user') {
    const domain = classifyUserDomain(text)
    return {
      entryId: String(entry.id),
      track: 'user',
      scope,
      sourceClass: 'user_input',
      authority: 'user_explicit',
      claimDomain: domain,
      confidence: 0.95,
      durability: 0.8,
      parts,
    }
  }
  // agent track（含未知 track 保守按 agent 处理）
  return {
    entryId: String(entry.id),
    track: 'agent',
    scope,
    sourceClass: 'agent_authored',
    authority: 'single_observation',
    claimDomain: 'experience',
    confidence: 0.75,
    durability: 0.5,
    parts,
  }
}

export function planMappings(entries) {
  return (entries ?? []).map((e) => planMapping(e)).filter((m) => m.parts.length > 0)
}

/** 幂等 sourceRef（part/of 使切分候选各自独立且稳定） */
export function sourceRefOf(mapping, partIdx) {
  const p = mapping.parts[partIdx]
  const ref = {
    kind: MEMENTO_SOURCE_KIND,
    id: mapping.entryId,
    track: mapping.track,
    scope: mapping.scope,
  }
  if (mapping.parts.length > 1) ref.part = p.part
  if (mapping.parts.length > 1) ref.of = p.of
  return ref
}

/** 读 memento entries（只读；按 track/scope 排序保证 dry-run/run 次序一致） */
export function readMementoEntries(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(
      'SELECT id, track, scope, text, session_id, agent_key, updated_at FROM entries ORDER BY track, scope, created_at',
    ).all()
    return rows.map((r) => ({
      id: r.id,
      track: r.track,
      scope: r.scope,
      text: r.text,
      sessionId: r.session_id ?? '',
      agentKey: r.agent_key ?? '',
      updatedAt: r.updated_at ? new Date(Number(r.updated_at)).toISOString() : new Date().toISOString(),
    }))
  } finally {
    db.close()
  }
}

/** dry-run：只读 + writeGuard 预检，不写任何库 */
export function dryRun(mementoDbPath) {
  const entries = readMementoEntries(mementoDbPath)
  const mappings = planMappings(entries)
  const list = []
  const stats = { entries: entries.length, mappings: 0, parts: 0, userParts: 0, agentParts: 0, over500: 0, blocked: 0, quarantine: 0 }
  for (const m of mappings) {
    stats.mappings += 1
    stats.parts += m.parts.length
    if (m.track === 'user') stats.userParts += m.parts.length
    else stats.agentParts += m.parts.length
    if (m.parts.length > 1) stats.over500 += 1
    for (let i = 0; i < m.parts.length; i++) {
      const guard = writeGuard({
        sourceClass: m.sourceClass,
        claimDomain: m.claimDomain,
        sensitivity: 'private',
        content: m.parts[i].content,
      })
      if (guard.decision === 'block') stats.blocked += 1
      else if (guard.decision === 'quarantine') stats.quarantine += 1
      list.push({
        entryId: m.entryId,
        track: m.track,
        scope: m.scope,
        part: m.parts[i].part,
        of: m.parts[i].of,
        sourceClass: m.sourceClass,
        authority: m.authority,
        claimDomain: m.claimDomain,
        chars: m.parts[i].content.length,
        guard: guard.decision,
        guardReasons: guard.reasons,
        head: m.parts[i].content.slice(0, 80),
      })
    }
  }
  return { stats, list, generatedAt: new Date().toISOString() }
}

/** 备份：WAL checkpoint 后复制 memory.db（+ wal/shm 残留），目录 mkdir -p */
export function backupMementoDb(mementoDbPath, backupDir) {
  if (!existsSync(mementoDbPath)) throw new Error('memento db not found: ' + mementoDbPath)
  mkdirSync(backupDir, { recursive: true })
  // checkpoint 尽量收 WAL（busy 时忽略——memento 插件持连接时可能拿不到写锁）
  let chk = null
  let conn = null
  try {
    conn = new DatabaseSync(mementoDbPath)
    chk = conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  } catch { /* checkpoint 失败不阻断备份 */ }
  try { conn?.close() } catch { /* ignore */ }
  const copied = []
  const base = path.basename(mementoDbPath)
  copyFileSync(mementoDbPath, path.join(backupDir, base))
  copied.push(base)
  for (const suffix of ['-wal', '-shm']) {
    const p = mementoDbPath + suffix
    if (existsSync(p)) {
      try {
        copyFileSync(p, path.join(backupDir, base + suffix))
        copied.push(base + suffix)
      } catch { /* WAL 竞争时忽略（checkpoint 后通常已无） */ }
    }
  }
  return { backupDir, files: copied, checkpoint: chk ? String(chk.busy ?? '?') : 'skipped' }
}

/** 对账：已入 ledger 的 memento 候选数（source_ref.kind=memento） */
export function countMigrated(ledger) {
  const r = ledger.db.prepare(
    "SELECT COUNT(*) c FROM evidence WHERE source_ref LIKE ?",
  ).get('%"kind":"' + MEMENTO_SOURCE_KIND + '"%')
  return Number(r.c)
}

/** 批次审计是否已记（幂等：成功批次只记一次） */
export function hasImportAudit(ledger) {
  const r = ledger.db.prepare(
    "SELECT COUNT(*) c FROM audit WHERE op = 'import_memento' AND reason = 'memento migration batch'",
  ).get()
  return Number(r.c) > 0
}

/** 执行迁移。返回报告 {total, inserted, skipped, blocked, quarantined, failed, reconciled} */
export function runMigration({ mementoDbPath, ledgerDir }) {
  if (!existsSync(mementoDbPath)) throw new Error('memento db not found: ' + mementoDbPath)
  const entries = readMementoEntries(mementoDbPath)
  const mappings = planMappings(entries)
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  const report = { totalParts: 0, inserted: 0, skipped: 0, blocked: [], quarantined: [], failed: [], evidenceIds: [] }
  try {
    for (const m of mappings) {
      for (let i = 0; i < m.parts.length; i++) {
        report.totalParts += 1
        const content = m.parts[i].content
        const sourceRef = sourceRefOf(m, i)
        const cand = {
          sourceClass: m.sourceClass,
          authority: m.authority,
          claimDomain: m.claimDomain,
          confidence: m.confidence,
          durability: m.durability,
          sensitivity: 'private',
          content,
          contentHash: hashHex(content),
          sourceRef,
          scopeId: m.scope === 'workspace' ? 'workspace' : 'user-global',
          sessionId: '', // 稳定内容轨：不落会话属性（F7 闸门按 sessionId 判）
          observedAt: entries.find((e) => e.id === m.entryId)?.updatedAt ?? new Date().toISOString(),
          agentKey: '',
          sessionType: 'root',
          metadata: { sourceVersion: 'memento-' + m.track + '-' + m.scope },
        }
        const guard = writeGuard(cand)
        if (guard.decision === 'block') {
          report.blocked.push({ entryId: m.entryId, reason: guard.reasons.join(';') })
          continue
        }
        const effective = {
          ...cand,
          state: guard.decision === 'quarantine' ? 'quarantined' : 'active',
        }
        try {
          const res = ledger.append(effective)
          if (res.inserted) { report.inserted += 1; report.evidenceIds.push(res.id) }
          else report.skipped += 1
          if (guard.decision === 'quarantine') report.quarantined.push({ entryId: m.entryId, id: res.id })
        } catch (err) {
          report.failed.push({ entryId: m.entryId, error: String((err && err.message) || err) })
        }
      }
    }
    // 批次审计（幂等）
    if (!hasImportAudit(ledger) && (report.inserted > 0 || report.blocked.length + report.quarantined.length + report.failed.length > 0)) {
      ledger.auditStore.appendAudit({
        op: 'import_memento',
        scopeId: 'user-global',
        actor: 'system',
        reason: 'memento migration batch',
        payload: {
          at: new Date().toISOString(),
          totalParts: report.totalParts,
          inserted: report.inserted,
          skipped: report.skipped,
          blocked: report.blocked.length,
          quarantined: report.quarantined.length,
          failed: report.failed.length,
        },
      })
    }
    report.reconciled = countMigrated(ledger)
    return report
  } finally {
    ledger.close()
  }
}

// ---- CLI ----
const USAGE = 'usage: node scripts/migrate-memento.mjs <dry-run|backup|run> [--memento-db P] [--ledger-dir L] [--backup-dir D] [--json]'
function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.slice(7))
if (isMain) {
  const argv = process.argv.slice(2)
  const mode = argv.find((a) => ['dry-run', 'backup', 'run'].includes(a)) ?? 'dry-run'
  const DSH_HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
  const mementoDb = argValue(argv, '--memento-db') ?? path.join(DSH_HOME, 'dsh-memento', 'memory.db')
  const ledgerDir = argValue(argv, '--ledger-dir') ?? path.join(DSH_HOME, 'acp')
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const backupDir = argValue(argv, '--backup-dir') ?? path.join(DSH_HOME, 'archive', 'memento-backup-' + date)
  const asJson = argv.includes('--json')
  try {
    if (mode === 'dry-run') {
      const r = dryRun(mementoDb)
      if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
      console.log('== memento → ACP 迁移 dry-run ==')
      console.log('memento.db:', mementoDb)
      console.log('entries:', r.stats.entries, '| mappings:', r.stats.mappings, '| 切分后候选:', r.stats.parts,
        '| >500 切分条目:', r.stats.over500)
      console.log('user 候选:', r.stats.userParts, '| agent 候选:', r.stats.agentParts,
        '| writeGuard block:', r.stats.blocked, '| quarantine:', r.stats.quarantine)
      console.log('--- 候选清单 ---')
      for (const c of r.list) {
        console.log([c.entryId.slice(0, 8), c.track, c.scope, c.authority, c.claimDomain,
          c.part + '/' + c.of, c.guard, c.chars + '字'].join(' | '), '|', c.head)
      }
    } else if (mode === 'backup') {
      const r = backupMementoDb(mementoDb, backupDir)
      if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
      console.log('backup ->', backupDir)
      console.log('files:', r.files.join(', '), '| checkpoint:', r.checkpoint === 'skipped' ? 'skipped' : 'busy=' + r.checkpoint)
    } else {
      const r = runMigration({ mementoDbPath: mementoDb, ledgerDir })
      if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
      console.log('== migration run ==')
      console.log('ledger:', ledgerDir)
      console.log('候选:', r.totalParts, '| 插入:', r.inserted, '| 跳过(已存在):', r.skipped,
        '| 失败:', r.failed.length, '| block:', r.blocked.length, '| quarantine:', r.quarantined.length)
      console.log('对账（ledger 内 kind=memento 证据数）:', r.reconciled)
      if (r.blocked.length) console.log('blocked:', JSON.stringify(r.blocked, null, 2))
      if (r.failed.length) console.log('failed:', JSON.stringify(r.failed, null, 2))
    }
  } catch (err) {
    console.error('migrate-memento error:', (err && err.stack) || err)
    console.error(USAGE)
    process.exit(1)
  }
}
