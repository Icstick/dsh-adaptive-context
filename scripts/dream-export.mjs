// scripts/dream-export.mjs — Dreaming 候选 → weaver 导入格式的导出器（2026-09-22）
// ---------------------------------------------------------------------------
// 方案 4 的单向通道（见 docs/design/DREAMING.md §10）：
//   候选池 approved 且 claimDomain ∈ {work, external_fact} → JSONL → **人工跑** wv import
//
// 三条硬纪律：
//   1. **weaver 侧零改动**：本脚本只写一个本地 JSONL 文件，不碰任何 weaver 库。
//   2. **画像域永不导出**：user_preference / user_fact / style 一律拒绝，无论状态。
//   3. **不新造语义**：title 是正文的**截取**，不是生成；body 原文照抄 + 附溯源。
//
// 输出格式对齐 .tooling/lib/wv.mjs 的 putOne/import 契约：
//   title(必填) / summary / body / source / tags / confidence / category / game / node_type / id
//   （逐条 library 字段可覆盖 --lib；重名会被 wv 判 DUPLICATE_TITLE 跳过）
//
// 用法：
//   node scripts/dream-export.mjs --dir <ledgerDir> [--lib work-skill] [--out f.jsonl]
//   --state approved|candidate|consensus   （默认 approved）
//   不给 --out 就只打印预览

import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '../src/home.mjs'
import { DEFAULT_DB_NAME } from '../src/constants.mjs'
import { openEvidenceLedger, deriveObservationAuthority } from '../src/store.mjs'
import { classifyBacklink } from '../src/backlink.mjs'

/** 允许导出的域（方案 4 的白名单）。画像三域**永不**在内。 */
export const EXPORTABLE_DOMAINS = Object.freeze(['work', 'external_fact'])
/** 不允许出 ACP 的域（显式写出来，免得后来人以为漏了） */
export const BLOCKED_DOMAINS = Object.freeze(['user_preference', 'user_fact', 'style'])

/**
 * 「进度快照」形态（ACP-B19，2026-09-24）。
 * 实测：consensus 51 条里可导出 5 条，其中 4 条是「进度快照 / 状态通报」——例如
 * 「当前在 dsh-desktop-shell 的某分支上先做提交…」「已读完三份报告…正复现…」。
 * 根因：Dreaming 按**复现次数**聚合，而「当前在做 X」天然会反复出现（每次压缩/交接都重提一次），
 * 于是复现次数很高、内容却是一次性的。**复现次数 != 价值**。
 *
 * 处置：**降权而不挡下**（只标注 + 降 confidence）—— 判据宁可漏也不要误杀：
 * 「已确认 X 只解第一帧」这类以「已」开头的**真知识**不能被牵连，所以只认「第一人称进行时」这一种最明确的形态。
 */
export const EPHEMERAL_PATTERNS = Object.freeze([
  /^(当前|目前|现在)(在|正在|已经|已)/,
  /^(正在|刚|刚刚)(做|跑|读|改|写|复现|排查|处理|提交)/,
  /^(已|刚)(读完|看了|完成|跑完|复现)/,
  // 2026-09-25（ACP-B19 补）：同一形态的常见变体。**只认「动作进行」**——
  // 刻意不认「已确认/已验证/已发现/已定位」这类「认知动词」，那些是真知识。宁可漏，不要误杀。
  /^(我|我们)正(在)?(做|跑|读|改|写|复现|排查|处理|提交|看|试|核对|整理|梳理|对齐|检查|验证|确认|收口|接手|推进|测)/,
  /^(进度|进展|状态|当前状态)\s*[:：]/,
])

/** @returns {boolean} true = 像「进度快照」，导出时降权 */
export function looksEphemeral(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  return EPHEMERAL_PATTERNS.some((re) => re.test(t))
}

