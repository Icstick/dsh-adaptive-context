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
import { homedir as osHomedir } from 'node:os'
import { openEvidenceLedger } from './store.mjs'
import { createAcpService } from './service.mjs'
import { createExpression } from './expression.mjs'
import { isEvidenceWorthy, toEvidenceCandidate } from './extract.mjs'
import { isNeverApprovalPolicy } from './expression.mjs'
import { maybeDraft } from './feedback.mjs'
import { makeAcpQueryTool } from './tools.mjs'
import { compose, renderSourceLabelled, jaccard, CROSS_SESSION_POLICIES } from './composer.mjs'

/** B8（2026-09-12）：会话级上一步注入集（turnover 观测用；纯观测，不参与注入逻辑）。 */
const lastInjectedBySession = new Map()
import { createProviderRegistry } from './providers/registry.mjs'
import { createLlmRouter } from './providers/llm-router.mjs'
import { createConsolidator } from './consolidate.mjs'
import { createViews } from './views.mjs'
import { evaluateCandidate } from './policy.mjs'
import {
  CLAIM_DOMAINS, CONSOLIDATION_MIN_EVIDENCE, CONSOLIDATION_MIN_TURNS,
} from './constants.mjs'
import { isActionFlowObservation, preferenceFilterAllows } from './governance.mjs'
import { writeRulesDir } from './rules.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'adaptive-context'
export const inject = ['llm', 'tools']

