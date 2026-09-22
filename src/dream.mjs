// src/dream.mjs — Dreaming 第一增量：三个确定性件（归并 / 复现计数 / 遗忘）。
//
// 设计见 docs/design/DREAMING.md。**全零 LLM**，纯函数，可单测。
// 本模块只产出「计划」——不写任何表。落库由 scripts/dream.mjs 或调用方决定。
//
// 三条纪律：
//   1. 不新造语义：簇代表正文取成员原文，不做摘要、不改写。
//   2. 物理分离：候选池与 observation 是两张表，产出物永远先落 candidate_memory。
//   3. 只标记不删除：遗忘产出的是「冷存清单」，删不删永远是人决定。

import { jaccard } from './composer.mjs'
import {
  DREAM_CLUSTER_JACCARD, DREAM_OCCURRENCE_MIN, DREAM_SESSION_MIN, DREAM_DAY_MIN,
  DREAM_ARCHIVE_DAYS, DREAM_REPRESENTATIVE_MAX_CHARS, hashHex,
} from './constants.mjs'

const PUNCT = /[\s\p{P}\p{S}]/gu

/** 归一化：去空白与标点（仅用于相似度比较，不改动原文） */
export function normalizeForCluster(text) {
  return String(text ?? '').replace(PUNCT, '')
}

