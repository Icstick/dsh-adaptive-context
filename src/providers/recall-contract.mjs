// src/providers/recall-contract.mjs — 最小 RecallProvider 契约（CONTRACTS.md §7.1）。
//
// MVP 只实现 recall（供 MemOS 轻量实验接入）；v0.2 扩展完整 capability 契约
// （Reflect/Profile/Skill/Timeline）。

/** 归一化候选（各 Provider 输出统一转成此形状） */
export const RECALL_CANDIDATE_SHAPE = ['id', 'content', 'score', 'sourceProvider']

/**
 * 校验候选形状：缺失关键字段即拒绝（fail loud，不静默降级）。
 * @param {object} cand
 * @returns {boolean}
 */
export function isValidRecallCandidate(cand) {
  return (
    cand !== null && typeof cand === 'object' &&
    typeof cand.id === 'string' && cand.id.length > 0 &&
    typeof cand.content === 'string' && cand.content.length > 0 &&
    typeof cand.score === 'number' &&
    typeof cand.sourceProvider === 'string'
  )
}
