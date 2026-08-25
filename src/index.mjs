// src/index.mjs — dsh-adaptive-context function plugin 入口。
//
// 三角色 seam（对齐 dsh-memento 已验证模式）：
//   Service Definition → ctx.acp（service.mjs）
//   Provider           → SQLite Evidence Ledger（store.mjs）
//   Consumer           → DSH hooks 接入（本文件）+ 未来 acp_* 工具
//
// DSH seam 映射（goldmine 核对）：
//   session/event  → Evidence ingestion（canonical 来源，不是 pre-step 看到的 message）
//   agent/pre-step → Context Composer + bounded injection（waterfall，必须 next()）
//   turn/end       → enqueue background consolidation（MVP：no-op 占位）

import { openEvidenceLedger } from './store.mjs'
import { createAcpService } from './service.mjs'
import { isEvidenceWorthy, toEvidenceCandidate } from './extract.mjs'
import { compose, renderSourceLabelled } from './composer.mjs'
import { CLAIM_DOMAINS } from './constants.mjs'
import z from '@deepseek-ai/schemastery'

export const name = 'adaptive-context'
export const inject = []
export const Config = z.object({
  ledgerDir: z.string(),
  hotTokens: z.number().step(1).min(1).default(300),
  recallLimit: z.number().step(1).min(1).default(20),
  targetDomain: z.union(CLAIM_DOMAINS.map(domain => z.const(domain))).default('work'),
  debug: z.boolean().default(false),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
/**
 * 作用域解析（对齐 dsh-memento 语义：user-global / workspace）。
 * MVP：单 workspace 简化，固定 user-global；v0.1 按 ctx session cwd 派生 workspace scope。
 * @param {object} ctx
 * @returns {string} scopeId（SCOPES 之一）
 */
function scopeOf(ctx) {
  return 'user-global'
}

export function apply(ctx, config = {}) {
  const ledger = openEvidenceLedger({ dir: config.ledgerDir })
  const acp = createAcpService({ ledger })

  // --- Service Definition：注册 ctx.acp ---
  ctx.provide('acp', acp)

  // --- Consumer 1：session/event → Evidence ingestion ---
  // 只消费 durable session events（user/assistant/tool/turn），幂等 append。
  ctx.on('session/event', (event) => {
    try {
      if (!isEvidenceWorthy(event)) return
      const ev = toEvidenceCandidate(event, {
        scopeId: scopeOf(ctx),
        agentKey: event.agentKey ?? '',
        sessionType: event.sessionType ?? 'root',
      })
      if (!ev) return
      const res = acp.append(ev)
      // MVP：审计落 acp audit 表（TODO v0.1: 若 harness 收录 acp/* 词汇再 append session event）
      if (config.debug) {
        ctx.logger?.debug?.(`[acp] ingest ${res.decision} id=${res.id}`)
      }
    } catch (err) {
      ctx.logger?.warn?.('acp ingest error: ' + (err && err.message))
    }
  })

  // --- Consumer 2：agent/pre-step → Context Composer 注入（bounded） ---
  // waterfall：必须 next() 保留后续策略链（DSH 插件核心规则）。
  ctx.on('agent/pre-step', (meta, next) => {
    try {
      const scopeId = scopeOf(ctx)
      // 候选来源：Ledger active 证据（MVP 无 Provider 时语义并入 lexical）
      const candidates = ledger.query({
        scopeId,
        state: 'active',
        limit: config.recallLimit ?? 20,
      }).items
      const result = compose(candidates, {
        query: meta?.message ?? '',
        scopeId,
        targetDomain: config.targetDomain ?? 'work',
        hasProvider: false, // MVP：无外部语义 Provider
        maxTokens: config.hotTokens ?? 300,
      })
      if (result.items.length > 0) {
        // source-labelled plugin message：untrusted historical context，
        // 不伪装成 System Instruction（MemOS DSH adapter 验证过的范式）。
        const body = renderSourceLabelled(result.items)
        const payload = {
          role: 'user',
          content: body,
          meta: { acp: { source: 'adaptive-context', telemetry: result.telemetry } },
        }
        if (typeof ctx.send === 'function') {
          ctx.send(payload)
        } else if (typeof ctx.app === 'function' && ctx.app.session?.send) {
          ctx.app.session.send(payload)
        }
      }
      if (config.debug) {
        ctx.logger?.debug?.(`[acp] compose: ${JSON.stringify(result.telemetry)}`)
      }
    } catch (err) {
      // fail-open：ACP 故障不得阻断 turn
      ctx.logger?.warn?.(`[acp] composer error: ${err?.message}`)
    } finally {
      next?.()
    }
  })

  // --- Consumer 3：turn/end → 后台 consolidation 入队（MVP 占位） ---
  ctx.on('turn/end', () => {
    // TODO(v0.1)：per-scope serial queue + batch consolidate（Observation/Profile 派生）
    // MVP 不做：热路径零 reflection。
  })

  // --- dispose：先关 queue（MVP 无）再关 ledger ---
  ctx.effect(() => () => {
    ledger.close()
  })
}
