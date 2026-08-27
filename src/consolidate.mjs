// src/consolidate.mjs — Background consolidation（P1-4，决策 2B/3A）。
//
// turn/end → enqueue（单全局串行队列，fire-and-forget，不阻塞下一轮）。
// 节流（决策 2B）：未消化 active 证据 ≥ minEvidence 条 或 距上次 ≥ minTurns turn 才跑；
//   水位存 meta 表（consolidation_watermark_ts / consolidation_turn_count）。
// 派生（决策 3A）：从未消化证据批量 LLM 提取 Observation（LLM 主，规则兜底）：
//   - LLM 可用：prompt 强制 JSON {observations:[...]}，解析失败重试 1 次后丢弃该批；
//   - LLM 不可用（llmCall 为 null）：每证据确定性生成一条 Observation（规则兜底）。
// 纪律：本模块零 dsh-llm 依赖——真实 LLM 调用由 index.mjs 注入（llmCall），测试传 mock。

import {
  CLAIM_DOMAINS,
  CONSOLIDATION_MIN_EVIDENCE,
  CONSOLIDATION_MIN_TURNS,
  CONSOLIDATION_META_WATERMARK_TS,
  CONSOLIDATION_META_TURN_COUNT,
  MAX_OBSERVATION_SUBJECT_CHARS,
  MAX_OBSERVATION_TEXT_CHARS,
} from './constants.mjs'
import { PENDING_PROMOTION } from './expression.mjs'

// ===================== 规则兜底（LLM 不可用） =====================

/** 单条证据 → 一条 Observation（确定性兜底；subject=内容前 40 字符） */
export function ruleObservationFor(ev) {
  return {
    subject: String(ev.content ?? '').slice(0, MAX_OBSERVATION_SUBJECT_CHARS),
    predicate: 'states',
    claimDomain: ev.claimDomain,
    text: String(ev.content ?? '').slice(0, MAX_OBSERVATION_TEXT_CHARS),
    evidenceIds: [ev.id],
  }
}

export function ruleObservations(evidences) {
  return evidences.map(ruleObservationFor)
}

// ===================== LLM 输出解析 =====================

/** 从模型回复里挖出最外层 JSON 对象（容忍 markdown fence / 前后杂文） */
function extractJsonObject(text) {
  let t = String(text ?? '').trim()
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return '{}'
  return t.slice(start, end + 1)
}

/**
 * 解析 LLM 强制 JSON → 合法 Observation 列表。
 * @param {string} text - 模型原始回复
 * @returns {{ok: boolean, observations: object[]}} 非法/空则 ok:false
 */
export function parseObservations(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, observations: [] }
  let data
  try {
    data = JSON.parse(extractJsonObject(text))
  } catch {
    return { ok: false, observations: [] }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.observations)) {
    return { ok: false, observations: [] }
  }
  const observations = []
  for (const o of data.observations) {
    if (!o || typeof o !== 'object') continue
    const subject = String(o.subject ?? '').trim()
    const predicate = String(o.predicate ?? '').trim()
    const claimDomain = String(o.claimDomain ?? '')
    const text2 = String(o.text ?? '').trim()
    if (!subject || !predicate || !text2) continue
    if (!CLAIM_DOMAINS.includes(claimDomain)) continue
    const evidenceIds = Array.isArray(o.evidenceIds)
      ? o.evidenceIds.map(String).filter((id) => id.length > 0)
      : []
    observations.push({
      subject,
      predicate,
      claimDomain,
      text: text2.slice(0, MAX_OBSERVATION_TEXT_CHARS),
      evidenceIds,
    })
  }
  if (observations.length === 0) return { ok: false, observations: [] }
  return { ok: true, observations }
}

// ===================== LLM prompt =====================

/**
 * 构造 consolidation prompt（system + user JSON-framed evidence）。
 * @param {object[]} evidences - { id, claimDomain, content }
 * @returns {{system: string, userText: string}}
 */