export const Config = z.object({
  ledgerDir: z.string(),
  // P0-5（2026-09-02）：默认对齐 MVP_TOTAL_BUDGET(900)。此前默认 300 但 composer 从不读取，
  // 实际预算一直是 quota 合计 900；现在配置真的生效，默认值必须对齐否则等于悄悄砍掉 2/3 注入面。
  hotTokens: z.number().step(1).min(1).default(900),
  /** P1-1（2026-09-02）：observation 注入开关。**默认 false = 冻结**（用户 2026-09-02 决策：
   *  先冻结、修好失败吞批止血，两个月内无消费场景则删表与 consolidate 模块）。
   *  接线已就位，打开即用，无需改代码。 */
  observationInjection: z.boolean().default(false),
  // T2（2026-09-07）：observation 注入权威闸门——只放行高权威蒸馏轨
  // （user_explicit/user_correction 源）；single_observation 等低权威不进常规注入（留账本供 acp_query）。
  // 语义：开闸不是全量开——先让"你的纠正/明确偏好"稳定可达，再观察是否需要放宽。
  observationAuthorities: z.array(z.string()).default(['user_explicit', 'user_correction']),
  recallLimit: z.number().step(1).min(1).default(20),
  // DEPRECATED（2026-09-07，PLAN-S2 P3）：读侧矩阵列已按候选自身 claimDomain 自然分组，
  // 本键不再影响注入（保留键位仅为兼容存量配置/settings 页；新语义无需配置）。
  targetDomain: z.union(CLAIM_DOMAINS.map(domain => z.const(domain))).default('work'),
  // 跨会话注入闸门（2026-08-30 决策 D1，ISSUES-INJECTION-ISOLATION.md F7）：
  //   non-instructional（默认）——跨会话只注入非指令性内容（agent_authored/external_tool…），
  //                             user_input/user_correction 跨会话不注入；
  //   all —— 跨会话全类别注入（utility×0.3 惩罚 + session provenance 标记）；
  //   none —— 不注入任何跨会话内容。
  crossSessionPolicy: z.union(CROSS_SESSION_POLICIES.map(p => z.const(p))).default('non-instructional'),
  // 融合策略（2026-09-09）：weighted = 语义/词面加权求和（历史行为，默认）；
  // rrf = 两路各自排序后 Reciprocal Rank Fusion——异构分数不做尺度相加。
  // 默认不切换：排序变化需要先有对照数据（见 docs/design/COMPOSER.md §4.1）。
  fusion: z.union([z.const('weighted'), z.const('rrf')]).default('weighted'),
  // 子代理会话降权（2026-08-30 决策 D2）：session.header.origin==='subagent' 时
  // kind='user' 的消息（父 agent 派发 prompt）降权为 agent_inference（记录但 quarantine），
  // 避免父任务书冒充用户指令。
  subagentDowngrade: z.boolean().default(true),
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
  consolidationMaxBatch: z.number().step(1).min(1), // P0-6：单批证据上限透传（默认 constants 40）
  // M3 B3：guarded auto promotion + materialized view（EXPRESSION.md §8：默认全人工）
  autoPromote: z.boolean().default(false), // master switch：true 才走 policy 自动提升路径
  viewsDir: z.string(),                    // 可选：materialized view 目录（缺省 ledgerDir/views）
  // T4 M4.1b（2026-09-07）：规则视图目录（人类可读 rules/ 视图，可从 ledger 重建；
  // 缺省 ~/.dsh/rules——跨 workspace/profile 全局）。patch/settings 级配置。
  rulesDir: z.string(),
  // S1 P2（2026-09-04）：section quota 覆盖（如 { user_model: 800 }）。
  // 不配置 = composer 用 MVP_SECTION_QUOTA（user_model 180/…）；总预算仍由 hotTokens 控制。
  sectionQuota: z.any(),
  policyConfig: z.any(),                   // 可选：policy 覆盖（minEvents/maxEvidenceAgeDays…；
                                           // floors 收口由 policy.mjs 保证，只允许更严）
  // 阶段 2.3（2026-09-09）：一次性任务指令不进 user_model 画像注入。
  //   off    = 关闭判别
  //   shadow = 只统计不生效（默认——先观察注入差异再切）
  //   on     = 生效过滤
  preferenceEphemeralFilter: z.string().default('shadow'),
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

// --- S1 P7（2026-09-05，B9 v0.3 P7）：注入调度器接线（dsh-inject-scheduler）---
// 契约（用户拍板方案 A：主动上报）：
//   · 调度器是**可选项**——永不因它缺失/故障阻断 ACP（fail-open，与 composer 同纪律）；
//   · 段注册经 withService 等就绪（bundle 加载顺序不定；internal/service 模式已由 WC 实证，
//     本仓库此前无 withService 工具，抄 WC 同款实现）；
//   · 上报 = 注入文本生成后记录实际字符数（renderSourceLabelled 的 body.length，字符级精确）；
//   · sessionId 空串不传 → 调度器落 global 槽（usage 表 schema 拒绝空串，M1 定）。

/** 本插件在注入调度器注册表中的段 key */
export const ACP_SECTION_KEY = 'acp.composer'

/** 可选服务就绪即调用（一次 ctx.get + internal/service 订阅等就绪；cordis 4 兼容） */
function withService(ctx, serviceName, fn) {
  const existing = ctx.get(serviceName)
  if (existing !== undefined && existing !== null) {
    fn(existing)
    return
  }
  const off = ctx.on('internal/service', (name) => {
    if (name !== serviceName) return
    const service = ctx.get(serviceName)
    if (service !== undefined && service !== null) {
      off()
      fn(service)
    }
  })
}

/** 注册 acp.composer 段（幂等覆盖；budget=hotTokens、unit=tokens——ACP 配额是 token 口径） */
export function registerAcpSection(ctx, config = {}) {
  withService(ctx, 'injectScheduler', (sched) => {
    if (!sched || typeof sched.registerSection !== 'function') return
    void sched.registerSection({
      key: ACP_SECTION_KEY,
      plugin: 'dsh-adaptive-context',
      order: 10,
      budgetChars: config.hotTokens ?? 900,
      unit: 'tokens',
      refresh: 'per-turn',
    }).catch((err) => {
      ctx.logger?.warn?.('[acp] section register failed: ' + (err instanceof Error ? err.message : String(err)))
    })
  })
}

/** 注入后上报实际注入量（fail-open：任何异常/缺失都静默降级，绝不阻断注入与 turn） */
export function reportInjectionToScheduler(ctx, sessionId, body) {
  try {
    if (typeof body !== 'string' || body.length === 0) return
    const sched = ctx.get('injectScheduler')
    if (!sched || typeof sched.recordUsage !== 'function') return
    void sched.recordUsage({
      ...(sessionId ? { sessionId } : {}),
      section: ACP_SECTION_KEY,
      injectedChars: body.length,
    }).catch((err) => {
      ctx.logger?.warn?.('[acp] usage report failed: ' + (err instanceof Error ? err.message : String(err)))
    })
  } catch (err) {
    ctx.logger?.warn?.('[acp] usage report degraded: ' + (err instanceof Error ? err.message : String(err)))
  }
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
    // 审计 H-5（2026-09-10）：与 views.mjs buildExpressionRows 同源——authority 缺失时
    // 降级为最弱可信档，不取最高信任（view 行是文件读入的外部输入，兜底必须 fail-safe）。
    authority: r.authority ?? 'single_observation',
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

/**
 * P1-1（2026-09-02）：Observation → composer 候选。
 *
 * 背景：observation 层（subject/predicate/text≤500 的浓缩认知）**写了从来没人读**——
 * 4 个查询接口在生产代码零调用方，8 条 observation 从未进过注入。而"索引常驻、正文按需"
 * 这套两段式注入需要的浓缩层，其实已经躺在库里。
 *
 * 权威定级（P3，2026-09-07，PLAN-S2 §8.3 修正）：observation 是蒸馏产物 ≠ 原始 evidence，
 * 其权威来自溯源证据（store.upsertObservation 写行时按 evidenceIds 聚合落 authority 列，
 * 见 store.deriveObservationAuthority）。行 authority 缺失/未知（旧行、无溯源）回退
 * single_observation——单次观察不得影响 user_preference/style（矩阵兜底）。
 * confidence 0.6：不宣称权威（五铁律：Confidence is not authority）。
 *
 * 注入面标签 sourceClass='observation'：只用于渲染标签与候选语义，不参与写入侧
 * sourceClass 枚举（那 5 值是写边界约束）。无 sessionId → 不过跨会话闸门、不罚降权
 * （稳定画像全局可见 = P3 放行语义；原始 user_input 的 F7 闸门不受影响）。
 */
export function observationToCandidate(o, fallbackScopeId) {
  const subject = String(o.subject ?? '').trim()
  const predicate = String(o.predicate ?? '').trim()
  const text = String(o.text ?? '').trim()
  const head = subject && predicate ? subject + ' ' + predicate + '：' : ''
  return {
    id: o.id,
    content: head + text,
    sourceClass: 'observation',
    claimDomain: o.claimDomain ?? 'experience',
    authority: o.authority ?? 'single_observation',
    confidence: 0.6,
    durability: 0.6,
    sensitivity: 'private',
    state: 'active',
    scopeId: o.scopeId ?? fallbackScopeId,
    observedAt: o.createdAt ?? o.observedAt,
    sourceRef: { kind: 'observation', evidenceIds: o.evidenceIds ?? [] },
    evidenceIds: o.evidenceIds ?? [],
    isObservation: true,
  }
}

/** 设置页配置命名空间（2026-08-30：设置 → 插件 → 插件配置；settings.yaml 持久化） */
export const SETTINGS_NAMESPACE = 'adaptive-context'

/**
 * settings 文档值合并进启动配置（settings 优先，缺失回退 Config 默认）。
 * 生效语义：设置页保存 → settings.yaml → 下次启动 apply 时覆盖（重启生效）。
 * @param {object} ctx - cordis context（settings 服务可能未注册）
 * @param {object} config - cordis Config（cordis.patch.yml）
 * @returns {object} 合并后的配置
 */
export function mergeSettingsIntoConfig(ctx, config) {
  let section = null
  try {
    const settings = ctx.get('settings')
    section = settings?.get?.(SETTINGS_NAMESPACE) ?? null
  } catch { /* settings 服务缺失 → 用 Config */ }
  if (!section || typeof section !== 'object') return { ...config }
  const merged = { ...config }
  for (const [key, value] of Object.entries(section)) {
    if (value !== undefined && value !== null) merged[key] = value
  }
  return merged
}

export function apply(ctx, config = {}) {
  // 设置页（settings.yaml）优先于 cordis.patch.yml；apply 时一次性合并（重启生效）
  config = mergeSettingsIntoConfig(ctx, config)
  // ledgerDir 兜底解析（与 openEvidenceLedger 同款：DSH_HOME 环境变量不可靠，配置优先）
  const ledgerDir = config.ledgerDir ?? path.join(process.env.DSH_HOME || '', 'acp')
  const ledger = openEvidenceLedger({ dir: ledgerDir })
  const acp = createAcpService({ ledger, startupRebuild: config.startupRebuild ?? true })

  // --- T4 M4.1b：rules/ 视图重建闭包（views are rebuildable）---
  // 启动全量重建 + /acp rule accept 后刷新共用；失败只 warn 不阻断插件。
  const rulesDir = config.rulesDir
    ?? path.join(process.env.DSH_HOME || path.join(osHomedir(), '.dsh'), 'rules')
  function refreshRulesView() {
    try {
      const activeRules = ledger.ruleStore.queryRules({ state: 'active', limit: 500 }).items
      const rulesRes = writeRulesDir(activeRules, { dir: rulesDir })
      ctx.logger?.debug?.('[acp] rules view rebuilt: files=' + rulesRes.files.length)
      return true
    } catch (err) {
      ctx.logger?.warn?.('[acp] acp:degraded rules_view_write_failed reason='
        + (err instanceof Error ? err.message : String(err)))
      return false
    }
  }
  refreshRulesView()

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

  // --- 设置页 namespace 注册（2026-08-30：设置 → 插件 → 插件配置 tab）---
  // 字段与 Config 同源但独立 schema：设置页写 settings.yaml，apply 时 mergeSettingsIntoConfig 覆盖。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, z.object({
      ledgerDir: z.string(),
      hotTokens: z.number().step(1).min(1),
      observationInjection: z.boolean(),
      observationAuthorities: z.array(z.string()), // T2：注入权威白名单（UI 逗号分隔文本写入）
      recallLimit: z.number().step(1).min(1),
      // deprecated：读侧已按候选自身 claimDomain 分组，不再影响注入（保留键位兼容）
      targetDomain: z.union(CLAIM_DOMAINS.map(domain => z.const(domain))),
      crossSessionPolicy: z.union(CROSS_SESSION_POLICIES.map(p => z.const(p))),
      fusion: z.union([z.const('weighted'), z.const('rrf')]),
      subagentDowngrade: z.boolean(),
      memosEnabled: z.boolean(),
      memosBaseUrl: z.string(),
      consolidationProvider: z.string(),
      consolidationModel: z.string(),
      autoPromote: z.boolean(),
      debug: z.boolean(),
    }))
  })

  // --- Service Definition：注册 ctx.acp ---
  // T6 桥：acp.requestPromotion(candidate, ctx) 兼容两参调用（C 组接缝）。
  // approval 走 withService 可选模式——inject 列表不加 'approval'。
  ctx.provide('acp', {
    ...acp,
    requestPromotion: (candidate, ctxArg) => expression.requestPromotion(candidate, ctxArg ?? ctx),
  })

  // --- S1 P7：注入调度器段注册（可选服务；未挂 scheduler 时静默跳过）---
  registerAcpSection(ctx, config)

  // --- S1 P1（2026-09-04）：acp_query 只读工具（对话即界面）---
  // 注册失败不阻断插件（工具缺失仅失去主动查询面，注入不受影响）。
  try {
    ctx.tools.register(makeAcpQueryTool({
      ledger,
      auditStore: acp.auditStore || ledger.auditStore,
      scopeId: scopeOf(ctx),
    }))
  } catch (err) {
    ctx.logger?.warn?.('[acp] acp_query register failed: ' + (err && err.message))
  }

  // --- T4 M4.3：/acp rule review 命令（人工/headless 审批通道；可选服务）---
  registerRuleReviewCommand(ctx, ledger, refreshRulesView)

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
    logger: ctx.logger ?? console, // P0-2：降级留痕走宿主 logger
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
    maxBatch: config.consolidationMaxBatch, // P0-6：undefined → consolidate 默认 CONSOLIDATION_MAX_BATCH
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
        // T4 M4.2：反馈通道草拟（独立日限节流；幂等——已入 rules 的证据不再草拟）
        void maybeDraft(ledger, { llmCall: buildLlmCall(), logger: ctx.logger })
          .catch((err) => ctx.logger?.warn?.('[acp] feedback draft run failed: ' + (err instanceof Error ? err.message : String(err))))
        return
      }
      if (!isEvidenceWorthy(event)) return
      const ev = toEvidenceCandidate(event, {
        scopeId: scopeOf(ctx),
        sessionId: session?.id ?? '',
        agentKey: event.agentKey ?? '',
        sessionType: event.sessionType ?? 'root',
        // 子代理会话（header.origin==='subagent'）：user 消息（父 prompt）降权 quarantine
        subagent: config.subagentDowngrade === true && session?.header?.origin === 'subagent',
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
      // 会话分层（2026-08-30，ISSUES-INJECTION-ISOLATION.md F5/F7）：
      // 本会话全类别 + 跨会话受限（类别闸门与惩罚由 compose 的 currentSessionId 处理）。
      const sessionId = payload?.agent?.session?.id ?? ''
      const ledgerCandidates = [
        ...ledger.query({ scopeId, state: 'active', sessionId, limit: config.recallLimit ?? 20 }).items,
        ...ledger.query({ scopeId, state: 'active', sessionId: { not: sessionId }, limit: config.recallLimit ?? 20 }).items,
      ]

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

      // —— P1-1：Observation 注入（默认冻结，config.observationInjection 打开）——
      let observationCandidates = []
      if (config.observationInjection === true) {
        try {
          // T2（2026-09-07）：权威闸门——queryObservation 按 authorities 过滤，不再全表 listObservations(scopeId) 每轮拉取全部 active observation（1729+ 条含大量 single_observation 噪声）
          const authorities = Array.isArray(config.observationAuthorities) && config.observationAuthorities.length > 0
            ? config.observationAuthorities
            : ['user_explicit', 'user_correction']
          const q = typeof ledger.queryObservation === 'function'
            ? ledger.queryObservation({ scopeId, state: 'active', authorities, limit: 100, order: 'desc' })
            : null
          const rows = q ? q.items : (typeof ledger.listObservations === 'function' ? ledger.listObservations(scopeId) : [])
          // 阶段 2.3（2026-09-09）：一次性任务指令判别。
          //   shadow（默认）= 只统计不生效；on = 真过滤；off = 关闭。
          const ephemeralMode = config.preferenceEphemeralFilter ?? 'shadow'
          let ephemeralDropped = 0
          observationCandidates = (Array.isArray(rows) ? rows : [])
            .filter((o) => o && typeof o.text === 'string' && o.text.length > 0)
            // T2.5（2026-09-07）：动作流水形态不进注入（「用户 询问/确认/审批…」是
            // 会话转写，非画像——authority 聚合虚高导致过闸门）
            .filter((o) => !isActionFlowObservation(o.subject, o.predicate))
            .filter((o) => {
              const allowed = preferenceFilterAllows(o, ephemeralMode)
              if (!allowed) ephemeralDropped += 1
              return allowed
            })
            .map((o) => observationToCandidate(o, scopeId))
          if (ephemeralMode !== 'off' && ephemeralDropped > 0) {
            ctx.logger?.debug?.('[acp] ephemeral_preference mode=' + ephemeralMode
              + ' dropped=' + ephemeralDropped + ' kept=' + observationCandidates.length)
          }
        } catch (err) {
          ctx.logger?.warn?.('[acp] acp:degraded observation_read_failed reason='
            + (err instanceof Error ? err.message : String(err)))
        }
      }

      // —— Provider recall（M3 A1）：registry 并行召回，semantic 分来源（COMPOSER.md §4）——
      // hasProvider = registry 有启用 provider（provider 自适应权重切换）；
      // recallAll 已 fail-open（[]），Provider 故障不阻断 turn，也不额外降级 hasProvider。
      const enabledProviders = registry.listRecallProviders()
      let hasProvider = enabledProviders.length > 0
      let recallCandidates = []
      if (hasProvider) {
        const hits = await registry.recallAll({ text: userText, limit: config.recallLimit ?? 20 })
        recallCandidates = normalizeRecallHits(hits, scopeId)
        // P0-2（2026-09-02）：区分「未配置 provider」与「provider 调用失败」。
        // 全部启用 provider 本轮都失败 → 降级为无 provider 权重分支（semantic 并入 lexical），
        // 否则 composer 会按「有语义结果」配权，而实际召回是空的。
        if (typeof registry.hasHealthyProvider === 'function' && !registry.hasHealthyProvider()) {
          hasProvider = false
          ctx.logger?.warn?.('[acp] acp:degraded provider_all_failed → compose 走无 provider 权重分支')
        }
      }
      // M3 A3：多源融合权重（缺省 1.0）
      const providerWeights = {}
      for (const p of enabledProviders) providerWeights[p.id] = p.weight ?? 1

      // T4 M4.4：生效规则常驻 rules 段（≤3 条 × ≤150 字；Q2(a) 拍板 30 token 预算）。
      // 候选带显式 section='rules'（composer 覆盖 sectionOf）。注意：规则域
      // （workflow/habit/…）不是 claimDomain 6 值——不设 claimDomain，readGuard
      // 无 targetDomain 跳过资格矩阵放行；渲染以 [acp:rule] 标识来源。
      let ruleCandidates = []
      try {
        // B14-2/3（2026-09-12）：全量 active 进候选——去掉旧 slice(0,3) 时间序切片
        // （它让老规则永不进候选，7 条库实际只有最新 3 条参与竞争）。排序交给 composer 的
        // utility（词法相关度主导）+ pinBoost（gates 含 'always' 的核心铁律常驻加成），
        // 容量由 rules 段配额裁定；shortLabel 让规则行按 4 token 记账（B14-1，省 16/条）。
        const ruleRows = ledger.ruleStore.queryRules({ state: 'active', limit: 50 }).items
        ruleCandidates = ruleRows.map((r) => {
          const gates = Array.isArray(r.gates) ? r.gates : []
          return {
            id: r.id,
            content: String(r.text ?? ''),
            scopeId,
            sourceClass: 'rule',
            state: 'active',
            section: 'rules',
            shortLabel: true,
            confidence: 0.95,      // 人工审批产物（默认 0.5 → quality 0.75 vs 0.975）
            explicitRef: true,     // 用户显式行为约束（+0.2：词面不相关时不至全零被随机裁掉）
            pinBoost: gates.includes('always') ? 0.5 : 0,
          }
        })
      } catch (err) {
        ctx.logger?.warn?.('[acp] rule candidates failed: ' + (err instanceof Error ? err.message : String(err)))
      }
      const result = compose([...ruleCandidates, ...ledgerCandidates, ...viewCandidates, ...observationCandidates, ...recallCandidates], {
        query: userText,
        scopeId,
        hasProvider,
        providerWeights,
        // P0-5：hotTokens 现在真的生效（此前 composer 从不读取 = 死配置）。
        // 默认对齐 MVP_TOTAL_BUDGET(900)，行为不变；要放宽注入窗口就调这个值。
        maxTokens: config.hotTokens ?? 900,
        // S1 P2：section quota 覆盖（如 { user_model: 800 }）；缺省 MVP_SECTION_QUOTA。
        quota: config.sectionQuota,
        currentSessionId: sessionId,
        crossSessionPolicy: config.crossSessionPolicy ?? 'non-instructional',
        fusion: config.fusion ?? 'weighted',
      })

      // —— T6 style 审批门（2026-08-27 架构修正）——
      // consolidation 后台无 agent，只能把 style 候选标 pending_promotion；
      // 这里 pre-step 有 payload.agent，对未请求过的 pending 候选 fire-and-forget
      // 发起 approval.request（不 await，审批面板异步弹出，不阻塞 turn）。
      // M4.3 前置（2026-09-07）：never 策略不发起自动审批——官方语义下每个 ask
      // 确定性 rejected，自动发起 = 静默 dismiss pending 候选。候选滞留待 ask 模式
      // 或人工命令（T4 Q3(a) 拍板语义提前落地）。
      const approvalNever = isNeverApprovalPolicy(ctx, payload?.agent?.session)
      for (const cand of expression.collectPendingPromotions()) {
        if (approvalNever) break
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
      const body = renderSourceLabelled(result.items, { currentSessionId: sessionId })
      // S1 P7：注入实际发生（items 非空）→ 向调度器上报实际注入字符（fail-open）
      reportInjectionToScheduler(ctx, sessionId, body)
      // B8（2026-09-12）：注入集稳定性观测（turnover）——相邻 step 的 Jaccard + 集大小，
      // 仅写日志（fail-open，绝不阻塞注入）。1.0=两次注入集完全相同，低值=召回漂移大。
      try {
        const injectedIds = Array.isArray(result.admittedIds) ? result.admittedIds : []
        const prevIds = lastInjectedBySession.get(sessionId) ?? []
        ctx.logger?.info?.('[acp] injection turnover jaccard=' + jaccard(prevIds, injectedIds).toFixed(2)
          + ' admitted=' + injectedIds.length + ' prev=' + prevIds.length)
        lastInjectedBySession.set(sessionId, injectedIds)
        if (lastInjectedBySession.size > 50) { // 防无界累积（只保留最近 50 个会话）
          const oldest = lastInjectedBySession.keys().next().value
          if (oldest !== undefined && oldest !== sessionId) lastInjectedBySession.delete(oldest)
        }
      } catch { /* 观测失败不影响注入 */ }
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

// ===================== T4 M4.3：/acp rule review 命令（2026-09-07） =====================
// 规则草案审批的人工/headless 通道（approval seam 自动发起后续接；never 策略可用）。
// 语义：accept = transitionRule approve（→active + 视图刷新 + audit rule_approved）；
//       reject = transitionRule reject（→终态 + audit rule_rejected）。
// 命令仅 draft 序号的 list 段操作（序号 1..N 对应草案列表顺序）。

export const RULE_CMD_USAGE = [
  'Usage: /acp rule <verb> [args]',
  '  list              列出规则草案（draft，可审批）',
  '  accept <n>        审批通过第 n 条草案（→ active，视图重建 + 审计）',
  '  reject <n>        拒绝第 n 条草案（→ rejected + 审计）',
  '  rebuild           重建 rules/ 视图文件（规则经脚本/外部写入后刷新）',
  '示例：/acp rule list → /acp rule accept 1 → /acp rule rebuild',
].join('\n')

/** B14-4（2026-09-12）：规则可注入性安全线（CJK 字）。
 *  单条成本 ≈ 短标签 4 token + 正文 1.0/字；默认 rules 配额 60 → 单条上限 ≈ 40 字（0.6×60−4），
 *  生产配额 140 → ≈ 80 字。超线会被 packBySection 整条丢弃（或按 section 上限截断），
 *  故在 list/草拟阶段就标出，避免"写了规则但不生效"。 */
const RULE_INJECT_CHARS_SAFE = 40

/** 规则长度标记（含超安全线警示） */
function ruleSizeTag(r) {
  const chars = String(r.text ?? '').length
  return chars + '字' + (chars > RULE_INJECT_CHARS_SAFE ? ' ⚠超' + RULE_INJECT_CHARS_SAFE + '字安全线（可能被整条丢弃）' : '')
}

/** 渲染规则列表（draft 序号可操作；active 附后参考） */
export function renderRuleList(ruleStore, _opts = {}) { // opts 预留（调用方当前只传 ruleStore）
  const draft = ruleStore.queryRules({ state: 'draft', limit: 50 }).items
  const active = ruleStore.queryRules({ state: 'active', limit: 10 }).items
  const lines = []
  if (draft.length === 0 && active.length === 0) {
    return '（无规则草案/生效规则——纠正会经草拟管线成为草案，见 /acp rule list）'
  }
  if (draft.length > 0) {
    lines.push('[draft] ' + draft.length + ' 条（accept/reject 按此序号）')
    draft.forEach((r, i) => {
      lines.push('  ' + (i + 1) + '. [' + r.domain + '] ' + (r.title || '（无标题）'))
      lines.push('     gates=' + (r.gates.join(',') || '-') + ' | ' + ruleSizeTag(r) + ' | ' + String(r.text).slice(0, 80))
    })
  }
  if (active.length > 0) {
    lines.push('[active] ' + active.length + ' 条生效')
    active.forEach((r) => {
      lines.push('  · [' + r.domain + '] ' + (r.title || String(r.text).slice(0, 24)) + '（since '
        + new Date(r.activeFrom ?? r.createdAt).toISOString().slice(0, 10) + ' · ' + ruleSizeTag(r) + '）')
    })
  }
  return lines.join('\n')
}

/** /acp rule 处理器（纯函数化，供测试直调）。返回 {kind:'success'|'error', text}。 */
export function handleRuleReviewCommand(ruleStore, auditStore, rawInput, opts = {}) {
  const text = String(rawInput ?? '').trim()
  const [head, sub, ...rest] = text.split(/\s+/)
  if (head !== 'rule') return { kind: 'success', text: RULE_CMD_USAGE }
  const arg = rest.join(' ').trim()
  const actor = opts.actor ?? 'user'
  if (!sub || sub === 'list') return { kind: 'success', text: renderRuleList(ruleStore) }
  const n = Number.parseInt(arg, 10)
  if (sub === 'accept' || sub === 'reject') {
    if (!Number.isInteger(n) || n < 1) {
      return { kind: 'error', text: '/acp rule ' + sub + ' <n>：需要草案列表序号' }
    }
    const { items } = ruleStore.queryRules({ state: 'draft', limit: 50 })
    const target = items[n - 1]
    if (!target) {
      return { kind: 'error', text: '草案 #' + n + ' 不存在（当前 ' + items.length + ' 条）' }
    }
    const event = sub === 'accept' ? 'approve' : 'reject'
    const row = ruleStore.transitionRule(target.id, event)
    try {
      auditStore?.appendAudit?.({
        op: event === 'approve' ? 'rule_approved' : 'rule_rejected',
        targetId: target.id,
        scopeId: row.scopeId,
        actor,
        reason: '/acp rule ' + sub,
        payload: { domain: row.domain, gates: row.gates, title: row.title },
      })
    } catch (err) {
      opts.logger?.warn?.('[acp] rule review audit failed: ' + (err instanceof Error ? err.message : String(err)))
    }
    opts.onChanged?.()
    return { kind: 'success', text: 'rule ' + sub + ' → ' + row.state + '：' + (row.title || String(row.text).slice(0, 30)) }
  }
  if (sub === 'rebuild') {
    // D（2026-09-11 B10 复查）：规则经脚本/外部写入（非 /acp rule accept 路径）后 rules/ 视图不刷新。
    // 显式重建入口；视图本可从 ledger 重建，失败返回 error 不抛（onChanged 内部已 warn）。
    const ok = opts.onChanged?.()
    return ok === false
      ? { kind: 'error', text: 'rules/ 视图重建失败（见插件日志 warn: rules_view_write_failed）' }
      : { kind: 'success', text: 'rules/ 视图已重建（active 规则按 domain 落盘）' }
  }
  return { kind: 'success', text: RULE_CMD_USAGE }
}

/** /acp 命令注册（commands 可选服务，缺失等待就绪——WC 同款模式） */
export function registerRuleReviewCommand(ctx, ledger, onChanged) {
  withService(ctx, 'commands', (commands) => {
    if (!commands || typeof commands.register !== 'function') return
    commands.register({
      name: 'acp',
      description: 'ACP 规则草案审批（list/accept/reject/rebuild）',
      input: { hint: '/acp rule list | /acp rule accept <n> | /acp rule reject <n> | /acp rule rebuild' },
      handler: async (invocation) => {
        try {
          return handleRuleReviewCommand(
            ledger.ruleStore,
            ledger.auditStore,
            String(invocation?.rawInput ?? '').trim(),
            { onChanged, logger: ctx.logger },
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: 'acp error: ' + message }
        }
      },
    })
    ctx.logger?.info?.('[acp] /acp rule command registered')
  })
}
