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
      console.log('[CONS-PROBE] llm call failed: ' + (err && err.message) + ' | stack: ' + (err && err.stack ? String(err.stack).slice(0, 300) : ''))
      continue
    }
    const parsed = parseObservations(text)
    if (parsed.ok) return parsed.observations
    logger?.warn?.('[acp] consolidation llm output parse failed (attempt ' + (attempt + 1) + '/2)')
    console.log('[CONS-PROBE] parse failed, raw: ' + String(text).slice(0, 200))
  }
  return [] // 丢弃该批（不落规则兜底——规则兜底只在 llmCall 缺失时启用）
}

// ===================== Consolidator（队列 + 节流 + 派生） =====================

/**
 * 创建后台 consolidation 协调器。
 * @param {object} opts
 * @param {object} opts.ledger - openEvidenceLedger() 返回的 Provider
 * @param {string} [opts.scopeId] - 默认 'user-global'
 * @param {(userText: string, system: string) => Promise<string>} [opts.llmCall] - null 则走规则兜底
 * @param {(candidate: object) => void} [opts.promoteCandidate] - style 候选接缝（requestPromotion）
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
    promoteCandidate = null,
    minEvidence = CONSOLIDATION_MIN_EVIDENCE,
    minTurns = CONSOLIDATION_MIN_TURNS,
    logger = console,
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
        // 接缝（固定接口）：claimDomain==='style' 候选 → acp.requestPromotion(candidate, ctx)
        if (obs.claimDomain === 'style' && typeof promoteCandidate === 'function') {
          const candidate = {
            ...obs,
            scopeId,
            id: res.id,
            state: res.row?.state ?? 'active',
          }
          try {
            promoteCandidate(candidate)
          } catch (err) {
            logger?.warn?.('[acp] promoteCandidate error: ' + (err && err.message))
          }
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