export function buildConsolidationPrompt(evidences) {
  const system = [
    'You consolidate evidence records into durable observations for a user-context ledger.',
    'Return ONLY one JSON object with exactly this shape:',
    '{"observations":[{"subject":"...","predicate":"...","claimDomain":"...","text":"...","evidenceIds":["..."]}]}',
    `claimDomain must be one of: ${CLAIM_DOMAINS.join(', ')}.`,
    'Domain guidance: style = tone/format/presentation preferences (e.g. 简洁/详细/亲切的语气, 先结论后展开, 中文回复); user_preference = substantive preferences (e.g. 用 pnpm, 用 Bun). 表达风格偏好一律标 style，不要标 user_preference。',
    'subject is a short noun phrase; predicate is a short relation verb; text is a concise fact (<= 500 chars); evidenceIds reference the supporting evidence ids.',
    'Do not invent facts absent from the evidence. Do not output anything except the JSON.',
  ].join('\n')
  const userText = 'Evidence records (JSON):\n'
    + JSON.stringify(evidences.map((ev) => ({ id: ev.id, claimDomain: ev.claimDomain, content: ev.content })))
  return { system, userText }
}

/** 最多 2 次 LLM 尝试（初次 + 1 次重试）；抛错或解析失败都计一次，仍失败丢弃该批返回 [] */
async function deriveViaLlm(evidences, llmCall, logger) {
  const { system, userText } = buildConsolidationPrompt(evidences)
  for (let attempt = 0; attempt < 2; attempt++) {
    let text
    try {
      text = await llmCall(userText, system)
    } catch (err) {
      logger?.warn?.('[acp] consolidation llm call failed (attempt ' + (attempt + 1) + '/2): ' + (err && err.message))
      continue
    }
    const parsed = parseObservations(text)
    if (parsed.ok) return parsed.observations
    logger?.warn?.('[acp] consolidation llm output parse failed (attempt ' + (attempt + 1) + '/2)')
  }
  return [] // 丢弃该批（不落规则兜底——规则兜底只在 llmCall 缺失时启用）
}

// ===================== M3 B3：style 候选 → policy（guarded auto promotion） =====================
// 流程（M3-PLAN §6.4）：
//   consolidation 产出 style 候选 → evaluateCandidate（evidenceRows=候选证据+相关证据）
//     → decision=promote 且 config.autoPromote=true → autoPromote 路径（候选行 promote +
//       reviewStatus 同步 + audit + view 重写，由 index 注入的 autoPromote 执行）
//     → 否则维持现状（pending_promotion → manual approval 路径）
// 方向性（B2 报告集成点 1）：候选证据默认 supports；同键 superseded 旧证据标 opposes
// （反向纠正 → policy 走 hold → 留人工）。

/** 标 pending 标记（幂等 + 不降级已 promoted 证据）；失败静默（fail-open） */
function markPending(ledger, evId, logger) {
  try {
    const row = ledger.getById(evId)
    if (row && row.state === 'active'
      && row.metadata?.reviewStatus !== PENDING_PROMOTION
      && row.metadata?.reviewStatus !== 'promoted') {
      ledger.updateMetadata(evId, { reviewStatus: PENDING_PROMOTION })
    }
  } catch (err) {
    logger?.warn?.('[acp] style pending mark error: ' + (err && err.message))
  }
}

/** 同证据集（无序）匹配已有 style 候选（reuse-or-create 的去重依据） */
function findCandidateForEvidenceIds(candidateStore, scopeId, evidenceIds) {
  const want = new Set(evidenceIds)
  for (const c of candidateStore.listCandidates({ scopeId, limit: 200 })) {
    if (c.domain !== 'style') continue
    const ids = c.evidenceIds ?? []
    if (ids.length === want.size && ids.every((id) => want.has(id))) return c
  }
  return null
}

/**
 * 处理一条 style 观察派生：
 *  - 无 B3 依赖（candidateStore/policyEvaluate 缺失）→ 维持 M2 行为：仅标 pending_promotion；
 *  - 有依赖 → reuse-or-create 候选 → 装配证据行（含方向）→ evaluateCandidate：
 *      promote → autoPromote；否则 → pending_promotion（manual 路径）。
 * @returns {'pending'|'auto-promoted'|'promoted'|string} 处理结果（测试/日志用）
 */