/** CJK 友好的二元组集合：中文无空格分词，二元组是最省事的确定性判据 */
export function bigramSet(text) {
  const s = normalizeForCluster(text)
  const out = new Set()
  if (!s) return out
  if (s.length < 2) { out.add(s); return out }
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

/** 文本相似度（0..1）= 二元组 Jaccard */
export function similarity(a, b) {
  return jaccard([...bigramSet(a)], [...bigramSet(b)])
}

/**
 * 归并（确定性件 ①）。
 * 判据：同 claimDomain 内 —— 同 subject **或** 文本相似度 >= 阈值 → 同簇。
 * 已知边界：词面判据抓不住「换个说法」，那部分留给 P2 的语义归并（走 Provider 插槽）。
 *
 * 注：簇的二元组集合按成员累积（并集），越往后越容易命中——这是有意的（描述同一件事的
 * 多条 observation 会逐渐收敛到一簇），代价是聚类结果与输入顺序有关，故调用方应先按
 * observedAt 升序排序，保证可复现。
 *
 * @param {object[]} observations - observation 行（camelCase），需含 claimDomain/subject/text/id
 * @param {object} [opts]
 * @returns {object[]} 簇数组
 */
export function clusterObservations(observations, opts = {}) {
  const threshold = opts.threshold ?? DREAM_CLUSTER_JACCARD
  const clusters = []
  for (const obs of observations) {
    const bi = bigramSet(obs.text)
    let hit = null
    for (const c of clusters) {
      if (c.claimDomain !== obs.claimDomain) continue
      const sameSubject = Boolean(c.subject) && c.subject === (obs.subject ?? '')
      if (sameSubject || jaccard([...bi], [...c.bi]) >= threshold) { hit = c; break }
    }
    if (hit) {
      hit.members.push(obs)
      for (const g of bi) hit.bi.add(g)
    } else {
      clusters.push({ claimDomain: obs.claimDomain, subject: obs.subject ?? '', members: [obs], bi: new Set(bi) })
    }
  }
  return clusters.map(finalizeCluster)
}

/** 簇代表：subject 取众数（并列取字典序最小），正文取最长成员原文（并列取 id 最小） */
function finalizeCluster(c) {
  const subjectCount = new Map()
  for (const m of c.members) subjectCount.set(m.subject ?? '', (subjectCount.get(m.subject ?? '') ?? 0) + 1)
  const subject = [...subjectCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  const rep = c.members.slice().sort((a, b) =>
    String(b.text ?? '').length - String(a.text ?? '').length || String(a.id).localeCompare(String(b.id)))[0]
  const text = String(rep.text ?? '').slice(0, DREAM_REPRESENTATIVE_MAX_CHARS)
  return {
    claimDomain: c.claimDomain,
    subject,
    text,
    members: c.members.map((m) => m.id),
    observationIds: c.members.map((m) => m.id),
    evidenceIds: [...new Set(c.members.flatMap((m) => m.evidenceIds ?? []))],
  }
}

/**
 * 复现计数（确定性件 ②）。
 * occurrences = 簇成员数；sessions / days 来自成员的**溯源证据**（跨会话、跨自然日）。
 * @param {object} cluster
 * @param {Map<string, object>} evidenceById
 * @returns {{occurrences:number, sessions:string[], days:number, firstSeen:string, lastSeen:string}}
 */
export function occurrenceStats(cluster, evidenceById) {
  const sessions = new Set()
  const days = new Set()
  let first = ''
  let last = ''
  for (const eid of cluster.evidenceIds ?? []) {
    const ev = evidenceById.get(eid)
    if (!ev) continue
    if (ev.sessionId) sessions.add(ev.sessionId)
    const at = String(ev.observedAt ?? '')
    if (at) {
      days.add(at.slice(0, 10))
      if (!first || at < first) first = at
      if (!last || at > last) last = at
    }
  }
  return {
    occurrences: cluster.observationIds?.length ?? 0,
    sessions: [...sessions].sort(),
    days: days.size,
    firstSeen: first,
    lastSeen: last,
  }
}

/**
 * 晋升判定（确定性、可解释）。
 * 注意：**user_correction 不进复现计数**——一次性高权威不该被「说得多」压过（见 DREAMING §4②）。
 * @returns {'consensus'|'candidate'}
 */
export function decideState(cluster, stats, opts = {}) {
  const minOcc = opts.minOccurrences ?? DREAM_OCCURRENCE_MIN
  const minSessions = opts.minSessions ?? DREAM_SESSION_MIN
  const minDays = opts.minDays ?? DREAM_DAY_MIN
  if (stats.occurrences < minOcc) return 'candidate'
  if (stats.sessions.length >= minSessions || stats.days >= minDays) return 'consensus'
  return 'candidate'
}

/** 候选 id：由 (scope, claimDomain, subject, 成员 id) 派生 → 幂等重跑得到同一行 */
export function candidateMemoryIdOf({ scopeId = 'user-global', claimDomain, subject, observationIds }) {
  const key = [scopeId, claimDomain, subject, [...observationIds].sort().join(',')].join('|')
  return 'cm_' + hashHex(key).slice(0, 24)
}

/**
 * 遗忘（确定性件 ③）。**只产出计划，不改任何状态**。
 * - observation：state=superseded 且 createdAt 早于 TTL。
 *   注：observation 表没有 superseded_at，用 createdAt 做下界——只会偏晚不会偏早。
 * - evidence：state=quarantined 且 updated_at 早于 TTL（updated_at 就是状态迁移时刻，准确）。
 * @returns {{observations:string[], evidence:string[], stats:object}}
 */
export function planArchival({ observations = [], evidence = [], now = Date.now(), ttlDays = DREAM_ARCHIVE_DAYS } = {}) {
  const cutoff = now - ttlDays * 86400000
  const staleObservations = observations
    .filter((o) => o.state === 'superseded' && Number(o.createdAt ?? 0) > 0 && Number(o.createdAt) < cutoff)
    .map((o) => o.id).sort()
  const staleEvidence = evidence
    .filter((e) => e.state === 'quarantined' && Number(e.updatedAt ?? e.createdAt ?? 0) < cutoff)
    .map((e) => e.id).sort()
  return {
    observations: staleObservations,
    evidence: staleEvidence,
    stats: {
      ttlDays,
      cutoffIso: new Date(cutoff).toISOString(),
      staleObservations: staleObservations.length,
      staleEvidence: staleEvidence.length,
    },
  }
}

/**
 * 跑一次 dreaming（纯函数，不落库）。
 * @param {object} input - { observations, evidence }（camelCase 行）
 * @param {object} [opts]
 * @returns {{candidates:object[], archival:object, stats:object}}
 */
export function runDream({ observations = [], evidence = [] } = {}, opts = {}) {
  const scopeId = opts.scopeId ?? 'user-global'
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))
  const active = observations.filter((o) => o.state === 'active')
    .slice().sort((a, b) => String(a.observedAt ?? '').localeCompare(String(b.observedAt ?? '')) || String(a.id).localeCompare(String(b.id)))

  const clusters = clusterObservations(active, opts)
  const candidates = clusters.map((c) => {
    const stats = occurrenceStats(c, evidenceById)
    const state = decideState(c, stats, opts)
    return {
      id: candidateMemoryIdOf({ scopeId, claimDomain: c.claimDomain, subject: c.subject, observationIds: c.observationIds }),
      scopeId,
      state,
      claimDomain: c.claimDomain,
      subject: c.subject,
      text: c.text,
      observationIds: c.observationIds,
      evidenceIds: c.evidenceIds,
      ...stats,
    }
  })

  const archival = planArchival({ observations, evidence, now: opts.now, ttlDays: opts.ttlDays })
  return {
    candidates,
    archival,
    stats: {
      scannedObservations: observations.length,
      activeObservations: active.length,
      clusters: clusters.length,
      consensus: candidates.filter((c) => c.state === 'consensus').length,
      candidate: candidates.filter((c) => c.state === 'candidate').length,
      multiMember: candidates.filter((c) => c.observationIds.length > 1).length,
    },
  }
}