// ═══════════════════════════════════════════════════════════════════════════════
// 判据 A：跨域配对（2026-09-25）—— 禁止域内复述进 staging
// ---------------------------------------------------------------------------
// 依据：*Discovery by Dreaming*（https://arxiv.org/abs/2607.16256）与
//       *Language Models Need Sleep*（https://arxiv.org/abs/2606.03979）：
//       **跨域重组有价值，域内复述没有价值**。
//   · 符号臂：域内复述（单一 field 内的跨 subfield 重放）增益近零；跨域才出正向效应。
//     （注：该文 v2 已**撤回** 85.7%/64.3% (+21pp) 这一头条数字——那对数字来自
//      三个模型各自的生成+自评，不是三个判官；引用时应以撤回后的结论为准。）
//   · 神经臂：跨域迁移子任务 +14.5 pp（GSM8K，rank=256，p≈0.005）；匹配条件下域内巩固
//     为 null effect（−1.8±4.4 pp）。
//
// 落地：候选的**支撑域集合** >= CROSS_DOMAIN_MIN 才允许进 staging。
//   支撑域 = 候选自身 claimDomain ∪ 其全部支撑证据的 claimDomain。
//   取并集是**松**的一侧：真跨域（证据本身跨域、或结论跨到了另一个域）都不会被误杀；
//   被挡下的只有「结论域与证据域完全同一个域」的纯域内复述。
//
// 预期副作用（本改动的目的之一）：「进度快照 / 状态通报」（「当前在做 X」）复现次数天然很高
//   （每次压缩/交接都重提一次），但它们的支撑证据始终落在同一个域 → 自然掉出候选池。
//   **复现次数 != 价值**，这一条比 B19 的 ephemeral 词面判据更根本（词面认不出的形态也会掉）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 进 staging 所需的最少支撑域数（< 2 即「域内复述」）。判据有意复刻在 wv-staging-promote.mjs。 */
export const CROSS_DOMAIN_MIN = 2

/**
 * 支撑域集合：候选自身 claimDomain ∪ 支撑证据的 claimDomain（去重、排序、丢空值）。
 * @param {string|null|undefined} claimDomain - 候选自己的域
 * @param {string[]} evidenceDomains - 支撑证据的 claimDomain 列表
 * @returns {string[]}
 */
export function supportDomains(claimDomain, evidenceDomains) {
  const set = new Set()
  if (claimDomain) set.add(claimDomain)
  for (const d of Array.isArray(evidenceDomains) ? evidenceDomains : []) if (d) set.add(d)
  return [...set].sort()
}

/**
 * 是否跨域（判据 A）。同域重复不算跨域。
 * @param {string[]} domains
 * @param {number} [min]
 * @returns {boolean}
 */
export function looksCrossDomain(domains, min = CROSS_DOMAIN_MIN) {
  if (!Array.isArray(domains)) return false
  return new Set(domains.filter(Boolean)).size >= min
}

/**
 * 从已查好的 evidence 行里收 supportDomains / authorities（纯函数，可测）。
 * 只读，不改任何表——append-only 铁律不受影响。
 * @param {object[]} entries - evidence 行（camelCase 或 DB 原始行都认）
 * @returns {{domains:string[], authorities:string[]}}
 */
export function lookupEvidenceSupport(entries) {
  const domains = []
  const authorities = []
  for (const r of Array.isArray(entries) ? entries : []) {
    if (!r) continue
    const d = r.claimDomain ?? r.claim_domain
    const a = r.authority
    if (d) domains.push(d)
    if (a) authorities.push(a)
  }
  return { domains, authorities }
}

/**
 * 候选 → 带上判据 A/B 所需字段的候选行（`evidence` 由调用方按 evidenceIds 查好传入）。
 * 两侧 authority 都用既有的非放大聚合 deriveObservationAuthority（取最弱）——不新造语义。
 * @param {object} c - 候选（含 observationAuthorities：其成员 observation 的 authority）
 * @param {object[]} [evidence]
 * @returns {object}
 */
