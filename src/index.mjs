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

import path from 'node:path'
import { openEvidenceLedger } from './store.mjs'
import { createAcpService } from './service.mjs'
import { createExpression } from './expression.mjs'
import { isEvidenceWorthy, toEvidenceCandidate } from './extract.mjs'
import { compose, renderSourceLabelled } from './composer.mjs'
import { createProviderRegistry } from './providers/registry.mjs'
import { createLlmRouter } from './providers/llm-router.mjs'
import { createConsolidator } from './consolidate.mjs'
import { createViews } from './views.mjs'
import { evaluateCandidate } from './policy.mjs'
import {
  CLAIM_DOMAINS, CONSOLIDATION_MIN_EVIDENCE, CONSOLIDATION_MIN_TURNS,
} from './constants.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  // RecallProviders 注册表（M3 A1）：多记忆源并行召回；缺省（undefined）自动用
  // memosBaseUrl/memosEnabled 构造默认 memos 项（向后兼容，M2 行为不变）；
  // 显式 [] 表示不启用任何 recall provider。
  // 注：用 z.any() 走透传——schemastery 3.18 无 true-optional 数组（absent 会默认 []，
  // 破坏"缺省→默认 memos 项"语义）；形状校验由 registry 的 normalizeDescriptor 防御性兜底。
  recallProviders: z.any(),
  // LLM 任务路由（M3 A2）：{task: {provider, model, fallback?, timeoutMs, maxTokens}}；
  // consolidation 任务缺省从 consolidationProvider/consolidationModel 映射（向后兼容）。
  llmTasks: z.any(),
  // Materialized view 启动校验（M3 C3）：apply 时 verifyView('expression')，
  // 与 candidate 重放不一致自动 rebuild（默认 true；false = 只校验不重建）。
  startupRebuild: z.boolean().default(true),
  // Background consolidation（可选：缺省用 constants 默认；llm 路由缺省则走规则兜底）
  consolidationMinEvidence: z.number().step(1).min(1),
  consolidationMinTurns: z.number().step(1).min(1),
  consolidationProvider: z.string(),
  consolidationModel: z.string(),
  consolidationMaxTokens: z.number().step(1).min(1),
  consolidationTimeoutMs: z.number().step(1).min(1),
  // M3 B3：guarded auto promotion + materialized view（EXPRESSION.md §8：默认全人工）
  autoPromote: z.boolean().default(false), // master switch：true 才走 policy 自动提升路径
  viewsDir: z.string(),                    // 可选：materialized view 目录（缺省 ledgerDir/views）
  policyConfig: z.any(),                   // 可选：policy 覆盖（minEvents/maxEvidenceAgeDays…；
                                           // floors 收口由 policy.mjs 保证，只允许更严）
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
 * 把 RecallCandidate[] 归一化为 composer 候选（M3 A3 多源，COMPOSER.md §4 semantic 来源）。
 *
 * 映射规则：
 *   - id：已带 '<sourceProvider>:' 命名空间前缀时原样保留，否则补前缀（防双前缀/无前缀）
 *   - providerScore = score：compose 在 hasProvider=true 时作为 semantic 分量（0.32 权重）
 *   - claimDomain 固定 'experience'：Provider 召回内容全是 untrusted historical data
 *     （PROVIDERS.md §2.5：Provider 可作 recall 来源，但不能作为真相源或治理层）
 *   - state 'active' + scopeId：通过 readGuard 资格（scope/state 过滤）
 *   - confidence 0.5：最低置信度（不宣称权威；五铁律：Confidence is not authority）
 * @param {object[]} hits - provider.recall() 返回的 RecallCandidate[]（含 sourceProvider）
 * @param {string} scopeId - SCOPES 之一（与 ledger 候选同 scope，保证 readGuard 放行）
 * @returns {object[]} composer 候选
 */
export function normalizeRecallHits(hits, scopeId) {
  if (!Array.isArray(hits)) return []
  return hits
    .filter((h) => h !== null && typeof h === 'object')
    .map((h) => {
      const pid = typeof h.sourceProvider === 'string' ? h.sourceProvider : ''
      const prefix = pid ? pid + ':' : ''
      return {
        id: typeof h.id === 'string' && h.id.startsWith(prefix) ? h.id : prefix + (h.id ?? ''),
        content: typeof h.content === 'string' ? h.content : '',
        score: typeof h.score === 'number' ? h.score : 0,
        providerScore: typeof h.score === 'number' ? h.score : 0,
        sourceProvider: pid,
        claimDomain: 'experience',
        state: 'active',
        scopeId,
        confidence: 0.5,
      }
    })
}

