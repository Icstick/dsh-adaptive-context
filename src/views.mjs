// src/views.mjs — Materialized view（M3 B3）：views are rebuildable。
//
// 铁律对齐：Evidence is truth；views are rebuildable。
//   Evidence (Ledger, append-only, 真相)
//     → Candidate (行为层, inert proposal)
//     → Promotion (policy gate, 授予行为权威)
//     → View (materialized hot path, cache——可随时从 candidate 重放原子重建)
//
// 本模块只做"视图文件"这一层：行集合的构建（buildExpressionRows，从 candidate 重放）、
// 原子写（temp+rename）、读取（fail-open）、校验（与重放对比 checksum）。
// 状态迁移/审计/审批 由 expression.mjs / consolidate.mjs 负责；本模块零副作用原则：
// 只读写视图文件，不碰 candidate/evidence/audit 表。
//
// 视图文件格式（{dir}/expression.json）：
//   { schema: 'acp-expression-view', version: 1, checksum: <sha256>,
//     generatedAt: <ISO>, rows: [ ...view 行 ] }
// checksum = sha256(规范化行集合 JSON)（对象键排序 + 行序稳定 → 跨写入确定性）。
// 行集合 = promoted 候选 × 其证据行的快照（与 composer 候选字段兼容，readGuard 可直接消费）。

import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

export const VIEW_SCHEMA = 'acp-expression-view'
export const VIEW_VERSION = 1
export const EXPRESSION_VIEW_FILE = 'expression.json'

/** 递归规范化：对象键排序（数组保序）——checksum 的确定性基准 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

/** 规范化 JSON 串（行集合 → 确定性序列化） */
export function canonicalJson(rows) {
  return JSON.stringify(canonicalize(rows))
}

/** 行集合 → sha256 checksum（写入视图文件头；verify 时重算对比） */
export function checksumOf(rows) {
  return createHash('sha256').update(canonicalJson(rows), 'utf8').digest('hex')
}

/**
 * 从 candidate 重放构建 expression view 行——"views are rebuildable"的源头。
 * 只取 promoted 候选（rolled_back/rejected/superseded 天然排除 → 视图即时失效）；
 * 每候选解析其证据行（ledger.getById）为快照行，与 composer 候选字段兼容。
 *
 * 确定性：仅依赖 append-only 数据（evidence 内容不变、candidate 重放投影稳定），
 * 写（writeExpression 前由调用方调用）与验（verifyExpression）同源同构 → checksum 可比。
 *
 * @param {object} args
 * @param {object} args.candidateStore - createCandidateStore 句柄（listCandidates）
 * @param {object} [args.ledger] - openEvidenceLedger 句柄（getById 解析证据内容）
 * @param {string} [args.scopeId] - 只投影该 scope 的 promoted 候选；缺省全部
 * @returns {object[]} 视图行数组
 */
export function buildExpressionRows({ candidateStore, ledger, scopeId } = {}) {
  if (!candidateStore || typeof candidateStore.listCandidates !== 'function') return []
  const candidates = candidateStore.listCandidates({ scopeId, state: 'promoted', limit: 200 })
  const rows = []
  for (const c of candidates) {
    for (const evidenceId of c.evidenceIds ?? []) {
      const ev = typeof ledger?.getById === 'function' ? ledger.getById(evidenceId) : null
      if (!ev) continue // 证据缺失（异常态）跳过——写/验同源，不产生漂移
      rows.push({
        id: ev.id,
        candidateId: c.id,
        scopeId: c.scopeId ?? ev.scopeId,
        sourceClass: ev.sourceClass ?? 'evidence',
        authority: ev.authority ?? 'user_explicit',
        confidence: typeof ev.confidence === 'number' ? ev.confidence : 0.5,
        durability: typeof ev.durability === 'number' ? ev.durability : 0.5,
        sensitivity: ev.sensitivity ?? 'private',
        claimDomain: c.domain ?? ev.claimDomain ?? 'style',
        content: ev.content,
        contentHash: ev.contentHash,
        sourceRef: ev.sourceRef ?? {},
        observedAt: ev.observedAt,
        validFrom: ev.validFrom ?? null,
        validUntil: ev.validUntil ?? null,
        state: 'active', // 视图行恒 active（注入资格；readGuard 放行）
        evidenceIds: c.evidenceIds,
        promotedAt: c.updatedAt,
        decisionReason: c.decisionReason,
        policy: c.policy,
      })
    }
  }
  return rows
}

/**
 * Materialized view 工厂。
 * @param {object} opts
 * @param {string} opts.dir - 视图目录（expression.json 写入此处）
 * @param {object} [opts.ledger] - openEvidenceLedger 句柄（buildExpressionRows/verify 用）
 * @param {object} [opts.candidateStore] - createCandidateStore 句柄（重放源）
 * @param {string} [opts.scopeId] - 视图所属 scope（verify/rebuild 投影过滤；缺省全部）
 * @returns {{
 *   readExpression: () => object[] | null,
 *   writeExpression: (rows: object[]) => {path: string, checksum: string, rows: number},
 *   verifyExpression: () => {ok: boolean, checksum: string | null, mismatches: string[]},
 *   rebuildExpression: () => {path: string, checksum: string, rows: number},
 *   path: string,
 * }}
 */
