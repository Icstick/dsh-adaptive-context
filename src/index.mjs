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
//   turn/end       → session/event 内 event.type==='turn/end' 时入队 background consolidation

import { openEvidenceLedger } from './store.mjs'
import { createAcpService } from './service.mjs'
import { createExpression } from './expression.mjs'
import { isEvidenceWorthy, toEvidenceCandidate } from './extract.mjs'
import { compose, renderSourceLabelled } from './composer.mjs'
import { createMemosProvider } from './providers/memos.mjs'
import { createConsolidator } from './consolidate.mjs'
import {
  CLAIM_DOMAINS, CONSOLIDATION_MIN_EVIDENCE, CONSOLIDATION_MIN_TURNS,
} from './constants.mjs'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'adaptive-context'
export const inject = ['llm']

export const Config = z.object({
  ledgerDir: z.string(),
  hotTokens: z.number().step(1).min(1).default(300),
  recallLimit: z.number().step(1).min(1).default(20),
  targetDomain: z.union(CLAIM_DOMAINS.map(domain => z.const(domain))).default('work'),
  debug: z.boolean().default(false),
  // MemOS RecallProvider（T3 P0-3）：semantic 分来源，MVP 实验接入
  memosBaseUrl: z.string().default('http://127.0.0.1:18801'),
  memosEnabled: z.boolean().default(true),
  // Background consolidation（可选：缺省用 constants 默认；llm 路由缺省则走规则兜底）
  consolidationMinEvidence: z.number().step(1).min(1),
  consolidationMinTurns: z.number().step(1).min(1),
  consolidationProvider: z.string(),
  consolidationModel: z.string(),
  consolidationMaxTokens: z.number().step(1).min(1),
  consolidationTimeoutMs: z.number().step(1).min(1),
})

/**
 * 作用域解析（对齐 dsh-memento 语义：user-global / workspace）。
 * MVP：单 workspace 简化，固定 user-global；v0.1 按 ctx session cwd 派生 workspace scope。
 * @param {object} ctx
 * @returns {string} scopeId（SCOPES 之一）
 */
function scopeOf(_ctx) {
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

/**
 * 用 DSH llm 服务做一次纯文本生成（consolidation 专用）。
 * 参考 @deepseek-ai/dsh-session-title-llm 的 BlockAssembler 流式收集范式。
 * 失败（finish 非 stop / 无文本）向上抛——由 consolidate.mjs 的 deriveViaLlm 重试/丢弃。
 */
async function callLlmText(llm, { provider, model, maxTokens, timeoutMs }, userText, system) {
  const messages = [createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: 'dsh-adaptive-context', form: 'consolidation' },
  })]
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider,
      model,
      messages,
      system,
      maxTokens,
      temperature: 0,
      signal: controller.signal,
      purpose: 'compaction', // GenerateOptions 联合类型只有 compaction|session-title
    })) {
      assembler.push(chunk)
    }
    const finish = assembler.finish
    if (finish && finish.reason?.kind && finish.reason.kind !== 'stop') {
      throw new Error('acp consolidation llm finished with ' + finish.reason.kind)
    }
    const text = assembler.blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) throw new Error('acp consolidation llm produced no text')
    return text
  } finally {
    if (timer) clearTimeout(timer)
  }
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

  // --- Background consolidation：LLM 用 withService 可选模式获取 ---
  function resolveLlm() {
    try { return ctx.get('llm') } catch { return undefined }
  }

  const minEvidence = config.consolidationMinEvidence ?? CONSOLIDATION_MIN_EVIDENCE
  const minTurns = config.consolidationMinTurns ?? CONSOLIDATION_MIN_TURNS
  const consolidationMaxTokens = config.consolidationMaxTokens ?? 1024
  const consolidationTimeoutMs = config.consolidationTimeoutMs ?? 30000

  /** llm 缺失或未配置 provider/model → null（consolidator 走规则兜底） */
  function buildLlmCall() {
    const llm = resolveLlm()
    const provider = config.consolidationProvider
    const model = config.consolidationModel
    if (!llm || !provider || !model) return null
    return (userText, system) => callLlmText(llm, {
      provider, model, maxTokens: consolidationMaxTokens, timeoutMs: consolidationTimeoutMs,
    }, userText, system)
  }

  // T6：已发起过审批请求的 evidence id（防同一候选重复弹窗）
  const promotionRequested = new Set()

  const consolidate = createConsolidator({
    ledger,
    scopeId: scopeOf(ctx),
    llmCall: buildLlmCall(),
    minEvidence,
    minTurns,
    logger: ctx.logger,
  })

  // llm 服务重挂载时重建调用闭包（withService 模式，踩坑清单第 5 条）
  ctx.on('internal/service', (name) => {
    if (name === 'llm') consolidate.setLlmCall(buildLlmCall())
  })

  // --- Consumer 1：session/event → Evidence ingestion + turn/end 入队 ---
  // 真实签名 (session, event)；只消费值得摄入的 durable events，幂等 append。
  // fail-open：摄入异常只记日志，绝不阻断事件派发/turn。
  ctx.on('session/event', (session, event) => {
    try {
      // turn/end：入队 background consolidation（fire-and-forget，不 await）
      if (event?.type === 'turn/end') {
        consolidate.enqueue()
        return
      }
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

      // —— T6 style 审批门（2026-08-27 架构修正）——
      // consolidation 后台无 agent，只能把 style 候选标 pending_promotion；
      // 这里 pre-step 有 payload.agent，对未请求过的 pending 候选 fire-and-forget
      // 发起 approval.request（不 await，审批面板异步弹出，不阻塞 turn）。
      for (const cand of expression.collectPendingPromotions()) {
        if (promotionRequested.has(cand.id)) continue
        promotionRequested.add(cand.id)
        expression.requestPromotion(
          { id: cand.id, content: cand.content, claimDomain: cand.claimDomain, sourceRef: cand.sourceRef },
          ctx,
          payload.agent,
        ).catch(() => {})
      }

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

  // --- dispose：先关 ledger（consolidation 在途任务由 enqueue 的 catch 兜底） ---
  ctx.effect(() => () => {
    ledger.close()
  })
}