export function enrichCandidate(c, evidence = []) {
  const { domains, authorities } = lookupEvidenceSupport(evidence)
  const obs = Array.isArray(c.observationAuthorities) ? c.observationAuthorities : []
  return {
    ...c,
    evidenceDomains: domains,
    evidenceAuthorities: authorities,
    evidenceAuthority: authorities.length ? deriveObservationAuthority(authorities) : null,
    conclusionAuthority: obs.length ? deriveObservationAuthority(obs) : null,
    supportDomains: supportDomains(c.claimDomain, domains),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 回链档位（2026-09-25，方案 3）：把「无证据回链」这一句话拆成两档
// ---------------------------------------------------------------------------
// 此前 `无证据回链` 一视同仁，把两种完全不同的处境压成同一个字符串：
//   · 外机导入的行 —— `scripts/ledger-import.mjs:82-85` **按设计**清空了 evidenceIds
//     （evidence 不跨机，跨机引用必然悬空）。这是**结构事实**，不是本机数据缺陷。
//   · 本机蒸馏产出的行却没有回链 —— 这才是**真异常**（W 机今天 0 条，护栏见 consolidate/store）。
// 读的人（和后来的 agent）看到同一个「无证据回链」，只能理解成「我们这边的数据有问题」。
//
// **判据不放宽**：两类都仍然挡下。回链不可核验就进不了 staging —— 若放行，
// 572 个簇会从「已知缺证据」变成「看起来有证据」（K 报告 §5.3 的陷阱：
// 回填后 1393 个源侧 evidence id 在本机 100% 不可解析）。
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 一个候选的回链档位：看它的**成员 observation**（候选池与 observation 物理分离，
 * 档位只存在于 observation 侧）。
 *   · 有任一成员是「本机缺回链」→ missing_backlink（真异常，优先报）
 *   · 成员全部是「外机不可核验」→ unverifiable_foreign
 *   · 无成员 / 认不出来 → null（调用方沿用旧文案，向后兼容）
 * @param {object[]} observations - 成员 observation 行（camelCase）
 * @returns {'missing_backlink'|'unverifiable_foreign'|null}
 */
export function candidateBacklinkTier(observations) {
  const tiers = (Array.isArray(observations) ? observations : [])
    .filter(Boolean)
    .map((o) => classifyBacklink(o).tier)
  if (tiers.includes('missing_backlink')) return 'missing_backlink'
  if (tiers.length > 0 && tiers.every((t) => t === 'unverifiable_foreign')) return 'unverifiable_foreign'
  return null
}

/**
 * 「无回链」挡下理由：按档位分开说。**不改放不放**，只改怎么说。
 * @param {object} c - 候选（可选带 backlinkTier）
 * @returns {string}
 */
export function noBacklinkReason(c) {
  if (c?.backlinkTier === 'unverifiable_foreign') {
    return '不可核验（外机导入：回链按设计不跨机清空，引用的源侧 id 在本机不可解析）'
  }
  if (c?.backlinkTier === 'missing_backlink') {
    return '无证据回链（本机产出的 observation 却无回链 —— 真异常，查蒸馏写入路径）'
  }
  return '无证据回链'
}

/**
 * 判据 A/B 的准入判定（纯函数，两处复刻的核心）。null = 放行，字符串 = 挡下理由。
 * @param {object} c - 候选（须含支持域与两侧 authority；缺字段 = 不可核验）
 * @param {object} [opts]
 * @returns {string|null}
 */
export function stagingBlockReason(c, opts = {}) {
  if (looksEphemeral(c.text)) return 'ephemeral（进度快照，B19 判据）'
  if ((c.evidenceIds ?? []).length === 0) return noBacklinkReason(c)
  const domains = c.supportDomains ?? supportDomains(c.claimDomain, c.evidenceDomains)
  if (!looksCrossDomain(domains, opts.minDomains ?? CROSS_DOMAIN_MIN)) {
    return '域内复述（支撑域 ' + (domains.join('+') || '?') + ' < ' + (opts.minDomains ?? CROSS_DOMAIN_MIN)
      + '）——跨域重组有价值，域内复述没有（Discovery by Dreaming 2607.16256）'
  }
  const minEv = (c.evidenceAuthorities ?? []).slice().sort((a, b) => rankOf(a) - rankOf(b))[0]
  if (!c.conclusionAuthority || !minEv) return 'authority 不可核验（缺 conclusionAuthority / evidenceAuthority）'
  if (rankOf(c.conclusionAuthority) > rankOf(minEv)) {
    return 'authority 不得放大：结论=' + c.conclusionAuthority + ' > 支撑最低=' + minEv
      + '（AuthMem-Bench 2608.01679）'
  }
  return null
}

/** 本地秩表（与 src/policy.mjs 的 AUTHORITY_RANK 同序；脚本可在无仓环境下独立跑）。 */
const RANK = Object.freeze({
  user_correction: 6,
  user_explicit: 5,
  system_policy: 4,
  external_information: 3,
  single_observation: 2,
  agent_inference: 1,
  agent_self_evaluation: 0,
})

/** @returns {number} 未知值 → -1（比任何已知值都低 → 会被判为放大并挡下，fail-safe） */
function rankOf(authority) {
  const r = RANK[authority]
  return r === undefined ? -1 : r
}


export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  return {
    dir: a.dir || path.join(resolveDshHome(), 'acp'),
    state: a.state || 'approved',
    lib: a.lib || '',
    out: a.out || '',
    cloudOut: a['cloud-out'] || '',
    // 2026-09-25：此前 deviceId/exportedAt 只读 opts 却没人解析 → 恒为 undefined，
    // manifest 的 deviceId 永远写 'unknown'，scp 到 inbound-acp/<slot>/ 时不知道该进哪个槽。
    // 约定与 wv-sync.ps1 一致：WEAVER_SLOT 环境变量，缺省 w（本机 W 机）。
    deviceId: a.device || process.env.WEAVER_SLOT || 'w',
    exportedAt: a['exported-at'] || '',
    limit: Number(a.limit || 0) || 0,
    json: a.json === '1' || a.json === 'true',
  }
}

/** title = 正文截取（不做摘要、不改写）。优先在标点处收尾，收不到就硬截。 */
export function deriveTitle(text, subject = '', max = 48) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return subject || '(无正文)'
  const head = t.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('，'),
    head.lastIndexOf('.'), head.lastIndexOf(';'), head.lastIndexOf(','))
  return (cut >= 12 ? head.slice(0, cut) : head).trim()
}