export function createViews({ dir, ledger = null, candidateStore = null, scopeId = null } = {}) {
  if (!dir || typeof dir !== 'string') {
    throw new TypeError('createViews requires a string dir')
  }
  const viewFile = path.join(dir, EXPRESSION_VIEW_FILE)

  /**
   * 读视图行（fail-open）：文件缺失/损坏/schema 不符 → null（调用方回落 ledger 注入）。
   * 不做 checksum 校验（那是 verifyExpression 的职责；本函数是 hot path）。
   * @returns {object[] | null}
   */
  function readExpression() {
    try {
      if (!existsSync(viewFile)) return null
      const parsed = JSON.parse(readFileSync(viewFile, 'utf8'))
      if (!parsed || parsed.schema !== VIEW_SCHEMA || parsed.version !== VIEW_VERSION) return null
      return Array.isArray(parsed.rows) ? parsed.rows : null
    } catch {
      return null
    }
  }

  /**
   * 原子写视图：temp 文件 + rename（同目录 rename 原子替换，不产生半写文件）。
   * @param {object[]} rows
   * @returns {{path: string, checksum: string, rows: number}}
   */
  function writeExpression(rows) {
    if (!Array.isArray(rows)) throw new TypeError('writeExpression requires an array of rows')
    mkdirSync(dir, { recursive: true })
    const checksum = checksumOf(rows)
    const payload = {
      schema: VIEW_SCHEMA,
      version: VIEW_VERSION,
      checksum,
      generatedAt: new Date().toISOString(),
      rows,
    }
    const tmp = path.join(
      dir,
      '.' + EXPRESSION_VIEW_FILE + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2),
    )
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      renameSync(tmp, viewFile)
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch { /* 清理失败忽略 */ }
      throw err
    }
    return { path: viewFile, checksum, rows: rows.length }
  }

  /**
   * 校验视图与 candidate 重放一致（两层）：
   *   1) 内容完整性（篡改检测）：文件头 checksum 与 rows 重算一致；
   *   2) 重放漂移检测：重算 checksum 与从 candidate 重放重建的期望 checksum 一致。
   * @returns {{ok: boolean, checksum: string | null, mismatches: string[]}}
   */
  function verifyExpression() {
    const mismatches = []
    if (!existsSync(viewFile)) {
      return { ok: false, checksum: null, mismatches: ['view file missing: ' + viewFile] }
    }
    let stored
    try {
      stored = JSON.parse(readFileSync(viewFile, 'utf8'))
    } catch (err) {
      return { ok: false, checksum: null, mismatches: ['view file unparsable: ' + (err && err.message)] }
    }
    if (!stored || stored.schema !== VIEW_SCHEMA || stored.version !== VIEW_VERSION) {
      return { ok: false, checksum: null, mismatches: ['view schema/version mismatch'] }
    }
    const rows = Array.isArray(stored.rows) ? stored.rows : []
    const contentChecksum = checksumOf(rows)

    if (stored.checksum !== contentChecksum) {
      mismatches.push(
        'tampered: stored checksum ' + String(stored.checksum).slice(0, 12)
        + ' != recomputed ' + contentChecksum.slice(0, 12),
      )
    }

    const expectedRows = buildExpressionRows({ candidateStore, ledger, scopeId })
    const expectedChecksum = checksumOf(expectedRows)
    if (expectedChecksum !== contentChecksum) {
      mismatches.push(
        'drift: view does not match candidate replay (view ' + contentChecksum.slice(0, 12)
        + ' != replay ' + expectedChecksum.slice(0, 12) + ')',
      )
      const storedIds = rows.map((r) => r.id).sort()
      const expectedIds = expectedRows.map((r) => r.id).sort()
      const onlyStored = storedIds.filter((id) => !expectedIds.includes(id))
      const onlyExpected = expectedIds.filter((id) => !storedIds.includes(id))
      if (onlyStored.length) mismatches.push('in view only: ' + onlyStored.join(', '))
      if (onlyExpected.length) mismatches.push('missing from view: ' + onlyExpected.join(', '))
    }

    return { ok: mismatches.length === 0, checksum: expectedChecksum, mismatches }
  }

  /** 重建：candidate 重放 → 行 → 原子写（views are rebuildable 的直接兑现） */
  function rebuildExpression() {
    const rows = buildExpressionRows({ candidateStore, ledger, scopeId })
    return writeExpression(rows)
  }

  return { readExpression, writeExpression, verifyExpression, rebuildExpression, path: viewFile }
}
