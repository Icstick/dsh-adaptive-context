// src/release-gate.mjs — 跨机 observation 放行闸门（P1-4.1 S3 第二批）
// ---------------------------------------------------------------------------
// 判据来源（两份，都不是临时想的）：
//   ① 云端第二批任务 2：docs/plans/cloud-batch-2-20260923.md「ACP 第二批过滤规则设计」
//      统一接口 (class, decision, evidence_span, confidence)；归一前置；锚点豁免；阈值皆配置。
//   ② 本机第一批抽样：docs/ops/s3-batch1-release-20260922.md §3
//      472 条中 20 条噪声（4.2%）：英文残留 / 会话临时态伪装成事实 / 自指·机器味。
//
// 与旧实现的关系：旧 qualityVerdict()（三个正则一票否决，原在 scripts/ledger-release.mjs）
//   仍可用（兼容包装），但判定已由本模块承担 —— 拆成**七类 + 三档决定**，并保证
//   **任何规则都不静默丢弃条目**：hard 留在隔离区（人工队列），soft 单独成列。
//
// 两条顺序约定（重要，别改）：
//   a) ①②③（英文 / 自指 / 临时态）吃「锚点豁免」：命中外部锚点即降一级。
//   b) ④⑤⑥⑦（环境绑定 / 一次性路径 / 过期版本 / 纯情绪）**不吃豁免** —— 它们处理的
//      正好是「这个锚点只在某台机器/某个时刻成立」。豁免条款与它们的分工不能混。
//
// 处置不对称（云端的核心取舍，本地实测同意）：漏放会污染所有下游机，误杀只花审核工时。

/** 七类的优先级：同一条命中多类时取首个 hard 作主因，其余进 tags。 */
export const GATE_CLASSES = Object.freeze([
  'english', 'selfref', 'ephemeral', 'env-bound', 'one-shot-path', 'stale-version', 'empty-emotion',
])

/** 阈值（云端「阈值皆配置」）：本对象是唯一数字来源，规则里不许再写死数字。 */
export const GATE_CONFIG = Object.freeze({
  // 本地校准（2026-09-24）：云端的 c == 0 硬线会放过第一批点名的真实噪声
  // 「User referred to the assistant as 姐姐 when asking for help.」（c=2）
  // → 硬线改为 c<=3 且 l>=24。soft 线沿用云端原值。
  english: Object.freeze({ hardMaxCjk: 3, hardMinLatin: 24, softMaxCjk: 20, softMinLatin: 100 }),
  ephemeral: Object.freeze({ hardFamilies: 2, softFamilies: 1, tailDistanceMax: 3 }),
  selfref: Object.freeze({ externalActionMin: 1 }),
  envBound: Object.freeze({ decision: 'soft_tag' }),
  oneShotPath: Object.freeze({ decision: 'hard_quarantine' }),
  staleVersion: Object.freeze({ decision: 'soft_tag' }),
  emptyEmotion: Object.freeze({ maxChars: 24, minContentWords: 5, decision: 'hard_quarantine' }),
  /** 实测校准后可整类关掉（误杀回归证据留在 docs/ops）。 */
  disabled: Object.freeze([]),
})

export const GATE_DECISIONS = Object.freeze(['pass', 'soft_tag', 'hard_quarantine'])

/** 配置校验：坏配置要早失败，别让它静默退化成「全放行」。 */
export function assertGateConfig(cfg = GATE_CONFIG) {
  const num = (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('gate config: ' + name + ' 必须是非负数字')
  }
  for (const k of ['hardMaxCjk', 'hardMinLatin', 'softMaxCjk', 'softMinLatin']) num(cfg.english[k], 'english.' + k)
  for (const k of ['hardFamilies', 'softFamilies', 'tailDistanceMax']) num(cfg.ephemeral[k], 'ephemeral.' + k)
  num(cfg.selfref.externalActionMin, 'selfref.externalActionMin')
  num(cfg.emptyEmotion.maxChars, 'emptyEmotion.maxChars')
  for (const k of ['envBound', 'oneShotPath', 'staleVersion', 'emptyEmotion']) {
    if (!GATE_DECISIONS.includes(cfg[k].decision)) throw new Error('gate config: ' + k + '.decision 非法')
  }
  if (!Array.isArray(cfg.disabled)) throw new Error('gate config: disabled 必须是数组')
  return true
}

