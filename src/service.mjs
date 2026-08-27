// src/service.mjs — Service Definition：ctx.acp。
// 提供证据读写、recall（Context Composer 最小入口）、治理与统计。
// 写路径经 governance.writeGuard 判定后再落 Ledger（先 validate 后 write）。

import { writeGuard, readGuard } from './governance.mjs'
import { supersede, quarantine, redact, rollback, getLineage } from './lifecycle.mjs'
import { SCOPES } from './constants.mjs'
import { exportJsonl, importJsonl } from './export-import.mjs'
import { rebuildView, verifyView } from './rebuild.mjs'

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
 * @param {boolean} [deps.startupRebuild] - C3 启动校验开关：verify 失配时自动 rebuild（默认 true）
 * @returns {object} acp service
 */
export function createAcpService({ ledger, startupRebuild = true }) {
  /** C2/C3 共享依赖：重建/校验/导入所需的 store 句柄（ledger 自带 candidate/audit store） */
  const viewDeps = () => ({
    ledger,
    candidateStore: ledger.candidateStore,
    auditStore: ledger.auditStore,
  })

  /** export/import 审计的 scope 兜底：非法 scope 不阻断导出（按 user-global 记） */
  const auditScope = (scopeId) => (scopeId && SCOPES.includes(scopeId) ? scopeId : 'user-global')

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
     *
     * 双视图（M2 T5 temporal truth）：
     *   - 默认 now 视图：只查 active 证据（superseded 不可召回）；
     *   - allowSuperseded: true 时放开 query 的 state 过滤（历史/当时视图），
     *     由 readGuard 的 allowSuperseded 分支决定 superseded 是否可见
     *     （quarantined / redacted 无论何时都不可注入，readGuard 兜底）。
     *
     * @param {object} q - { query?, scopeId?, targetDomain?, validAt?, allowSuperseded?, maxTokens? }
     * @returns {{items: object[], dropped: string[], tokens: number}}
     */
    recall(q = {}) {
      const allowSuperseded = q.allowSuperseded === true
      const cands = ledger.query({
        scopeId: q.scopeId,
        state: allowSuperseded ? undefined : 'active',
        limit: q.limit ?? 20,
        // OR 召回：整串 + CJK bigram / token（写后立即读等短查询可命中）
        contentAnySubstr: q.query ? recallSubstrings(q.query) : undefined,
        validAt: q.validAt,
      })
      const passed = []
      const dropped = []
      for (const ev of cands.items) {
        const g = readGuard(ev, {
          scopeId: q.scopeId,
          targetDomain: q.targetDomain,
          validAt: q.validAt,
          allowSuperseded,
        })
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

    /**
     * history：回溯证据演进历史（双视图之"当时视图"，M2 T5）。
     * 沿 supersedes 直接前驱回溯，返回 [最旧 ... 最新] 的有序 id 数组（含 id 自己）；
     * 与 getLineage(id, { ledger }) 语义一致（演进历史不冗余存储，CONTRACTS.md §1）。
     *
     * @param {string} id - 证据 id（通常为当前生效的最新一条）
     * @returns {string[]|null} lineage id 数组；id 不存在 / 非字符串返回 null
     */
    history(id) {
      if (typeof id !== 'string' || id.length === 0) return null
      if (!ledger.getById(id)) return null
      return getLineage(id, { ledger })
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

    /**
     * export：用户可审计导出（全部状态，含标注；secret 本就不入库）。
     * format='json'（缺省）保持 M2 行为：evidence 子集 JSON 数组；
     * format='jsonl'（M3 C2）：四流全量 JSONL 快照（evidence/observation/candidate/audit，
     * streams 参数可只导子集；scopeId 参数仅用于审计记录，快照本身不按 scope 过滤）。
     * 导出即审计（M3-PLAN C1：export 写点），actor='agent'。
     */
    export(scopeId, opts = {}) {
      if (opts.format === 'jsonl') {
        const text = exportJsonl({
          ledger,
          candidateStore: ledger.candidateStore,
          auditStore: ledger.auditStore,
          streams: opts.streams,
          ts: opts.ts,
        })
        ledger.auditStore.appendAudit({
          op: 'export',
          scopeId: auditScope(scopeId),
          actor: 'agent',
          reason: 'user export',
          payload: { format: 'jsonl', streams: opts.streams ?? null },
        })
        return text
      }
      const rows = opts.includeNonActive
        ? ledger.query({ scopeId }).items
        : ledger.listActive(scopeId)
      const out = rows.map((ev) => ({
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
      ledger.auditStore.appendAudit({
        op: 'export',
        scopeId: auditScope(scopeId),
        actor: 'agent',
        reason: 'user export',
        payload: { format: 'json' },
      })
      return out
    },

    /**
     * import：导入 JSONL 快照（M3 C2，幂等 + 容错）。
     * 原样恢复（不经 append/upsert，避免导入副作用污染 audit 流）；结果统计 {inserted, skipped, errors}；
     * 顺带记一条 audit（op='import'，actor='user'，payload 含统计摘要）。
     */
    import(jsonlText) {
      const res = importJsonl(String(jsonlText ?? ''), viewDeps())
      ledger.auditStore.appendAudit({
        op: 'import',
        scopeId: 'user-global',
        actor: 'user',
        reason: 'import jsonl',
        payload: { inserted: res.inserted, skipped: res.skipped, errors: res.errors.length },
      })
      return res
    },

    /** audit：审计查询（透传 auditStore.queryAudit：op/scopeId/actor/limit 过滤） */
    audit(q = {}) {
      return ledger.auditStore.queryAudit({
        op: q.op,
        scopeId: q.scopeId,
        actor: q.actor,
        limit: q.limit,
      })
    },

    /**
     * rebuild：手动重建视图（M3 C3）。重建成功记 audit（op='rebuild'，actor='user'）。
     * 当前视图：'expression'（promoted 候选物化）。
     */
    rebuild(viewName = 'expression') {
      const res = rebuildView(viewName, viewDeps())
      if (res.ok) {
        ledger.auditStore.appendAudit({
          op: 'rebuild',
          targetId: 'view:' + viewName,
          scopeId: 'user-global',
          actor: 'user',
          reason: 'manual rebuild',
          payload: { checksum: res.checksum },
        })
      }
      return res
    },

    /**
     * startupVerify：启动时校验 expression view 与 candidate 重放一致。
     * 失配且 startupRebuild=true（缺省）→ 自动重建 + audit（op='rebuild'，actor='system'）；
     * startupRebuild=false → 只报告不重建。返回 {ok, checksum, rebuilt, reason?}。
     */
    startupVerify() {
      const v = verifyView('expression', viewDeps())
      if (v.ok) return { ok: true, checksum: v.checksum, rebuilt: false }
      if (!startupRebuild) {
        return { ok: false, checksum: v.checksum ?? null, rebuilt: false, reason: v.reason ?? 'verify failed' }
      }
      const r = rebuildView('expression', viewDeps())
      if (r.ok) {
        ledger.auditStore.appendAudit({
          op: 'rebuild',
          targetId: 'view:expression',
          scopeId: 'user-global',
          actor: 'system',
          reason: 'startup verify mismatch auto rebuild',
          payload: { checksum: r.checksum },
        })
      }
      return { ok: r.ok, checksum: r.checksum, rebuilt: true }
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