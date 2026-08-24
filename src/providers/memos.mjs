// src/providers/memos.mjs — MemOS RecallProvider adapter（HTTP client，MVP 实验接入）。
//
// 调 MemOS Viewer 的 HTTP API（127.0.0.1:18801，in-process viewer）：
//   POST /api/v1/memory/search  body: { query, agent, topK }
//   → RetrievalResultDTO { hits: [{ tier, refId, refKind, score, snippet }] }
//
// 纪律：
//   - AbortSignal 尊重：3s 前台硬上限（对齐 MemOS DSH adapter 的 recallTimeoutMs）
//   - fail-open：Provider 宕机/超时 → 返回 []（不阻断 DSH turn）
//   - 结果归一化为 RecallCandidate { id, content, score, sourceProvider }
//   - 只读：不做任何写操作（capture 由 MemOS 自己的 turn/end 处理）

import { isValidRecallCandidate } from './recall-contract.mjs'

export const MEMOS_DEFAULT_BASE_URL = 'http://127.0.0.1:18801'
export const MEMOS_DEFAULT_TIMEOUT_MS = 3000

/**
 * 创建 MemOS RecallProvider。
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] - MemOS Viewer 地址（默认 127.0.0.1:18801）
 * @param {number} [opts.timeoutMs] - 前台超时（默认 3000，DSH 上限）
 * @param {string} [opts.agent] - MemOS agent 命名空间（默认 'deepseek-harness'）
 * @returns {{ id: string, recall: (query, signal) => Promise<object[]> }}
 */
export function createMemosProvider(opts = {}) {
  const baseUrl = opts.baseUrl ?? MEMOS_DEFAULT_BASE_URL
  const timeoutMs = Math.min(opts.timeoutMs ?? MEMOS_DEFAULT_TIMEOUT_MS, MEMOS_DEFAULT_TIMEOUT_MS)
  const agent = opts.agent ?? 'deepseek-harness'

  return {
    id: 'memos',
    /**
     * 搜索记忆（只读，fail-open）。
     * @param {object} query - { text, limit? }
     * @param {AbortSignal} [signal]
     * @returns {Promise<object[]>} RecallCandidate[]（失败返回 []）
     */
    async recall(query, signal) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onSignal = () => controller.abort()
      signal?.addEventListener('abort', onSignal, { once: true })

      try {
        const resp = await fetch(baseUrl + '/api/v1/memory/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: String(query?.text ?? '').slice(0, 512),
            agent,
            topK: { tier1: query?.limit ?? 10, tier2: query?.limit ?? 10, tier3: query?.limit ?? 10 },
          }),
          signal: controller.signal,
        })
        if (!resp.ok) return []
        const data = await resp.json()
        const hits = Array.isArray(data?.hits) ? data.hits : []
        return hits
          .map((h) => ({
            id: h.refId ? `memos:${h.refKind}:${h.refId}` : 'memos:' + h.refKind,
            content: h.snippet ?? '',
            score: typeof h.score === 'number' ? h.score : 0,
            sourceProvider: 'memos',
            tier: h.tier,
            refKind: h.refKind,
          }))
          .filter(isValidRecallCandidate)
      } catch {
        return [] // fail-open：Provider 故障不阻断
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onSignal)
      }
    },
  }
}