/** 溯源脚注：weaver 条目要能回到 ACP 的证据链（对应 CONTRACTS 的可回溯要求） */
export function provenanceFooter(c, minEvidence = 12) {
  const ev = (c.evidenceIds ?? []).slice(0, 20)
  return [
    '',
    '---',
    '来源：ACP dreaming 候选 ' + c.id + '（claimDomain=' + c.claimDomain + '）',
    '复现：' + c.occurrences + ' 次 · ' + (c.sessions ?? []).length + ' 个会话 · ' + c.days + ' 个自然日',
    '区间：' + (c.firstSeen || '?') + ' → ' + (c.lastSeen || '?'),
    '证据回链（' + (c.evidenceIds ?? []).length + ' 条，示前 ' + Math.min(minEvidence, ev.length) + '）：' + ev.join(' '),
  ].join('\n')
}

/** 候选 → wv import 记录（纯函数，可测） */
export function toWeaverRecord(c, opts = {}) {
  const text = String(c.text ?? '').trim()
  let conf = c.occurrences >= 3 ? 0.9 : c.occurrences === 2 ? 0.8 : 0.7
  // ACP-B19：进度快照降权（不挡下）—— 标注 + 减 confidence，让人一眼看出该复核
  const ephemeral = looksEphemeral(text)
  if (ephemeral) conf = Math.max(0.5, Number((conf - 0.2).toFixed(2)))
  const rec = {
    title: deriveTitle(text, c.subject),
    summary: text.slice(0, 200),
    body: text + provenanceFooter(c),
    source: 'acp-dreaming:' + c.id,
    tags: ephemeral ? ['acp-dreaming', c.claimDomain, 'ephemeral'] : ['acp-dreaming', c.claimDomain],
    confidence: conf,
  }
  if (opts.lib) rec.library = opts.lib
  return rec
}

/** 白名单过滤 + 组装。返回 {records, blocked, skipped} */
export function buildExport(candidates, opts = {}) {
  const records = []
  const blocked = []
  for (const c of candidates) {
    if (!EXPORTABLE_DOMAINS.includes(c.claimDomain)) {
      // 2026-09-24：原先 block 不带 reason，输出层用「画像域」兜底 → 把 experience 这类
      // 「只是不在白名单」的域误标成画像域（实测 46 条里大半是 experience）。这里把两种原因分开。
      const isProfile = BLOCKED_DOMAINS.includes(c.claimDomain)
      blocked.push({
        id: c.id,
        domain: c.claimDomain,
        reason: isProfile ? '画像域，永不出 ACP' : '不在导出白名单（仅 work / external_fact）',
      })
      continue
    }
    if ((c.evidenceIds ?? []).length === 0) { blocked.push({ id: c.id, domain: c.claimDomain, reason: noBacklinkReason(c) }); continue }
    records.push(toWeaverRecord(c, opts))
  }
  return { records, blocked }
}

