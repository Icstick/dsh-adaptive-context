// src/index.mjs — dsh-adaptive-context function plugin 入口。
//
// 三角色 seam（对齐 dsh-memento 已验证模式）：
//   Service Definition → ctx.acp（service.mjs）
//   Provider           → SQLite Evidence Ledger（store.mjs）
//   Consumer           → DSH hooks 接入（本文件）
//
// DSH seam 映射（2026-08-26 真实契约校准，参照 memos DSH adapter + hooks-codex）：
//   agent/pre-step → waterfall：await next() 拿下游决策，返回 { kind: 'enter', messages: [...决策, 注入] }
//                    （必须返回 PreStepDecision！返回 undefined 会让 DSH 读 undefined.kind 崩 turn）
//   session/event  → (session, event) 两参数签名；event.type 为 agent/inbox/spliced、turn/* 等
//   turn/end       → 占位（MVP 不做 background consolidation）

import { openEvidenceLedger } from './store.mjs'
import { createAcpService } from './service.mjs'
import { createExpression } from './expression.mjs'
import { isEvidenceWorthy, toEvidenceCandidate, textOfInboxMessage } from './extract.mjs'
import { compose, renderSourceLabelled } from './composer.mjs'
import { createMemosProvider } from './providers/memos.mjs'
import { CLAIM_DOMAINS } from './constants.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'adaptive-context'
export const inject = []

export const Config = z.object({
  ledgerDir: z.string(),
  hotTokens: z.number().step(1).min(1).default(300),
  recallLimit: z.number().step(1).min(1).default(20),
  targetDomain: z.union(CLAIM_DOMAINS.map(domain => z.const(domain))).default('work'),
  debug: z.boolean().default(false),
  // MemOS RecallProvider（T3 P0-3）：semantic 分来源，MVP 实验接入
  memosBaseUrl: z.string().default('http://127.0.0.1:18801'),
  memosEnabled: z.boolean().default(true),
})

/**
 * 作用域解析（对齐 dsh-memento 语义：user-global / workspace）。
 * MVP：单 workspace 简化，固定 user-global；v0.1 按 ctx session cwd 派生 workspace scope。
 * @param {object} ctx
 * @returns {string} scopeId（SCOPES 之一）
 */
function scopeOf(ctx) {
  return 'user-global'
}

/** 从 pre-step 决策的 messages 提取用户文本（memos bridge 同款思路）。 */
function userTextFromMessages(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const msg of messages) {
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}

/**
 * 把 MemOS RecallCandidate[] 归一化为 composer 候选（T3 P0-3，COMPOSER.md §4 semantic 来源）。
 *
 * 映射规则：
 *   - id：provider 已带 'memos:' 命名空间前缀时原样保留，否则补前缀（防双前缀/无前缀）
 *   - providerScore = score：compose 在 hasProvider=true 时作为 semantic 分量（0.32 权重）
 *   - claimDomain 固定 'experience'：MemOS 内容全是 untrusted historical data
 *     （PROVIDERS.md §2.5：MemOS 可作 recall Provider，但不能作为真相源或治理层）
 *   - state 'active' + scopeId：通过 readGuard 资格（scope/state 过滤）
 *   - confidence 0.5：最低置信度（不宣称权威；五铁律：Confidence is not authority）
 * @param {object[]} hits - provider.recall() 返回的 RecallCandidate[]
 * @param {string} scopeId - SCOPES 之一（与 ledger 候选同 scope，保证 readGuard 放行）
 * @returns {object[]} composer 候选
 */
export function normalizeMemosHits(hits, scopeId) {
  if (!Array.isArray(hits)) return []
  return hits
    .filter((h) => h !== null && typeof h === 'object')
    .map((h) => ({
      id: typeof h.id === 'string' && h.id.startsWith('memos:') ? h.id : 'memos:' + (h.id ?? ''),
      content: typeof h.content === 'string' ? h.content : '',
      score: typeof h.score === 'number' ? h.score : 0,
      providerScore: typeof h.score === 'number' ? h.score : 0,
      sourceProvider: 'memos',
      claimDomain: 'experience',
      state: 'active',
      scopeId,
      confidence: 0.5,
    }))
}

