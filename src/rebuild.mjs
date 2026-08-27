// src/rebuild.mjs — Materialized View 重建 / 校验（M3 C3：views are rebuildable）。
//
// 设计（组D 独立实现，M3-PLAN §6.5；组C views.mjs 合入后可对接，否则维持本实现）：
//   - 视图 = 确定性内容 + 存于 acp_meta 的 checksum + 物化产物（meta 'view:<name>'）。
//   - 当前唯一视图 expression：从 candidateStore.replayCandidates()（事件重放，restart 一致）
//     筛选 state==='promoted' 的候选，按 (createdAt, id) 稳定排序生成视图内容。
//   - rebuildView(viewName)：重建内容 → 原子写产物 + checksum → {ok, checksum}。
//   - verifyView(viewName)：三向校验——产物 hash == 存储 checksum（防篡改）且
//     checksum == 当前重放内容 checksum（防陈旧）；任一失配 → ok:false。
//   - 可扩展：新视图在 VIEW_BUILDERS 注册即可（viewName 参数化）。
//
// 铁律对齐：Evidence is truth；views are rebuildable（视图永远可从头重建，不当作真相源）。

import { hashHex } from './constants.mjs'

/** 已注册视图名（未来新增视图在此扩展） */
export const VIEW_NAMES = Object.freeze(['expression'])

function metaKey(viewName, suffix) {
  return 'view:' + viewName + (suffix ? ':' + suffix : '')
}

/** 视图构建器注册表：viewName → (deps) => 确定性视图内容（数组） */
const VIEW_BUILDERS = {
  expression: buildExpressionView,
}

/** expression view：promoted 候选的物化（排序稳定，JSON 序列化确定性）。 */
function buildExpressionView(deps) {
  const replay = deps.candidateStore.replayCandidates()
  const promoted = [...replay.values()].filter((c) => c.state === 'promoted')
  promoted.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return promoted.map((c) => ({
    id: c.id,
    scopeId: c.scopeId,
    domain: c.domain,
    evidenceIds: c.evidenceIds,
    policy: c.policy,
    decisionReason: c.decisionReason,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }))
}

/** 内容确定性 checksum：对稳定序列化后的字符串取 sha256。 */
function contentChecksum(content) {
  return hashHex(JSON.stringify(content))
}

function checkDeps(viewName, deps) {
  if (typeof viewName !== 'string' || !VIEW_BUILDERS[viewName]) {
    return 'unknown view ' + JSON.stringify(String(viewName)) + ' (registered: ' + VIEW_NAMES.join('|') + ')'
  }
  if (!deps || typeof deps.candidateStore?.replayCandidates !== 'function') {
    return 'deps.candidateStore with replayCandidates() required'
  }
  if (!deps.ledger || typeof deps.ledger.getMeta !== 'function' || typeof deps.ledger.setMeta !== 'function') {
    return 'deps.ledger with getMeta()/setMeta() required'
  }
  return null
}

/**
 * 重建一个视图：从真相源（candidate 事件重放）重新物化并刷新 checksum。
 * @param {string} viewName - VIEW_NAMES 之一（当前 'expression'）
 * @param {object} deps - { ledger, candidateStore, ... }
 * @returns {{ok: true, checksum: string} | {ok: false, checksum: null, reason: string}}
 */
export function rebuildView(viewName, deps = {}) {
  const problem = checkDeps(viewName, deps)
  if (problem) return { ok: false, checksum: null, reason: problem }
  const content = VIEW_BUILDERS[viewName](deps)
  const checksum = contentChecksum(content)
  deps.ledger.setMeta(metaKey(viewName, ''), JSON.stringify(content))
  deps.ledger.setMeta(metaKey(viewName, 'checksum'), checksum)
  return { ok: true, checksum }
}

/**
 * 校验一个视图：物化产物未被篡改（产物 hash == 存储 checksum）且与当前重放一致
 * （存储 checksum == 重放内容 checksum）。任何未构建/失配都返回 ok:false（只读，不改写）。
 * @param {string} viewName - VIEW_NAMES 之一（当前 'expression'）
 * @param {object} deps - { ledger, candidateStore, ... }
 * @returns {{ok: boolean, checksum: string|null, reason?: string}}
 */
export function verifyView(viewName, deps = {}) {
  const problem = checkDeps(viewName, deps)
  if (problem) return { ok: false, checksum: null, reason: problem }
  const storedChecksum = deps.ledger.getMeta(metaKey(viewName, 'checksum'))
  const storedContent = deps.ledger.getMeta(metaKey(viewName, ''))
  if (storedChecksum === null || storedContent === null) {
    return { ok: false, checksum: null, reason: 'view not built yet' }
  }
  const recomputed = contentChecksum(VIEW_BUILDERS[viewName](deps))
  const artifactChecksum = hashHex(storedContent)
  if (storedChecksum !== recomputed) {
    return { ok: false, checksum: recomputed, reason: 'view checksum stale (candidates changed since rebuild)' }
  }
  if (artifactChecksum !== storedChecksum) {
    return { ok: false, checksum: recomputed, reason: 'view artifact tampered (content hash mismatch)' }
  }
  return { ok: true, checksum: recomputed }
}
