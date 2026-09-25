// src/backlink.mjs — 读侧「证据回链可核验性」分层（2026-09-25，方案 3）
// ---------------------------------------------------------------------------
// 要修的是什么（诊断：D:/DSH_workspace/research-2026-09-25/K-evidence-ids-diagnosis.md）：
//   W 机账本里 918 条 active observation 的 \`evidence_ids='[]'\`，被所有读侧判据
//   （release-gate / dream-export / 画像权重 / 审计）当成**同一件事**：
//   「这条结论没有支撑证据」——也就是「本机数据缺陷」。
//
//   实测那个判断是错的。918 条的来源 100% 是跨机导入：
//     - \`scripts/ledger-import.mjs:82-85\` 导入时**主动清空** evidenceIds，
//       理由写在 :13-14（evidence 不跨机，跨机引用必然悬空，留着比清掉更误导）；
//         ——**这一侧是设计，本模块不改它，也不改任何存量数据。**
//     - 本机蒸馏产出的 152 条 active **全部有回链**（0 空洞）。
//   所以「外机按设计清空」与「本机写入路径漏了回链」是两件事，必须分开。
//
// 怎么在不写任何数据的前提下把两类分开（本模块的全部技巧就在这里）：
//   observation 的 id 是**按自身字段派生的**（\`store.observationIdOf\`：scope|subject|
//   predicate|domain|text|JSON(evidenceIds) 的 sha256 前 24 位，见 store.mjs 写入路径）。
//   于是有一条免费的判据：
//     · 本机写出的行 —— 它的 id 必然与它**当前**的 (…, evidenceIds) 自洽；
//       本机空回链行 ⇒ 自洽 ⇒ **真异常**。
//     · 跨机导入的行 —— \`export-import.mjs:324\` 用**显式 id** 原样 INSERT，
//       那个 id 是**源机按原证据集**派生的，而回链被清空了 ⇒ 不自洽 ⇒ 外机签名。
//   实测（只读，W 机 1070 条 active）：152 条自洽（= 本机，全部有回链）+ 918 条不自洽
//   （= 导入，全部无回链），**0 例外**。全库 1135 行的 id 100% 形如 \`obs_<24hex>\`。
//
// 纪律：
//   1. **只读、只标注**。不写任何表、不改任何打分——本模块的返回值只用于「怎么说」和「告警」。
//      特别地：**不碰 confidence / profile weight**。空回链行在 composer 里本就有
//      \`evidenceSupportScore → confidence(0.6)\` 的兜底（composer.mjs:146），谈不上「恒 0」。
//   2. 认不出来就说认不出来（\`unknown\`），绝不凭「缺信息」往上报异常或外机。
//   3. 与 store 写入路径**同源**：\`observationIdOf\` 只有这一份实现，store 反过来 import 它。

import { hashHex } from './constants.mjs'

/**
 * 回链可核验性的四档。前三档是任务要求区分的语义，第四档是「信息不足」的诚实出口。
 *
 * - \`verifiable\`           有回链；给了解析器且全部在本机可解析（未给解析器时 checked=false）
 * - \`unverifiable_foreign\` 外机导入：回链按设计清空，或引用的源侧 id 在本机不可解析
 *                             —— **不是缺陷**，是结构事实
 * - \`missing_backlink\`     本机产出却没有回链 —— **真异常**，要告警
 * - \`unknown\`              无足够信息判定（id 不是派生形状 / 缺字段）—— 不指控任何一方
 */
export const BACKLINK_TIERS = Object.freeze([
  'verifiable',
  'unverifiable_foreign',
  'missing_backlink',
  'unknown',
])

/** 给报告/日志直接用的中文短标签（渲染层不该自己造句，免得两处漂移） */
export const BACKLINK_TIER_LABELS = Object.freeze({
  verifiable: '可核验',
  unverifiable_foreign: '不可核验（外机）',
  missing_backlink: '本机缺回链（异常）',
  unknown: '不可判定',
})

/** 派生 id 的形状：'obs_' + sha256 前 24 位十六进制（store 写入路径的产物） */
const DERIVED_OBS_ID_RE = /^obs_[0-9a-f]{24}$/

/** 与 store 写入路径**完全同口径**的数组归一（写侧是 \`input.evidenceIds.map(String)\`，不过滤空串） */
function normalizeEvidenceIds(v) {
  return Array.isArray(v) ? v.map(String) : []
}

/**
 * id 是不是 store 派生形状。非派生形状 = 无从用 id 反推来源 → 一律 \`unknown\`。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isDerivedObservationId(id) {
  return typeof id === 'string' && DERIVED_OBS_ID_RE.test(id)
}

/**
 * 稳定派生 id（**与 store 写入路径同一实现**；store 已改为 import 本函数，避免两处漂移）。
 * camelCase（读侧 toObservation）与 snake_case（DB 原始行）都认。
 * @param {object} row - { scopeId|scope_id, subject, predicate, claimDomain|claim_domain, text, evidenceIds|evidence_ids }
 * @returns {string}
 */
export function observationIdOf(row = {}) {
  const scopeId = row.scopeId ?? row.scope_id ?? 'user-global'
  return 'obs_' + hashHex([
    scopeId,
    String(row.subject ?? ''),
    String(row.predicate ?? ''),
    String(row.claimDomain ?? row.claim_domain ?? ''),
    String(row.text ?? ''),
    JSON.stringify(normalizeEvidenceIds(row.evidenceIds ?? row.evidence_ids)),
  ].join('|')).slice(0, 24)
}