// ── 归一前置（云端 §0）──────────────────────────────────────────────────────
// 判定前剥离 fenced code / 缩进块 / 行首 $ 命令行 / inline code / URL / 行内路径，
// 只对自然语言主体判定；被剥离片段单独留存，供锚点检测使用。
// 剥离顺序有意义：先整块（fence/缩进），再行内（inline/URL/路径）。

const FENCE_RE = /[\u0060]{3,}[\s\S]*?(?:[\u0060]{3,}|$)/g
const TILDE_FENCE_RE = /~{3,}[\s\S]*?(?:~{3,}|$)/g
const INDENT_BLOCK_RE = /^(?: {4,}|\t+)\S.*$/gm
const SHELL_LINE_RE = /^[ \t]*\$.{0,200}$/gm
const INLINE_CODE_RE = /[\u0060][^\u0060\n]*[\u0060]/g
const URL_RE = /(?:https?:\/\/|www\.)[^\s，。；、）)】」]+/g
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s，。；、）)】」]*/g
const NIX_PATH_RE = /(?:\/[\w.@+-]+){2,}\/?/g

/**
 * 归一：剥离非自然语言片段。
 * @returns {{ body: string, spans: Array<{kind:string,text:string}> }}
 */
export function stripNonProse(text) {
  const src = String(text ?? '')
  const spans = []
  let body = src
  const cut = (re, kind) => {
    body = body.replace(re, (m) => { spans.push({ kind, text: m }); return ' ' })
  }
  cut(FENCE_RE, 'fence')
  cut(TILDE_FENCE_RE, 'fence')
  cut(INDENT_BLOCK_RE, 'indent')
  cut(SHELL_LINE_RE, 'shell')
  cut(INLINE_CODE_RE, 'inline-code')
  cut(URL_RE, 'url')
  cut(WIN_PATH_RE, 'path')
  cut(NIX_PATH_RE, 'path')
  return { body: body.replace(/[ \t]{2,}/g, ' ').trim(), spans }
}

// ── 外部锚点（云端 §0「锚点豁免」）──────────────────────────────────────────
// 绝对路径 / URL / commit SHA / ISO 日期 / 版本号 —— 命中的类降一级处理。

const ANCHOR_RES = [
  ['url', /(?:https?:\/\/|www\.)\S+/],
  ['abs-path', /[A-Za-z]:[\\/]|(?:\/(?:home|Users|usr|etc|var|opt|mnt|tmp|srv)\/)/],
  // commit：按 git 惯例取 ≥7 位（云端反例里写的是 6 位 a1b2c3）。这里是**放宽方向**的
  // 锚点，宁可少认也不能把普通十六进制串都当锚点 —— 故不跟着放宽到 6 位。
  ['commit', /\b[0-9a-f]{7,40}\b/],
  ['iso-date', /\b\d{4}-\d{2}-\d{2}\b/],
  ['version', /\bv?\d+\.\d+(?:\.\d+)?\b/],
]

/** 在**全文**（含被剥离片段）里找外部锚点。 */
export function findAnchors(text) {
  const s = String(text ?? '')
  const hits = []
  for (const [kind, re] of ANCHOR_RES) {
    const m = s.match(re)
    // commit 要含数字：否则 deadbeef / defaced 这类英文词会被当成 SHA（放宽方向，但没必要噪声）
    if (m && !(kind === 'commit' && !/\d/.test(m[0]))) hits.push({ kind, span: m[0] })
  }
  return hits
}