function handleStyleCandidate({ obs, ledger, candidateStore, auditStore, policyEvaluate, autoPromote, scopeId, logger }) {
  const evidenceIds = Array.isArray(obs.evidenceIds) ? obs.evidenceIds : []
  if (!candidateStore || typeof policyEvaluate !== 'function') {
    for (const evId of evidenceIds) markPending(ledger, evId, logger)
    return 'pending'
  }
  // reuse-or-create：同证据集已有候选则复用；终态候选尊重既有决策（不再新建/复活）
  let candidate = findCandidateForEvidenceIds(candidateStore, scopeId, evidenceIds)
  if (candidate && candidate.state !== 'proposed') {
    return candidate.state === 'promoted' ? 'promoted' : 'decided-' + candidate.state
  }
  if (!candidate) {
    candidate = candidateStore.createCandidate({ scopeId, domain: 'style', evidenceIds })
  }
  // 证据行装配（B2 集成点 1）：候选证据默认 supports；同键 superseded 旧证据标 opposes
  const evidenceRows = []
  for (const evId of evidenceIds) {
    const ev = ledger.getById(evId)
    if (!ev) continue
    evidenceRows.push({ ...ev, direction: 'supports' })
    for (const prevId of ev.supersedes ?? []) {
      const prev = ledger.getById(prevId)
      if (prev) evidenceRows.push({ ...prev, direction: 'opposes' })
    }
  }
  // 冲突候选（B2 集成点 2）：同 scope+domain、非自身、proposed/promoted
  const conflictingCandidates = candidateStore.listCandidates({ scopeId, limit: 200 })
    .filter((c) => c.domain === 'style' && c.id !== candidate.id
      && (c.state === 'proposed' || c.state === 'promoted'))
    .map((c) => c.id)
  // policy 评估（纯函数零副作用；评估失败不阻断 → 落人工）
  let policyResult = null
  try {
    policyResult = policyEvaluate({ candidate: { ...candidate, conflictingCandidates }, evidenceRows })
  } catch (err) {
    logger?.warn?.('[acp] style policy evaluate error: ' + (err && err.message))
  }
  if (policyResult && policyResult.decision === 'promote' && typeof autoPromote === 'function') {
    try {
      autoPromote(candidate, policyResult)
      return 'auto-promoted'
    } catch (err) {
      logger?.warn?.('[acp] style auto promote error: ' + (err && err.message))
      // 自动路径失败 → 落人工（pending），不丢候选
    }
  }
  for (const evId of evidenceIds) markPending(ledger, evId, logger)
  return policyResult ? policyResult.decision : 'pending'
}

// ===================== Consolidator（队列 + 节流 + 派生） =====================

/**
 * 创建后台 consolidation 协调器。
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的 Provider
 * @param {string} [opts.scopeId] - 默认 'user-global'
 * @param {(userText: string, system: string) => Promise<string>} [opts.llmCall] - null 则走规则兜底
 * @param {number} [opts.minEvidence] - 默认 CONSOLIDATION_MIN_EVIDENCE
 * @param {number} [opts.minTurns] - 默认 CONSOLIDATION_MIN_TURNS
 * @param {object} [opts.logger] - 默认 console
 * @returns {object} 协调器句柄
 */
