// src/service.mjs — Service Definition：ctx.acp。
// 提供证据读写、recall（Context Composer 最小入口）、治理与统计。
// 写路径经 governance.writeGuard 判定后再落 Ledger（先 validate 后 write）。

import { writeGuard, readGuard } from './governance.mjs'
import { supersede, quarantine, redact, rollback } from './lifecycle.mjs'

/**
 * 生成 recall 的子串集合（OR 召回，CJK 友好）：
 * - 整串（保精度）
 * - CJK 时：连续 2 字符窗口（bigram），如 '喜欢什么风格回答' → ['喜欢','欢什','什么','么风','风格','格回','回答']
 * - 非 CJK 时：空白/标点切 token（'package manager' → ['package','manager']）
 */
export function recallSubstrings(query) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const parts = [q]
  if (/[\u4e00-\u9fff]/.test(q)) {
    for (let i = 0; i < q.length - 1; i++) parts.push(q.slice(i, i + 2))
  } else {
    for (const t of q.split(/[\s\p{P}]+/u)) if (t) parts.push(t)
  }
  return [...new Set(parts)].filter((s) => s.length > 0)
}

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
        // OR 召回：整串 + CJK bigram / token（写后立即读等短查询可命中）
        contentAnySubstr: q.query ? recallSubstrings(q.query) : undefined,
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

    // ===================== 用户权利（GOVERNANCE.md §6） =====================

    /** inspect：读取单条证据详情（含状态/来源/元数据） */
    inspect(id) {
      return ledger.getById(id)
    },

    /** export：用户可审计导出（全部状态，含标注；secret 本就不入库） */
    export(scopeId, opts = {}) {
      const rows = opts.includeNonActive
        ? ledger.query({ scopeId }).items
        : ledger.listActive(scopeId)
      return rows.map((ev) => ({
        id: ev.id,
        state: ev.state,
        sourceClass: ev.sourceClass,
        authority: ev.authority,
        claimDomain: ev.claimDomain,
        confidence: ev.confidence,
        sensitivity: ev.sensitivity,
        content: ev.content,
        observedAt: ev.observedAt,
        supersedes: ev.supersedes,
        metadata: ev.metadata,
      }))
    },

    /**
     * correct：用户纠正入口。
     * 写入 user_correction 证据 + supersede 目标旧证据（Level 1 fast-path）。
     * @param {object} input - { targetId?, correction, sourceRef?, scopeId?, agentKey?, sessionType? }
     * @returns {{inserted: boolean, newId: string, superseded: boolean, reasons: string[]}}
     */
    correct(input = {}) {
      if (typeof input.correction !== 'string' || input.correction.length === 0) {
        return { inserted: false, newId: null, superseded: false, reasons: ['correction must be non-empty'] }
      }
      const candidate = {
        sourceClass: 'user_correction',
        authority: 'user_correction',
        claimDomain: 'user_preference',
        confidence: 1,
        durability: 0.9,
        sensitivity: 'private',
        content: input.correction,
        sourceRef: input.sourceRef ?? {},
        scopeId: input.scopeId ?? 'user-global',
        agentKey: input.agentKey ?? '',
        sessionType: input.sessionType ?? 'root',
      }
      const res = this.append(candidate)
      if (!res.inserted) return { inserted: false, newId: res.id, superseded: false, reasons: res.reasons ?? [] }

      let superseded = false
      if (input.targetId) {
        try {
          supersede(input.targetId, res.id, { ledger })
          superseded = true
        } catch (err) {
          // targetId 无效或无权 supersede——纠正本身已记录，supersede 失败不致命
          return { inserted: true, newId: res.id, superseded: false, reasons: [err.message] }
        }
      }
      return { inserted: true, newId: res.id, superseded, reasons: [] }
    },

    /** release：从 quarantine 释放为 active（人工判定安全） */
    release(id) {
      const row = ledger.getById(id)
      if (!row) return { ok: false, reason: 'not found' }
      if (row.state !== 'quarantined') return { ok: false, reason: `state is ${row.state}, not quarantined` }
      rollback(id, { ledger })
      return { ok: true, row: ledger.getById(id) }
    },

    /** redact：脱敏（内容保留，永不注入） */
    redact(id) {
      try {
        const row = redact(id, { ledger })
        return { ok: true, row }
      } catch (err) {
        return { ok: false, reason: err.message }
      }
    },

    /**
     * delete：用户删除——append-only 语义下不物理删，标记 redacted + reviewStatus=deleted_by_user
     * （内容保留可审计，但永不注入/recall）。
     */
    delete(id) {
      try {
        const row = redact(id, { ledger })
        if (typeof ledger.updateMetadata === 'function') {
          ledger.updateMetadata(id, { reviewStatus: 'deleted_by_user' })
        }
        return { ok: true, row: ledger.getById(id) }
      } catch (err) {
        return { ok: false, reason: err.message }
      }
    },

    /** 用户可审计导出（不含 secret——secret 本就不入库）——保留旧名兼容 */
    exportActive(scopeId) {
      return this.export(scopeId, { includeNonActive: false })
    },
  }
}