// ── 计数 ────────────────────────────────────────────────────────────────────
export function cjkCount(s) {
  const m = String(s ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)
  return m ? m.length : 0
}
export function latinCount(s) {
  const m = String(s ?? '').match(/[A-Za-z]/g)
  return m ? m.length : 0
}

// ── ①②③ 的判据 ─────────────────────────────────────────────────────────────

// 族词表（会话临时态）。S1–S4 来自云端判据；S6 是本机第一批抽样的校准补充：
// 真实噪声「用户同意继续当前任务」「用户已重启，先试7B精度」在云端 S1–S4 词表下
// **一条都不命中**，但它们确实是会话内状态通报。
export const EPHEMERAL_FAMILIES = Object.freeze({
  // 2026-09-24 跨机复评校准：B 机隔离区里「表明**当前会话**涉及…」「**当前会话**这边可以不管」
  // 两条漏放 —— 云端 S1 收的是「现在/目前/本次/本轮」，没收「当前」。
  // 只收「当前 + 会话性名词」，否则会把「当前版本为 X」这类正常陈述误伤（⑥ 的回归锁着它）。
  S1: /这个|那个|刚才|刚刚|上面|前面|现在|目前|本次|本轮|当前(?:会话|任务|工作|这)/,
  S2: /正在做|正在|在做|接下来要|待会儿|稍后|下一步/,
  S3: /先[^，。；！？]{0,8}(?:试试|试下|试一下)|暂时|占位|还没|回头再|(?:还|仍|遗留)?待办(?:中|：|:)|待办事项/,
  S4: /上一轮|前面那条|第\s*\d+\s*步/,
  // S6 刻意**不收**「本轮已 / 本次已」：S1 已含「本轮 / 本次」，单族命中只判 soft。
  // 实测（2026-09-24）：收了会把「复制 systemd unit 并修改 WORKER_ID 即可；本次已确认扩容到 4 个
  // cloud worker」这类**有效工作事实**判 hard —— 那是误杀，不是治理。
  S6: /同意继续|继续当前任务|已重启|已安装完成|已处理完|待办已|目前已/,
})

/** 单族命中即 hard 的族（S6：完成态通报本身就是会话内噪声）。 */
export const HARD_SINGLE_FAMILIES = Object.freeze(['S6'])

/** 外部动作动词 —— 自指类的关键豁免：句子在讲外部对象时不算自指。 */
const EXTERNAL_ACTION_RE = /实现|修复|部署|提交|合并|安装|配置|编译|测试|上线|回滚|改成|调到|写入|导出|导入|推送|拉取|删除|创建|新增|重构|升级|迁移|替换|调用|注入/

/** 自指强命中：宾语是「对话产物」，或第二人称在指对话本身。 */
const SELFREF_STRONG_RE = /(?:你|您|助手|模型|assistant)\s*(?:刚才|之前|上面)?\s*(?:说|写|给|建议|提)的|这句话|这条消息|这个回答|上面的解释|我前面写|这个总结|我是说|我的意思是|让我重新表述|总结一下上面/

/** 自指弱命中：这个/该 + 抽象名词（仅无锚点时升级）。 */
const SELFREF_WEAK_RE = /(?:这个|该)(?:方案|说法|措辞|表述|思路|做法|结论)/

/** 旧实现的「机器味主语」判据（第一批抽样第三类的直接来源）。 */
export const SELFREF_SUBJECT_RE = /^(user|assistant|agent|session|subagent|tool)\b|^user-|^assistant-|^session-/i

/**
 * 英文残留的硬线（本地校准语义）：CJK 极少且拉丁字母够多。
 * 注意这**不是**「整条无中文」—— 第一批真实噪声里就夹着引号内的中文专名。
 */
export function isEnglishOnly(text, cfg = GATE_CONFIG) {
  const { body } = stripNonProse(text)
  return cjkCount(body) <= cfg.english.hardMaxCjk && latinCount(body) >= cfg.english.hardMinLatin
}

