// src/service.mjs — Service Definition：ctx.acp。
// 提供证据读写、recall（Context Composer 最小入口）、治理与统计。
// 写路径经 governance.writeGuard 判定后再落 Ledger（先 validate 后 write）。

import { writeGuard, readGuard } from './governance.mjs'

/**
 * 构造 ctx.acp 服务。
 * @param {object} deps
 * @param {object} deps.ledger - openEvidenceLedger() 返回的 Provider
 * @returns {object} acp service
 */
export function createAcpService({ ledger }) {
  return {
    /** 追加一条 Evidence（带 Write Guard），返回 {inserted, id, decision} */
    append(input) {
      const verdict = writeGuard(input)
      if (verdict.decision === 'block') {
        return { inserted: false, id: null, decision: 'block', reasons: verdict.reasons }
      }
      const effectiveInput = {
        ...input,
        state: verdict.decision === 'quarantine' ? 'quarantined' : (input.state ?? 'active'),
      }
      const res = ledger.append(effectiveInput)
      return { inserted: res.inserted, id: res.id, decision: verdict.decision, reasons: verdict.reasons }
    },

    /** 读取单条 */
    get(id) {
      return ledger.getById(id)
    },

    /** 状态迁移（supersede/quarantine/redact/active） */
    setState(id, state, opts) {
      return ledger.setState(id, state, opts)
    },

    /**
     * Recall：Context Composer 的最小可用实现。
     * 1) 按 query 拉候选；2) Read Guard 过滤；3) token 预算截断。
     * @param {object} q - { query?, scopeId?, targetDomain?, validAt?, maxTokens? }
     * @returns {{items: object[], dropped: string[], tokens: number}}
     */
    recall(q = {}) {
      const cands = ledger.query({
        scopeId: q.scopeId,
        state: 'active',
        limit: q.limit ?? 20,
        contentSubstr: q.query,
        validAt: q.validAt,
      })
      const passed = []
      const dropped = []
      for (const ev of cands.items) {
        const g = readGuard(ev, { scopeId: q.scopeId, targetDomain: q.targetDomain, validAt: q.validAt })
        if (g.allowed) passed.push(ev)
        else dropped.push(`${ev.id}:${g.reasons.join(';')}`)
      }
      // token 预算：粗略估算（中英混合约 1 char ≈ 0.7 token）
      const budget = q.maxTokens ?? 300
      let tokens = 0
      const items = []
      for (const ev of passed) {
        const t = Math.ceil(ev.content.length * 0.7)
        if (tokens + t > budget) { dropped.push(`${ev.id}:budget`); continue }
        tokens += t
        items.push(ev)
      }
      return { items, dropped, tokens }
    },

    /** 统计 */
    stats() {
      return ledger.stats()
    },

    /** 用户可审计导出（不含 secret——secret 本就不入库） */
    exportActive(scopeId) {
      return ledger.listActive(scopeId)
    },
  }
}