/**
 * MemOS 专用归一化（T3 兼容导出）：所有命中强制标 sourceProvider='memos'。
 * @param {object[]} hits
 * @param {string} scopeId
 * @returns {object[]} composer 候选
 */
export function normalizeMemosHits(hits, scopeId) {
  const labeled = Array.isArray(hits)
    ? hits.map((h) => (h !== null && typeof h === 'object' ? { ...h, sourceProvider: 'memos' } : h))
    : hits
  return normalizeRecallHits(labeled, scopeId)
}

/**
 * M3 B3：materialized view 行 → composer 候选（防御性归一化，fail-open）。
 * view 行本身已带 evidence 快照字段（views.mjs buildExpressionRows），此处只兜底缺省值，
 * 保证任意手写/旧版 view 文件也能安全进入 compose（readGuard 需要 scopeId/state/authority）。
 * @param {object} r - view 行
 * @param {string} fallbackScopeId - 行缺 scopeId 时的回退
 * @returns {object} composer 候选
 */
export function viewRowToCandidate(r, fallbackScopeId) {
  return {
    id: r.id,
    content: r.content,
    sourceClass: r.sourceClass ?? 'evidence',
    claimDomain: r.claimDomain ?? 'style',
    authority: r.authority ?? 'user_explicit',
    confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
    durability: typeof r.durability === 'number' ? r.durability : 0.5,
    sensitivity: r.sensitivity ?? 'private',
    state: 'active',
    scopeId: r.scopeId ?? fallbackScopeId,
    observedAt: r.observedAt,
    sourceRef: r.sourceRef ?? {},
    contentHash: r.contentHash,
    evidenceIds: r.evidenceIds,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
  }
}

