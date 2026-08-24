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
import { hashHex } from './constants.mjs'

export const name = 'adaptive-context'
export const inject = []
export const Config = {}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const ledger = openEvidenceLedger({ dir: config.ledgerDir })
  const acp = createAcpService({ ledger })

  // --- Service Definition：注册 ctx.acp ---
  ctx.provide('acp', acp)

  // --- Consumer 1：session/event → Evidence ingestion ---
  // 只消费 durable session events（user/assistant/tool/turn），幂等 append。
  ctx.on('session/event', (event) => {
    if (!isEvidenceWorthy(event)) return
    const ev = toEvidenceCandidate(event)
    if (!ev) return
    const res = acp.append(ev)
    // MVP：审计落 acp audit 表（TODO v0.1: 若 harness 收录 acp/* 词汇再 append session event）
    if (config.debug) {
      ctx.logger?.debug?.(`[acp] ingest ${res.decision} id=${res.id}`)
    }
  })

  // --- Consumer 2：agent/pre-step → Context Composer 注入（bounded） ---
  // waterfall：必须 next() 保留后续策略链（DSH 插件核心规则）。
  ctx.on('agent/pre-step', (meta, next) => {
    try {
      const scopeId = scopeOf(ctx)
      const budget = config.hotTokens ?? 300
      const result = acp.recall({
        scopeId,
        targetDomain: 'work',
        maxTokens: budget,
        limit: config.recallLimit ?? 10,
      })
      if (result.items.length > 0) {
        // source-labelled plugin message：作为 untrusted historical context 注入
        // （MemOS DSH adapter 验证过的范式），不伪装成 System Instruction。
        const body = result.items
          .map((ev) => `[acp:evidence ${ev.id} | src=${ev.sourceClass} | domain=${ev.claimDomain}] ${ev.content}`)
          .join('\n')
        if (typeof ctx.send === 'function') {
          ctx.send({
            role: 'user',
            content: body,
            meta: { acp: { source: 'adaptive-context', tokens: result.tokens, dropped: result.dropped.length } },
          })
        } else if (typeof ctx.app === 'function' && ctx.app.session?.send) {
          ctx.app.session.send({ role: 'user', content: body })
        }
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

// --- 内部工具 ---

function isEvidenceWorthy(event) {
  const type = event?.type ?? ''
  return [
    'user/message',
    'assistant/message',
    'tool/result',
    'user/correction',
  ].includes(type) || /^(user|assistant|tool|turn)\//.test(type)
}

function toEvidenceCandidate(event) {
  const type = event?.type ?? ''
  const text = extractText(event)
  if (!text) return null

  let sourceClass = 'agent_authored'
  let claimDomain = 'experience'
  let authority = 'single_observation'
  if (type.startsWith('user/')) {
    sourceClass = 'user_input'
    claimDomain = 'user_fact'
    authority = 'user_explicit'
  }
  if (type.startsWith('tool/')) {
    sourceClass = 'external_tool'
    claimDomain = 'external_fact'
    authority = 'external_information'
  }
  if (type === 'user/correction') {
    sourceClass = 'user_correction'
    claimDomain = 'user_preference'
    authority = 'user_correction'
  }
  return {
    sourceClass,
    claimDomain,
    authority,
    confidence: sourceClass === 'user_input' || sourceClass === 'user_correction' ? 1 : 0.5,
    durability: 0.5,
    sensitivity: 'private',
    content: text,
    contentHash: hashHex(text),
    sourceRef: { sessionEventId: event.id ?? event.sessionEventId },
    sessionType: event.sessionType ?? 'root',
    agentKey: event.agentKey ?? '',
    observedAt: new Date().toISOString(),
  }
}

function extractText(event) {
  return event?.content ?? event?.text ?? event?.message?.content ?? ''
}

function scopeOf(ctx) {
  // MVP：workspace 作用域按 cwd（对齐 memento workspaceKey 语义）
  return ctx?.session?.cwd ?? ctx?.cwd ?? 'user-global'
}