/**
 * 候选 → **云端 staging 记录**（DREAMING §11 通道的入口格式，2026-09-24）。
 * 与 toWeaverRecord 的区别：那个是「给 wv import 的记录」，这个是「给云端接纳器的记录」。
 * 候选**还没有 lib** —— 那是精馏要决定的事，所以这里不猜、不填。
 */
export function toStagingRecord(c, rec) {
  return {
    schema: 'dsh.acp.candidate/v1',
    candId: c.id,
    // ★ 跨机复现的判据用 subject 而不是 candId（2026-09-24 修正）：
    //   candId = hash(scopeId|claimDomain|subject|observationIds)，而 observationIds 是**各机本地的**，
    //   所以同一件事在三机算出的是**不同的 id** —— 拿 id 比对永远算不出「跨机复现」。
    subject: c.subject ?? null,
    claimDomain: c.claimDomain ?? null,
    title: rec.title,
    summary: rec.summary,
    body: rec.body,
    source: rec.source,
    tags: rec.tags,
    confidence: rec.confidence,
    // 2026-09-25（DREAMING 收尾实测）：**必须输出 occurrences**——promote 的判据 B（本机复现 >= N）
    // 读的就是这个字段，此前没输出它 → staging 记录里没有该键 → occ 恒为 0、判据 B 永不成立。
    // sessions 出条数（不是数组）避免把各机会话 id 固化进 staging。
    occurrences: c.occurrences ?? 0,
    sessions: Array.isArray(c.sessions) ? c.sessions.length : (c.sessions ?? null),
    days: c.days ?? null,
    // 2026-09-25（判据 A/B）：staging 是**跨机**通道，云端 promote 手上只有这条记录——
    //   staging.db 里没有 ACP 账本可查。所以支撑域与两侧 authority 必须**随记录带过去**，
    //   否则判据在云端无法核验（那就要么静默放行、要么全靠猜）。
    evidenceDomains: Array.isArray(c.evidenceDomains) ? c.evidenceDomains : [],
    supportDomains: c.supportDomains ?? supportDomains(c.claimDomain, c.evidenceDomains),
    crossDomain: looksCrossDomain(c.supportDomains ?? supportDomains(c.claimDomain, c.evidenceDomains)),
    conclusionAuthority: c.conclusionAuthority ?? null,
    evidenceAuthority: c.evidenceAuthority ?? null,
  }
}

/**
 * 组装 staging 导出（判据 A/B 的落地点）。
 * 与 buildExport 的区别：buildExport 管「出不出 ACP」（白名单 + 证据回链）；
 * 本函数管「进不进 staging」（跨域 + 不放大 + ephemeral + 有证据）。
 * @param {object[]} candidates - 候选行
 * @param {object} [opts] - { minDomains }
 * @returns {{records:object[], blocked:object[]}}
 */
export function buildStagingExport(candidates, opts = {}) {
  const records = []
  const blocked = []
  for (const c of candidates) {
    // 第一道仍然是**导出白名单**（画像三域永不出 ACP，DREAMING §10.2）。
    // 2026-09-25 实测修正：staging 闸门起初只查判据 A/B，会把 user_preference 写进 staging 记录
    // ——DREAMING §11.4 的前提「白名单已挡画像三域」并不成立（那段代码当时只作用于本地 JSONL）。
    if (!EXPORTABLE_DOMAINS.includes(c.claimDomain)) {
      const isProfile = BLOCKED_DOMAINS.includes(c.claimDomain)
      blocked.push({
        id: c.id,
        domain: c.claimDomain,
        reason: isProfile ? '画像域，永不出 ACP' : '不在导出白名单（仅 work / external_fact）',
      })
      continue
    }
    const reason = stagingBlockReason(c, opts)
    if (reason) { blocked.push({ id: c.id, domain: c.claimDomain, reason }); continue }
    const rec = toWeaverRecord(c, opts)
    records.push(toStagingRecord(c, rec))
  }
  return { records, blocked }
}