export function apply(ctx, config = {}) {
  // ledgerDir 兜底解析（与 openEvidenceLedger 同款：DSH_HOME 环境变量不可靠，配置优先）
  const ledgerDir = config.ledgerDir ?? path.join(process.env.DSH_HOME || '', 'acp')
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  const acp = createAcpService({ ledger, startupRebuild: config.startupRebuild ?? true })

  // --- M3 B3：materialized view（views are rebuildable）---
  // 视图目录缺省 ledgerDir/views；verify/rebuild 与 expression 重写同源（同 scope 投影）。
  const views = createViews({
    dir: config.viewsDir ?? path.join(ledgerDir, 'views'),
    ledger,
    candidateStore: ledger.candidateStore,
    scopeId: scopeOf(ctx),
  })

  const expression = createExpression({
    ledger,
    candidateStore: ledger.candidateStore,
    auditStore: ledger.auditStore,
    views,
    scopeId: scopeOf(ctx),
  })

  // --- Service Definition：注册 ctx.acp ---
  // T6 桥：acp.requestPromotion(candidate, ctx) 兼容两参调用（C 组接缝）。
  // approval 走 withService 可选模式——inject 列表不加 'approval'。
  ctx.provide('acp', {
    ...acp,
    requestPromotion: (candidate, ctxArg) => expression.requestPromotion(candidate, ctxArg ?? ctx),
  })

  // --- M3 C3：启动校验（views are rebuildable）---
  // verifyView 失配且 startupRebuild=true → 自动重建（含首启未构建视图的首次物化）；
  // 失败仅告警，绝不阻断插件启动。
  try {
    acp.startupVerify()
  } catch (err) {
    ctx.logger?.warn?.('[acp] startup verify failed: ' + (err && err.message))
  }

  // --- Background consolidation：LLM 用 withService 可选模式获取 ---
  function resolveLlm() {
    try { return ctx.get('llm') } catch { return undefined }
  }

  const minEvidence = config.consolidationMinEvidence ?? CONSOLIDATION_MIN_EVIDENCE
  const minTurns = config.consolidationMinTurns ?? CONSOLIDATION_MIN_TURNS

  // M3 A1：Recall Provider 注册表（多记忆源；缺省用 memosBaseUrl/memosEnabled 构造默认
  // memos 项，向后兼容，M2 行为不变）
  const registry = createProviderRegistry({
    recallProviders: config.recallProviders,
    defaults: {
      memosBaseUrl: config.memosBaseUrl,
      memosEnabled: config.memosEnabled,
    },
  })

  // M3 A2：LLM 任务路由表——llmTasks 显式配置优先；consolidation 任务缺省从
  // consolidationProvider/consolidationModel 映射（向后兼容）。
  function resolveLlmTasks() {
    const raw = config.llmTasks
    const tasks = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
    if (!tasks.consolidation) {
      const provider = config.consolidationProvider
      const model = config.consolidationModel
      if (provider && model) {
        tasks.consolidation = {
          provider,
          model,
          timeoutMs: config.consolidationTimeoutMs ?? 30000,
          maxTokens: config.consolidationMaxTokens ?? 1024,
        }
      }
    }
    return tasks
  }

  const llmRouter = createLlmRouter({ tasks: resolveLlmTasks(), resolveLlm })

  /** llm 缺失或 consolidation 无路由 → null（consolidator 走规则兜底） */
  function buildLlmCall() {
    if (!resolveLlm()) return null
    if (!llmRouter.getRoute('consolidation')) return null
    return (userText, system) => llmRouter.callFor('consolidation', userText, system)
  }

  // T6：已发起过审批请求的 evidence id（防同一候选重复弹窗）
  const promotionRequested = new Set()

  // M3 B3：policy 装配——policyConfig 覆盖（floors 收口由 policy.mjs 保证，只允许更严）；
  // autoPromote 主开关在插件 Config 层（Config.autoPromote），policyConfig 不能覆盖它。
  const policyConfig = {
    ...(config.policyConfig && typeof config.policyConfig === 'object' ? config.policyConfig : {}),
    autoPromote: config.autoPromote === true,
  }
  const policyEvaluate = (args) => evaluateCandidate({ ...args, config: policyConfig })

  const consolidate = createConsolidator({
    ledger,
    scopeId: scopeOf(ctx),
    llmCall: buildLlmCall(),
    minEvidence,
    minTurns,
    logger: ctx.logger,
    // M3 B3：guarded auto promotion——consolidation 产出 style 候选 → policy → autoPromote
    candidateStore: ledger.candidateStore,
    auditStore: ledger.auditStore,
    policyEvaluate,
    autoPromote: (candidate, policyResult) => expression.autoPromote(candidate, policyResult),
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
      // 审计：已落 acp audit 表（M3 C1）；harness 若收录 acp/* 词汇可再 append session event
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

      // —— M3 B3：materialized view 注入（expression section hot path）——
      // readExpression() 有内容 → 注入 style 候选（promoted 候选 → view 行，快照自足）；
      // 无内容 → 维持现状（ledger 注入）。与 ledger 同 id 候选由 composer dedup 去重，
      // 已 promoted 证据即使被 supersede（ledger 不再 active）仍由 view 兜底注入。
      const viewRows = views.readExpression()
      const viewCandidates = Array.isArray(viewRows) && viewRows.length > 0
        ? viewRows
            .filter((r) => r && typeof r.content === 'string' && r.content.length > 0)
            .map((r) => viewRowToCandidate(r, scopeId))
        : []

      // —— Provider recall（M3 A1）：registry 并行召回，semantic 分来源（COMPOSER.md §4）——
      // hasProvider = registry 有启用 provider（provider 自适应权重切换）；
      // recallAll 已 fail-open（[]），Provider 故障不阻断 turn，也不额外降级 hasProvider。
      const enabledProviders = registry.listRecallProviders()
      const hasProvider = enabledProviders.length > 0
      let recallCandidates = []
      if (hasProvider) {
        const hits = await registry.recallAll({ text: userText, limit: config.recallLimit ?? 20 })
        recallCandidates = normalizeRecallHits(hits, scopeId)
      }
      // M3 A3：多源融合权重（缺省 1.0）
      const providerWeights = {}
      for (const p of enabledProviders) providerWeights[p.id] = p.weight ?? 1

      const result = compose([...ledgerCandidates, ...viewCandidates, ...recallCandidates], {
        query: userText,
        scopeId,
        targetDomain: config.targetDomain ?? 'work',
        hasProvider,
        providerWeights,
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

  // --- dispose：bounded best-effort drain（M4 R1，对齐 MemOS 5s 窗口） ---
  // consolidation 在途任务最多等 5s 排空（awaitIdle），超时直接关库（SQLite WAL 保证一致性）。
  ctx.effect(() => () => {
    const DRAIN_MS = 5000
    const closeLedger = () => {
      try { ledger.close() } catch { /* already closed */ }
    }
    if (!consolidate.isPending()) { closeLedger(); return }
    const timer = setTimeout(closeLedger, DRAIN_MS)
    timer.unref?.()
    consolidate.awaitIdle()
      .then(() => { clearTimeout(timer); closeLedger() })
      .catch(() => { clearTimeout(timer); closeLedger() })
  })
}