export function createConsolidator(opts = {}) {
  const {
    ledger,
    scopeId = 'user-global',
    llmCall = null,
    minEvidence = CONSOLIDATION_MIN_EVIDENCE,
    minTurns = CONSOLIDATION_MIN_TURNS,
    logger = console,
    // M3 B3：guarded auto promotion 依赖（index.mjs 装配；缺省 null = M2 行为）
    candidateStore = null,
    auditStore = null,
    policyEvaluate = null, // (args) => evaluateCandidate({...args, config})，index 注入
    autoPromote = null,    // (candidate, policyResult) => expression.autoPromote(...)，index 注入
  } = opts

  let pending = false
  let running = false
  let runPromise = null
  let currentLlmCall = llmCall // 可被 setLlmCall 更新（withService 模式：internal/service 重解析）

  function readMeta(key) {
    return typeof ledger.getMeta === 'function' ? ledger.getMeta(key) : null
  }
  function writeMeta(key, value) {
    if (typeof ledger.setMeta === 'function') ledger.setMeta(key, value)
  }

  function readTurnCount() {
    const v = readMeta(CONSOLIDATION_META_TURN_COUNT)
    const n = v == null ? 0 : Number(v)
    return Number.isFinite(n) ? n : 0
  }

  /** 未消化 = active 且 observedAt > 上次 consolidation 水位 */
  function undigestedEvidence() {
    const watermark = readMeta(CONSOLIDATION_META_WATERMARK_TS)
    const active = typeof ledger.listActive === 'function'
      ? ledger.listActive(scopeId)
      : ledger.query({ scopeId, state: 'active' }).items
    if (!watermark) return active
    return active.filter((ev) => (ev.observedAt ?? '') > watermark)
  }

  /** 节流判定：未消化 ≥ minEvidence 或 距上次 ≥ minTurns turn */
  function shouldRun() {
    return undigestedEvidence().length >= minEvidence || readTurnCount() >= minTurns
  }

  function advanceWatermark(evidences) {
    let max = ''
    for (const ev of evidences) {
      const t = ev.observedAt ?? ''
      if (t > max) max = t
    }
    writeMeta(CONSOLIDATION_META_WATERMARK_TS, max || new Date().toISOString())
  }

  function resetTurns() {
    writeMeta(CONSOLIDATION_META_TURN_COUNT, '0')
  }

  function incrementTurns() {
    writeMeta(CONSOLIDATION_META_TURN_COUNT, String(readTurnCount() + 1))
  }

  /**
   * 执行一次 consolidation（awaitable，供测试与 dispose drain）。
   * @returns {{ran: boolean, digested: number, observations: number, reason?: string}}
   */
  async function runOnce() {
    if (running) return { ran: false, reason: 'running', digested: 0, observations: 0 }
    running = true
    try {
      const evidences = undigestedEvidence()
      resetTurns() // 已消费本次触发的 turn 计数
      if (evidences.length === 0) {
        advanceWatermark([])
        return { ran: true, digested: 0, observations: 0 }
      }

      let observations
      if (currentLlmCall) {
        observations = await deriveViaLlm(evidences, currentLlmCall, logger)
      } else {
        observations = ruleObservations(evidences)
      }

      let wrote = 0
      for (const obs of observations) {
        const res = ledger.upsertObservation({ scopeId, ...obs })
        if (res.inserted || res.row) wrote += 1
        // style 候选（M3 B3）：policy 达标且 auto_promote=true → 自动提升；
        // 否则维持 M2 架构修正（后台任务无 agent → 标 pending_promotion，
        // 下个 turn 的 pre-step 有 agent 时统一发起面板审批）。
        if (obs.claimDomain === 'style') {
          handleStyleCandidate({ obs, ledger, candidateStore, auditStore, policyEvaluate, autoPromote, scopeId, logger })
        }
      }

      advanceWatermark(evidences)
      return { ran: true, digested: evidences.length, observations: wrote }
    } finally {
      running = false
      pending = false
    }
  }

  /**
   * turn/end 入队（fire-and-forget，不 await）。
   * 背压：已有 pending 任务时丢弃本次；节流不满足时跳过。
   * @returns {{queued: boolean, reason?: 'backpressure'|'throttle'|'error'}}
   */
  function enqueue() {
    try {
      incrementTurns()
      if (pending || running) return { queued: false, reason: 'backpressure' }
      if (!shouldRun()) return { queued: false, reason: 'throttle' }
      pending = true
      runPromise = runOnce()
        .catch((err) => { logger?.warn?.('[acp] consolidation error: ' + (err && err.message)) })
        .finally(() => { runPromise = null })
      return { queued: true }
    } catch (err) {
      logger?.warn?.('[acp] consolidate enqueue error: ' + (err && err.message))
      return { queued: false, reason: 'error' }
    }
  }

  /** 等待在途 run 完成（测试用）；无在途任务立即 resolve */
  function awaitIdle() {
    return runPromise ?? Promise.resolve()
  }

  /** 更新 LLM 调用（withService 模式：internal/service 事件触发时重解析） */
  function setLlmCall(fn) {
    currentLlmCall = fn ?? null
  }

  return {
    enqueue,
    runOnce,
    shouldRun,
    isPending: () => pending || running,
    awaitIdle,
    undigestedEvidence,
    readTurnCount,
    setLlmCall,
  }
}
