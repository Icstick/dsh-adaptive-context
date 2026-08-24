// src/lifecycle.mjs — Evidence state 迁移（supersede/quarantine/redact/rollback）与演进历史回溯（getLineage）。
//
// supersedes 字段语义（方案甲，CONTRACTS.md §1，2026-08-25 决策）：
//   evidence.supersedes: string[] = 这条证据直接替代了哪些旧证据（直接前驱）。
//   即 新证据 E2 替代 旧证据 E1 时：E1.state = 'superseded'，E2.supersedes = [E1]。
// getLineage(id) 沿 supersedes 向前递归 → 有序 [最旧 ... 最新]（含 id 自己）。
//
// 纪律：
//   - 纯逻辑 + 传入 ledger 句柄（openEvidenceLedger() 的返回），不直接 new DatabaseSync。
//   - metadata 更新统一走 ledger.updateMetadata（固定键集校验）。
//   - 结构化错误：抛 LifecycleError，code 取 constants.ERROR_CODES。

import { ERROR_CODES } from './constants.mjs'

/** 允许触发 supersede 的 authority（显式用户纠正/陈述 fast-path，CONTRACTS.md §8 Level 1） */
export const SUPERSEDE_AUTHORITIES = Object.freeze(['user_explicit', 'user_correction'])

/** 可被 rollback 恢复为 active 的非 active 状态 */
const ROLLBACKABLE_STATES = new Set(['superseded', 'quarantined', 'redacted'])

/** metadata 固定键（与 store.mjs METADATA_ALLOWED_KEYS 对齐；quarantine 只写 reviewStatus） */
const METADATA_REVIEW_STATUS_KEY = 'reviewStatus'

/** 结构化错误：code + message（+ 可选 details）。
 * code 取 constants.ERROR_CODES 的字符串常量（INVALID_INPUT / NOT_FOUND / DENIED 等）。 */
export class LifecycleError extends Error {
  /**
   * @param {string} code - ERROR_CODES 之一
   * @param {string} message - 人类可读描述
   * @param {object} [details] - 附加结构化信息
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'LifecycleError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message) {
  throw new LifecycleError(code, message)
}

/** 校验 ledger 句柄形状（必须有 getById / setState / db） */
function requireLedger(ledger) {
  if (!ledger || typeof ledger.getById !== 'function' || typeof ledger.setState !== 'function') {
    fail(ERROR_CODES.INVALID_INPUT, 'lifecycle operation requires a ledger handle ({ ledger })')
  }
  return ledger
}

/** 读取证据，不存在则抛 NOT_FOUND */
function requireEvidence(ledger, id, label) {
  const row = ledger.getById(id)
  if (!row) fail(ERROR_CODES.NOT_FOUND, `${label} evidence '${id}' not found in ledger`)
  return row
}

/**
 * 用新证据替代旧证据（显式用户纠正 fast-path）。
 *
 * 效果（方案甲）：
 *   - 旧证据 state → 'superseded'（append-only，不物理删除）
 *   - 新证据 supersedes 追加 oldId（直接前驱），state 保持原样（正常为 active）
 *
 * 门槛：新证据 authority 必须是 user_explicit / user_correction；
 * 其余 authority（external_information / agent_* / system_policy）无资格触发替代，抛 DENIED。
 *
 * @param {string} oldId - 被替代的旧证据 id
 * @param {string} newId - 替代者证据 id（必须已写入 ledger）
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的句柄
 * @returns {{oldId: string, newId: string, old: object, active: object}} 更新后的两条证据
 * @throws {LifecycleError} INVALID_INPUT / NOT_FOUND / DENIED
 */
export function supersede(oldId, newId, { ledger } = {}) {
  requireLedger(ledger)
  if (typeof oldId !== 'string' || oldId.length === 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'supersede: oldId must be a non-empty string')
  }
  if (typeof newId !== 'string' || newId.length === 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'supersede: newId must be a non-empty string')
  }
  if (oldId === newId) {
    fail(ERROR_CODES.INVALID_INPUT, 'supersede: cannot supersede an evidence with itself')
  }

  const old = requireEvidence(ledger, oldId, 'supersede: old')
  const nu = requireEvidence(ledger, newId, 'supersede: new')

  if (!SUPERSEDE_AUTHORITIES.includes(nu.authority)) {
    fail(ERROR_CODES.DENIED,
      `supersede denied: evidence '${newId}' has authority '${nu.authority}', ` +
      `only ${SUPERSEDE_AUTHORITIES.join(' / ')} may trigger supersede`)
  }

  // 旧证据：仅翻转 state（supersedes 字段属于替代者一侧，不改 old.supersedes）
  ledger.setState(oldId, 'superseded')

  // 新证据：supersedes 追加直接前驱（幂等：已存在则不重复添加）
  const nextSupersedes = [...(nu.supersedes ?? [])]
  if (!nextSupersedes.includes(oldId)) nextSupersedes.push(oldId)
  ledger.setState(newId, nu.state, { supersedes: nextSupersedes })

  return { oldId, newId, old: ledger.getById(oldId), active: ledger.getById(newId) }
}

/**
 * 隔离一条证据：state → 'quarantined'（可疑，不注入但保留审计）。
 *
 * 可选 reason 写入 metadata.reviewStatus（metadata 固定键集之一，
 * 与 store.mjs METADATA_ALLOWED_KEYS 对齐；其余 metadata 键原样保留）。
 *
 * @param {string} id - 目标证据 id
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的句柄
 * @param {string} [opts.reason] - 隔离原因（非空字符串，写入 metadata.reviewStatus）
 * @returns {object} 更新后的证据行
 * @throws {LifecycleError} INVALID_INPUT / NOT_FOUND
 */