export function apply(ctx, config = {}) {
  const ledger = openEvidenceLedger({ dir: config.ledgerDir })
  const acp = createAcpService({ ledger })
  const expression = createExpression({ ledger })

  // --- Service Definition：注册 ctx.acp ---
  // T6 桥：acp.requestPromotion(candidate, ctx) 兼容两参调用（C 组接缝）。
  // approval 走 withService 可选模式——inject 列表不加 'approval'。
  ctx.provide('acp', {
    ...acp,
    requestPromotion: (candidate, ctxArg) => expression.requestPromotion(candidate, ctxArg ?? ctx),
  })

  // --- Consumer 1：session/event → Evidence ingestion ---
  // 真实签名 (session, event)；只消费值得摄入的 durable events，幂等 append。
  // fail-open：摄入异常只记日志，绝不阻断事件派发/turn。
  ctx.on('session/event', (session, event) => {
    try {
      if (!isEvidenceWorthy(event)) return
      const ev = toEvidenceCandidate(event, {
        scopeId: scopeOf(ctx),
        sessionId: session?.id ?? '',
        agentKey: event.agentKey ?? '',
        sessionType: event.sessionType ?? 'root',
      })
      if (!ev) return
      const res = acp.append(ev)
      // MVP：审计落 acp audit 表（TODO v0.1: 若 harness 收录 acp/* 词汇再 append session event）
      if (config.debug) {
        ctx.logger?.debug?.('[acp] ingest ' + res.decision + ' id=' + res.id)
      }
    } catch (err) {
      ctx.logger?.warn?.('[acp] ingest error: ' + (err && err.message))
    }
  })

  // --- Consumer 2：agent/pre-step → Context Composer 注入（bounded） ---
  // 契约（2026-08-26 校准）：
  //   payload = { agent, messages, turn, step, signal }
  //   handler 必须返回 PreStepDecision（{kind:'reject'} | {kind:'enter', messages}）。
  //   先 await next() 拿下游决策；仅在 step===1 且下游 enter 时把 source-labelled
  //   注入消息追加到决策 messages 尾部（memos DSH adapter 验证过的范式）。
  //   fail-open：任何异常都返回原决策或合法空决策，ACP 故障不得阻断 turn。
  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
      if (payload?.step !== 1) return decision
      if (!decision || decision.kind !== 'enter') return decision
      const userText = userTextFromMessages(decision.messages)
      const scopeId = scopeOf(ctx)
      const ledgerCandidates = ledger.query({
        scopeId,
        state: 'active',
        limit: config.recallLimit ?? 20,
      }).items

      // —— Provider recall（T3 P0-3）：MemOS 接入，semantic 分来源（COMPOSER.md §4）——
      // hasProvider 语义：memosEnabled 即视为 Provider 在线（provider 自适应权重切换）；
      // recall 已 fail-open（[]），Provider 故障不阻断 turn，也不额外降级 hasProvider。
      let memoCandidates = []
      let hasProvider = false
      if (config.memosEnabled) {
        const provider = createMemosProvider({ baseUrl: config.memosBaseUrl })
        const hits = await provider.recall({ text: userText, limit: config.recallLimit ?? 20 })
        memoCandidates = normalizeMemosHits(hits, scopeId)
        hasProvider = true
      }

      const result = compose([...ledgerCandidates, ...memoCandidates], {
        query: userText,
        scopeId,
        targetDomain: config.targetDomain ?? 'work',
        hasProvider,
        maxTokens: config.hotTokens ?? 300,
      })
      if (result.items.length === 0) return decision
      // source-labelled plugin message：untrusted historical context，
      // 不伪装成 System Instruction（MemOS DSH adapter 验证过的范式）。
      const body = renderSourceLabelled(result.items)
      const ours = createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'plugin', plugin: 'dsh-adaptive-context', form: 'recall' },
      })
      return { kind: 'enter', messages: [...decision.messages, ours] }
    } catch (err) {
      // fail-open：返回已有决策；若 next() 本身抛异常则给出合法空决策
      ctx.logger?.warn?.('[acp] composer error: ' + (err && err.message))
      if (decision) return decision
      return { kind: 'enter', messages: [] }
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