/**
 * 单条 observation 行的回链档位判定（纯函数）。
 *
 * @param {object} row - observation 行（camelCase 或 snake_case）
 * @param {object} [opts]
 * @param {Set<string>|((id:string)=>boolean)} [opts.resolvableEvidence]
 *        本机可解析的 evidence id 集合。**只在回链非空时起作用**：
 *        给了它才主张「已核验」；不给则档位仍是 verifiable，但 checked=false。
 * @returns {{tier:string, label:string, foreign:boolean, checked:boolean, reason:string,
 *            evidenceIds:{total:number, resolvable:number, unresolvable:number}, idDerived:boolean}}
 */
export function classifyBacklink(row = {}, opts = {}) {
  const ids = normalizeEvidenceIds(row?.evidenceIds ?? row?.evidence_ids)
  const resolver = opts.resolvableEvidence
  const canResolve = resolver instanceof Set || typeof resolver === 'function'
  const hit = (id) => (resolver instanceof Set ? resolver.has(id) : resolver(id))
  const base = { label: '', foreign: false, checked: false, reason: '', idDerived: isDerivedObservationId(row?.id) }

  if (ids.length > 0) {
    if (!canResolve) {
      return {
        ...base,
        tier: 'verifiable',
        label: BACKLINK_TIER_LABELS.verifiable,
        checked: false,
        reason: '有 ' + ids.length + ' 条回链（未提供本机 evidence 解析器 → 未核验可解析性）',
        evidenceIds: { total: ids.length, resolvable: 0, unresolvable: 0 },
      }
    }
    const known = ids.filter((id) => hit(id)).length
    if (known === ids.length) {
      return {
        ...base,
        tier: 'verifiable',
        label: BACKLINK_TIER_LABELS.verifiable,
        checked: true,
        reason: '回链 ' + ids.length + ' 条全部在本机可解析',
        evidenceIds: { total: ids.length, resolvable: known, unresolvable: 0 },
      }
    }
    return {
      ...base,
      tier: 'unverifiable_foreign',
      label: BACKLINK_TIER_LABELS.unverifiable_foreign,
      foreign: true,
      checked: true,
      reason: '回链 ' + (ids.length - known) + '/' + ids.length + ' 条在本机不可解析（跨机引用：evidence 不跨机）',
      evidenceIds: { total: ids.length, resolvable: known, unresolvable: ids.length - known },
    }
  }

  // —— 空回链：靠 id 自洽性分开两类（本模块的核心判据）——
  if (!base.idDerived) {
    return {
      ...base,
      tier: 'unknown',
      label: BACKLINK_TIER_LABELS.unknown,
      reason: '无溯源信息可判（id 不是派生形状 ' + JSON.stringify(row?.id ?? null) + '）',
      evidenceIds: { total: 0, resolvable: 0, unresolvable: 0 },
    }
  }
  if (observationIdOf(row) === row.id) {
    return {
      ...base,
      tier: 'missing_backlink',
      label: BACKLINK_TIER_LABELS.missing_backlink,
      reason: '本机产出的 observation 却没有回链（id 与空证据集自洽）—— 写入路径异常，应告警',
      evidenceIds: { total: 0, resolvable: 0, unresolvable: 0 },
    }
  }
  return {
    ...base,
    tier: 'unverifiable_foreign',
    label: BACKLINK_TIER_LABELS.unverifiable_foreign,
    foreign: true,
    reason: '外机导入：回链按设计清空（id 由源机的原证据集派生，与本机空集不自洽）—— 不可核验，不是缺陷',
    evidenceIds: { total: 0, resolvable: 0, unresolvable: 0 },
  }
}

/**
 * 批量汇总（供账本体检/报告使用）。**只有 \`missing_backlink\` 进 alerts** ——
 * 外机不可核验是结构事实，不是缺陷，报成告警就等于把这次的错误判断又做了一遍。
 *
 * @param {object[]} rows
 * @param {object} [opts] - { resolvableEvidence }
 * @returns {{total:number, byTier:Record<string,number>, alerts:{id:string|null, reason:string}[], alertCount:number}}
 */
export function summarizeBacklinks(rows, opts = {}) {
  const byTier = {}
  for (const t of BACKLINK_TIERS) byTier[t] = 0
  const alerts = []
  const list = Array.isArray(rows) ? rows : []
  for (const r of list) {
    const v = classifyBacklink(r, opts)
    byTier[v.tier] = (byTier[v.tier] ?? 0) + 1
    if (v.tier === 'missing_backlink') alerts.push({ id: r?.id ?? null, reason: v.reason })
  }
  return { total: list.length, byTier, alerts, alertCount: alerts.length }
}

/**
 * 便捷：从账本句柄取「本机可解析的 evidence id 全集」（只读；供 scripts 与闸门调用方用）。
 * @param {{db:{prepare:Function}}} ledger - openEvidenceLedger 的返回值
 * @returns {Set<string>}
 */
export function localEvidenceIds(ledger) {
  const rows = ledger?.db?.prepare?.('SELECT id FROM evidence').all?.() ?? []
  return new Set(rows.map((r) => r.id))
}