export function quarantine(id, { ledger, reason } = {}) {
  requireLedger(ledger)
  if (typeof id !== 'string' || id.length === 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'quarantine: id must be a non-empty string')
  }
  requireEvidence(ledger, id, 'quarantine')
  if (reason !== undefined && (typeof reason !== 'string' || reason.length === 0)) {
    fail(ERROR_CODES.INVALID_INPUT, 'quarantine: reason must be a non-empty string when provided')
  }

  ledger.setState(id, 'quarantined')

  if (reason !== undefined) {
    // 统一走 store.updateMetadata（固定键集校验 + 合并保留）
    if (typeof ledger.updateMetadata !== 'function') {
      fail(ERROR_CODES.INVALID_INPUT, 'quarantine: ledger must expose updateMetadata(id, patch)')
    }
    ledger.updateMetadata(id, { [METADATA_REVIEW_STATUS_KEY]: reason })
  }

  return ledger.getById(id)
}

/**
 * 脱敏一条证据：state → 'redacted'。内容保留在 Ledger（append-only 不删列），
 * 但 readGuard 保证 redacted 永不注入主模型。
 *
 * @param {string} id - 目标证据 id
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的句柄
 * @returns {object} 更新后的证据行
 * @throws {LifecycleError} INVALID_INPUT / NOT_FOUND
 */
export function redact(id, { ledger } = {}) {
  requireLedger(ledger)
  if (typeof id !== 'string' || id.length === 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'redact: id must be a non-empty string')
  }
  requireEvidence(ledger, id, 'redact')
  return ledger.setState(id, 'redacted')
}

/**
 * 回滚：把 superseded / quarantined / redacted 的证据恢复为 active。
 *
 * 同时 revoke 替代关系：任何证据若在其 supersedes 中声称"我替代了 id"，
 * 则从中移除对 id 的引用——id 恢复后不再被当作他人纠正链上的被替代事实。
 * （id 自己声明的替代关系——id.supersedes——原样保留：id 恢复 active 后
 * 它替代的前驱依然被替代，语义自洽。）
 *
 * @param {string} id - 目标证据 id（state 必须为 superseded/quarantined/redacted）
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的句柄
 * @returns {object} 恢复后的证据行（state='active'）
 * @throws {LifecycleError} INVALID_INPUT / NOT_FOUND
 */
export function rollback(id, { ledger } = {}) {
  requireLedger(ledger)
  if (typeof id !== 'string' || id.length === 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'rollback: id must be a non-empty string')
  }
  const row = requireEvidence(ledger, id, 'rollback')

  if (!ROLLBACKABLE_STATES.has(row.state)) {
    fail(ERROR_CODES.INVALID_INPUT,
      `rollback: evidence '${id}' is '${row.state}', ` +
      `only ${[...ROLLBACKABLE_STATES].join(' / ')} can be rolled back to active`)
  }

  ledger.setState(id, 'active')
  revokeSupersedesRefs(ledger, id)
  return ledger.getById(id)
}

/** 从所有证据的 supersedes 中移除对 targetId 的引用（撤销"targetId 被替代"的声明）。
 * supersedes 列为 JSON 文本，MVP 规模（~500 行）直接全表扫描即可。 */
function revokeSupersedesRefs(ledger, targetId) {
  const rows = ledger.db.prepare('SELECT id, supersedes FROM evidence WHERE supersedes != ?').all('[]')
  for (const r of rows) {
    let arr
    try {
      arr = JSON.parse(r.supersedes)
    } catch {
      continue // 数据异常容忍：非 JSON 的 supersedes 不处理
    }
    if (!Array.isArray(arr) || !arr.includes(targetId)) continue
    const next = arr.filter((x) => x !== targetId)
    const row = ledger.getById(r.id)
    ledger.setState(r.id, row.state, { supersedes: next })
  }
}

/**
 * 回溯演进历史：返回有序数组 [最旧 ... 最新]，含 id 自己。
 *
 * 沿 supersedes（直接前驱）向前递归收集祖先集合（防环、容忍悬挂引用），
 * 再按 observedAt 升序稳定排序得到时间序（CONTRACTS.md §1：
 * "演进历史 = getLineage(id) 回溯 + observedAt 排序"）。
 * 单链 E1→E2→E3 时 getLineage(E3) === [E1, E2, E3]；无前驱则返回 [id]。
 *
 * @param {string} id - 起点证据 id（通常是当前生效的最新一条）
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的句柄
 * @returns {string[]} 证据 id 数组，从最老的祖先到 id
 * @throws {LifecycleError} INVALID_INPUT / NOT_FOUND
 */
export function getLineage(id, { ledger } = {}) {
  requireLedger(ledger)
  if (typeof id !== 'string' || id.length === 0) {
    fail(ERROR_CODES.INVALID_INPUT, 'getLineage: id must be a non-empty string')
  }
  const start = requireEvidence(ledger, id, 'getLineage')

  // DFS 后序收集：先递归前驱，再 push 自己 → 单链天然 [旧...新]
  const collected = []
  const seen = new Set()
  const walk = (ev) => {
    if (seen.has(ev.id)) return
    seen.add(ev.id)
    for (const prevId of ev.supersedes ?? []) {
      const prev = ledger.getById(prevId)
      if (!prev) continue // 悬挂引用容忍
      walk(prev)
    }
    collected.push(ev.id)
  }
  walk(start)

  // observedAt 升序稳定排序（时间序；同刻保持 DFS 结构序）
  const observedAt = new Map(collected.map((eid) => [eid, ledger.getById(eid).observedAt]))
  return collected.slice().sort((a, b) => {
    const ta = observedAt.get(a)
    const tb = observedAt.get(b)
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
}