function classifyEnglish(row, body, cfg) {
  if (cfg.disabled.includes('english')) return null
  if (row.source_locale && row.source_locale !== 'zh') return null // 云端约定：非 zh 行本类不适用
  const c = cjkCount(body)
  const l = latinCount(body)
  if (c <= cfg.english.hardMaxCjk && l >= cfg.english.hardMinLatin) {
    return { cls: 'english', level: 'hard', span: body.slice(0, 60), confidence: 0.9, tags: ['c=' + c, 'l=' + l] }
  }
  if (c < cfg.english.softMaxCjk && l >= cfg.english.softMinLatin) {
    return { cls: 'english', level: 'soft', span: body.slice(0, 60), confidence: 0.6, tags: ['c=' + c, 'l=' + l] }
  }
  return null
}

function classifySelfref(subject, body, cfg) {
  if (cfg.disabled.includes('selfref')) return []
  const out = []
  // 实测校准：机器主语必须是**纯 ASCII 的机器名/机器短语**。中文复合主语（「session 列表」
  // 「tool-calls 调度器改动」）指的是外部功能或产物，不是「对话本身」，判 hard 会误杀。
  if (SELFREF_SUBJECT_RE.test(subject) && !/[\u4e00-\u9fff]/.test(subject)) {
    out.push({ cls: 'selfref', level: 'hard', span: subject, confidence: 0.9, tags: ['machine-subject'] })
  }
  if (SELFREF_STRONG_RE.test(body)) {
    const hasAction = EXTERNAL_ACTION_RE.test(body)
    out.push({
      cls: 'selfref',
      level: hasAction ? 'soft' : 'hard',
      span: body.slice(0, 60),
      confidence: hasAction ? 0.5 : 0.8,
      tags: [hasAction ? 'dialogue-product+external-action' : 'dialogue-product'],
    })
  }
  if (SELFREF_WEAK_RE.test(body)) {
    out.push({ cls: 'selfref', level: 'soft', span: body.slice(0, 60), confidence: 0.5, tags: ['weak-anaphora'] })
  }
  return out
}

function classifyEphemeral(row, body, cfg) {
  if (cfg.disabled.includes('ephemeral')) return null
  const fams = Object.keys(EPHEMERAL_FAMILIES).filter((k) => EPHEMERAL_FAMILIES[k].test(body))
  if (fams.length === 0) return null
  // S5（源会话内距末尾 ≤ N 条）在 observation 表里**没有数据源**（表无该列，跨机 JSONL
  // 也不带）。判据保留为「若 row 提供了 sessionTailDistance 才生效」，否则该族等效禁用。
  const tail = Number(row.sessionTailDistance ?? row.tailDistance ?? NaN)
  let level = null
  if (fams.some((k) => HARD_SINGLE_FAMILIES.includes(k))) level = 'hard'
  else if (fams.length >= cfg.ephemeral.hardFamilies) level = 'hard'
  else if (Number.isFinite(tail) && tail <= cfg.ephemeral.tailDistanceMax) level = 'hard'
  else if (fams.length >= cfg.ephemeral.softFamilies) level = 'soft'
  if (!level) return null
  return { cls: 'ephemeral', level, span: body.slice(0, 60), confidence: level === 'hard' ? 0.75 : 0.5, tags: fams }
}

// ── ④⑤⑥⑦ 判据（不吃锚点豁免——它们处理的正是「锚点只在某机/某时成立」）──────

/** ④ 环境绑定：用户目录 / 本机回环 —— 换机即错。
 *  实测校准（2026-09-24）：私有网段（10.x / 192.168.x）**不算**环境绑定 ——
 *  ZeroTier 地址是三机共享的事实，s3 第一批报告 §2 正是拿「含 10.173.250 = 4」
 *  当放行效果的证据。把网段算进来会误杀跨机最有用的那批条目。 */