/** 组装 staging 文件正文：首行 manifest + 每行候选（与 wv-sync 的 inbound 同构，但走**独立通道**） */
export function toStagingPayload(records, deviceId, exportedAt) {
  const man = {
    schema: 'dsh.acp.staging/v1',
    deviceId: deviceId || 'unknown',
    exportedAt: exportedAt || new Date().toISOString(),
    count: records.length,
  }
  const NL = String.fromCharCode(10)
  return [JSON.stringify(man), ...records.map((r) => JSON.stringify(r))].join(NL) + NL
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'dream-export.mjs'))
})()

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const file = path.join(opts.dir, DEFAULT_DB_NAME)
  if (!existsSync(file)) { console.error('[export] 账本不存在: ' + file); process.exit(2) }
  const ledger = openEvidenceLedger({ dir: opts.dir })
  try {
    const res = ledger.queryCandidateMemory({ state: opts.state, limit: opts.limit || 500 })
    const { records, blocked } = buildExport(res.items, { lib: opts.lib })
    // 判据 A/B 需要两样 staged 记录里没有的东西：支撑证据的域、以及两侧 authority。
    // 账本在本地，所以在这里查好、随记录带过机（云端只有 staging.db）。
    const evCache = new Map()
    const lookup = (ids) => (Array.isArray(ids) ? ids : []).map((id) => {
      if (!evCache.has(id)) evCache.set(id, ledger.getById(id) || null)
      return evCache.get(id)
    })
    // 判据 B 的另一侧：结论的 authority 来自**成员 observation 的 authority 列**
    // （那列是 evidence→observation 那一步按非放大算好的，见 store.deriveObservationAuthority）。
    // 2026-09-25 实测发现：不取它 → conclusionAuthority 恒为 null → 全部候选判「不可核验」。
    const enriched = res.items.map((c) => {
      const members = (c.observationIds ?? []).map((oid) => ledger.getObservationById(oid)).filter(Boolean)
      return enrichCandidate({
        ...c,
        // 回链档位（方案 3）：候选自己不带 evidenceIds（physical separation），
        // 档位在成员 observation 上 —— 在这里查好带下去，挡下理由才说得准。
        backlinkTier: candidateBacklinkTier(members),
        observationAuthorities: members.map((m) => m.authority).filter(Boolean),
      }, lookup(c.evidenceIds))
    })
    const stagingRes = buildStagingExport(enriched, { lib: opts.lib })
    if (opts.json) { console.log(JSON.stringify({ records, blocked, staging: stagingRes.records, stagingBlocked: stagingRes.blocked }, null, 2)); return }
    console.log('[export] state=' + opts.state + '  匹配 ' + res.total + ' 条'
      + (opts.lib ? '  --lib ' + opts.lib : '  （未给 --lib，导入时需 wv import --lib <lib>）'))
    for (const b of blocked) {
      console.log('  [挡下] ' + b.domain + '（' + (b.reason || '被挡下') + '）  ' + b.id)
    }
    console.log('  可导出 ' + records.length + ' 条，挡下 ' + blocked.length + ' 条')
    const jsonl = records.map((r) => JSON.stringify(r)).join('\n')
    if (opts.cloudOut) {
      // 两条独立的链：buildExport 管「出不出 ACP」（白名单），buildStagingExport 管「进不进 staging」
      // （判据 A 跨域 + 判据 B 不放大 + B19 ephemeral + 有证据回链）。staging 只走后者。
      const staging = stagingRes.records
      writeFileSync(opts.cloudOut, toStagingPayload(staging, opts.deviceId || '', opts.exportedAt || ''), 'utf8')
      console.log('[export] staging 闸门：可进 ' + staging.length + ' 条 · 挡下 ' + stagingRes.blocked.length + ' 条')
      for (const b of stagingRes.blocked) {
        console.log('  [staging 挡下] ' + (b.domain || '?') + '（' + b.reason + '）  ' + b.id)
      }
      console.log('[export] 已写 staging 格式 ' + opts.cloudOut + '（' + staging.length + ' 条，供云端接纳器）')
      console.log('[export] 下一步：scp 到 <weaver>/inbound-acp/<slot>/ 后跑 wv-staging-accept.mjs')
    }
    if (opts.out) {
      writeFileSync(opts.out, jsonl + '\n', 'utf8')
      console.log('[export] 已写 ' + opts.out)
      console.log('[export] 下一步（人工）：wv import ' + opts.out + (opts.lib ? ' --lib ' + opts.lib : ' --lib <lib>'))
    } else {
      console.log('--- 预览（给 --out <file> 才落盘）---')
      console.log(jsonl.slice(0, 1600))
    }
  } finally { ledger.close() }
}

if (isMain) main()