const ENV_SHAPE_RE = /\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\|\blocalhost:\d+|\b127\.0\.0\.1:\d+/
// 绝对路径**不判环境绑定**，只打 tag（实测校准 2026-09-24）：
//   - D:\DSH_workspace 是三机共识路径（P6 目录约定），跨机成立；
//   - E:\… / /mnt/… 在目标机是否存在，闸门**无法知道** —— 不装懂。
// 上一版把它算 env-bound，78 条已放行里误杀 4 条（其中一条还是把
// 「Qstar/Hstar/Astar/Dstar」这种斜杠枚举当路径）。改为只打 tag 供人工筛。
const ABS_PATH_ANY_RE = /[A-Za-z]:[\\/][^\s，。；、）)】」]{2,}/
/** 常见根前缀的 unix 路径（要前置边界，避免把「prj/prg/tim/lvl」这类枚举当路径）。 */
const NIX_PATH_ANY_RE = /(?:^|[\s，。；、（("'])\/(?:home|Users|users|mnt|media|opt|srv|var|tmp|data|datadisk|root|etc|workspace|workspaces)\/[\w.@+-]+/

/** ⑤ 一次性路径：临时目录产物 —— 换机直接解析失败。 */
const ONE_SHOT_RE = /\/tmp\/|\/var\/folders\/|\bmktemp\b|[\w-]+\.tmp\b/

/** ⑥ 过期版本 / 时效断言：版本号 + 时效词，且行未标 archived。 */
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/
const STALE_CLAIM_RE = /最新|现在(?:用|是)|以后不用|目前(?:是|最新)|已经过时|当前最新/

/** ⑦ 内容空洞的纯情绪：短、无外部动作、实词少、有情绪词。 */
const EMOTION_RE = /太(?:爽|好|棒|强)|终于|哈哈|舒服|绝了|崩溃|糟糕|难受|开心|难过/g
const CONTENT_WORD_RE = /[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}|\d+/g

const levelOf = (decision) => (decision === 'hard_quarantine' ? 'hard' : 'soft')

function classifyEnvBound(view, cfg) {
  if (cfg.disabled.includes('env-bound')) return null
  const m = view.match(ENV_SHAPE_RE)
  if (!m) return null
  return { cls: 'env-bound', level: levelOf(cfg.envBound.decision), span: m[0], confidence: 0.6, tags: ['env-bound?'] }
}

function classifyOneShotPath(body, cfg) {
  if (cfg.disabled.includes('one-shot-path')) return null
  const m = body.match(ONE_SHOT_RE)
  if (!m) return null
  return { cls: 'one-shot-path', level: levelOf(cfg.oneShotPath.decision), span: m[0], confidence: 0.7, tags: ['one-shot'] }
}

function classifyStaleVersion(body, cfg) {
  if (cfg.disabled.includes('stale-version')) return null
  const v = body.match(VERSION_RE)
  if (!v || !STALE_CLAIM_RE.test(body)) return null
  return { cls: 'stale-version', level: levelOf(cfg.staleVersion.decision), span: v[0], confidence: 0.5, tags: ['time-bound'] }
}

function classifyEmptyEmotion(body, cfg) {
  if (cfg.disabled.includes('empty-emotion')) return null
  if (body.length > cfg.emptyEmotion.maxChars) return null
  if (EXTERNAL_ACTION_RE.test(body)) return null
  const emo = (body.match(EMOTION_RE) || []).length
  if (emo === 0) return null
  const words = (body.match(CONTENT_WORD_RE) || []).length
  if (words >= cfg.emptyEmotion.minContentWords) return null
  return { cls: 'empty-emotion', level: levelOf(cfg.emptyEmotion.decision), span: body, confidence: 0.7, tags: ['words=' + words] }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

/** 吃锚点豁免的三类（云端 §0）：hard→soft，soft→pass。其余四类不吃。 */
export const ANCHOR_EXEMPTIBLE = Object.freeze(['english', 'selfref', 'ephemeral'])

const downgrade = (lvl) => (lvl === 'hard' ? 'soft' : 'pass')

/**
 * 单条 observation 的闸门判定（统一接口：class / decision / evidence_span / confidence）。
 * @param {object} row 账本行（text / subject 必读；source_locale、sessionTailDistance 可选）
 * @param {typeof GATE_CONFIG} [cfg]
 * @returns {{class:string|null, decision:'pass'|'soft_tag'|'hard_quarantine', evidence_span:string,
 *            confidence:number, anchors:Array<{kind:string,span:string}>, tags:string[], hits:Array<object>}}
 */
export function gateVerdict(row = {}, cfg = GATE_CONFIG) {
  assertGateConfig(cfg)
  const text = String(row.text ?? '')
  const subject = String(row.subject ?? '')
  const { body, spans } = stripNonProse(text)
  const anchors = findAnchors(text)
  const hits = []
  const push = (h) => { if (Array.isArray(h)) hits.push(...h); else if (h) hits.push(h) }
  push(classifyEnglish(row, body, cfg))
  push(classifyEphemeral(row, body, cfg))
  push(classifySelfref(subject, body, cfg))
  // ④⑤ 看「含路径的视图」：归一前置把路径摘掉了（那是给 ①②③ 用的自然语言主体），
  // 而这两类要判的**正是路径本身** —— 所以把 path span 拼回来（URL / 代码块仍排除）。
  // 2026-09-24 实测：用 body 判等于永不命中（qc 行 obs_0b8ce5 的 E:\Files\… 就是这么漏过去的）。
  const pathView = [body, ...spans.filter((s) => s.kind === 'path').map((s) => s.text)].join(' ')
  push(classifyEnvBound(pathView, cfg))
  push(classifyOneShotPath(pathView, cfg))
  push(classifyStaleVersion(body, cfg))
  push(classifyEmptyEmotion(body, cfg))

  const exempt = anchors.length > 0
  const graded = hits
    .map((h) => (exempt && ANCHOR_EXEMPTIBLE.includes(h.cls) ? { ...h, level: downgrade(h.level), byAnchor: true } : h))
    .filter((h) => h.level !== 'pass')

  const order = (c) => GATE_CLASSES.indexOf(c)
  graded.sort((a, b) => (a.level === b.level ? order(a.cls) - order(b.cls) : (a.level === 'hard' ? -1 : 1)))

  const main = graded[0] || null
  const decision = !main ? 'pass' : (main.level === 'hard' ? 'hard_quarantine' : 'soft_tag')
  // 绝对路径只进 tag，不改判：它是「人工该看一眼」的提示，不是可自动判定的噪声。
  const pathTag = ABS_PATH_ANY_RE.test(pathView) || NIX_PATH_ANY_RE.test(pathView) ? ['abs-path?'] : []
  return {
    class: main ? main.cls : null,
    decision,
    evidence_span: main ? main.span : '',
    confidence: main ? main.confidence : 1,
    anchors,
    strippedSpans: spans.length,
    tags: [...new Set([...graded.flatMap((h) => h.tags ?? []), ...pathTag])],
    hits: graded.map((h) => ({ class: h.cls, level: h.level, span: String(h.span).slice(0, 40), byAnchor: !!h.byAnchor })),
  }
}

/** 旧拒因名（第一批报告与运维脚本按这个读，别改）。 */
export const LEGACY_REJECT_NAMES = Object.freeze({
  english: 'english-only',
  ephemeral: 'ephemeral',
  selfref: 'selfref-subject',
})

/** 兼容层：旧 qualityVerdict 契约（返回拒因字符串或 null，只反映 hard 档）。 */
export function qualityVerdict(row, cfg = GATE_CONFIG) {
  const v = gateVerdict(row, cfg)
  if (v.decision !== 'hard_quarantine') return null
  return LEGACY_REJECT_NAMES[v.class] ?? v.class
}


