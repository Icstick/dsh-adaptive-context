// src/chapter.mjs —— 「关于你的那一章」的两件纯函数（2026-09-29）
// ---------------------------------------------------------------------------
// 来源：Herta 的两条机制（reference/external-refs-20260927/herta-ai.md §5-§6）：
//   ① **遗忘前先沉淀**：入梦/归档发生时，先把「它知道的关于用户的事」写进自传的续页
//      （`### 记录：关于开拓者.txt`），条目可以冷存，知识不能跟着消失。
//   ② **user-line-gate**：用户台词必须是**真实消息的连续引用**，不许模型转述成一句「用户希望…」。
//
// 落到本仓：人读画像（scripts/ledger-profile-doc.mjs 的 USER.md）就是我们的「续页」。
// 但它现在有两个缺口，正是这两条要补的：
//   · 条目一旦被 dream 冷存，就从画像里**消失**——没有任何地方先接住它（缺 ①）；
//   · 画像的每行都是**转述**，看不出哪句是她真说过、哪句是蒸出来的（缺 ②）。
//
// 本模块**只读、只判定**：不改账本、不改 observation 状态、不写任何文件。
// 写文档的是 scripts/ledger-profile-doc.mjs，它调用这里的纯函数。

/** 引号族：中文直角/书名/弯引号 + 半角双引号。只收**成对**出现的切片。 */
const QUOTE_RE = /[「『“"]([^「」『』“”"]{2,160})[」』”"]/g

/** 归一化：抹平空白、统一引号与全角标点，便于「逐字」比较。 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[「」『』“”"]/g, '"')
    .replace(/[，。、；：！？（）]/g, (m) => ({ '，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '！': '!', '？': '?', '（': '(', '）': ')' })[m] ?? m)
}

/**
 * 抽出文本里**被引号包起来的**原话候选。
 * @param {string} text
 * @returns {string[]} 去重后的原文切片（保持出现顺序）
 */
export function extractQuotedSpans(text) {
  const out = []
  const seen = new Set()
  const src = String(text ?? '')
  QUOTE_RE.lastIndex = 0
  let m
  while ((m = QUOTE_RE.exec(src)) !== null) {
    const q = m[1].trim()
    if (q === '' || seen.has(q)) continue
    seen.add(q)
    out.push(q)
  }
  return out
}

/**
 * 这段引文能不能在证据里**逐字**找到（归一化后子串匹配）。
 * 找不到 ≠ 伪造：证据可能没跨机带过来（外机导入按设计清空 evidenceIds）。
 * 所以判据只回答「本机能核到什么程度」，由调用方决定怎么标注。
 * @param {string} quote
 * @param {string[]} evidenceTexts
 * @returns {{supported: boolean, index: number}}
 */
export function quoteSupport(quote, evidenceTexts = []) {
  const raw = normalizeForMatch(quote)
  if (raw === '') return { supported: false, index: -1 }
  // 句末标点不参与「逐字」判定：蒸出来的引文常自带句号，而原话常常没有。
  const trimmed = raw.replace(/[.,;!?]+$/, '')
  const forms = trimmed !== '' && trimmed !== raw ? [raw, trimmed] : [raw]
  for (let i = 0; i < evidenceTexts.length; i += 1) {
    const hay = normalizeForMatch(evidenceTexts[i])
    for (const q of forms) { if (hay.includes(q)) return { supported: true, index: i } }
  }
  return { supported: false, index: -1 }
}

/**
 * 给一组 observation 附上「它引用到的原话 + 本机能否核到」。
 * 没有引文的行照样返回（quotes 为空数组）——转述不是错，只是要标出来。
 * @param {Array<{id:string,text:string,evidenceIds?:string[]}>} observations
 * @param {Map<string,{content:string}>|Record<string,string>} evidenceById
 * @returns {Array<{id:string,quotes:Array<{text:string,supported:boolean,inEvidenceIndex:number}>,transposed:boolean}>}
 */
export function attachQuotes(observations = [], evidenceById = new Map()) {
  const get = (id) => {
    if (evidenceById instanceof Map) return evidenceById.get(id)
    return evidenceById?.[id]
  }
  return observations.map((o) => {
    const texts = (o.evidenceIds ?? []).map((id) => { const e = get(id); return typeof e === 'string' ? e : (e?.content ?? '') }).filter((t) => t !== '')
    const quotes = extractQuotedSpans(o.text).map((q) => {
      const r = quoteSupport(q, texts)
      return { text: q, supported: r.supported, inEvidenceIndex: r.index }
    })
    // evidenceCount 让调用方区分两类「核不到」：外机导入（按设计无回链）vs 有回链却对不上（真异常）。
    return { id: o.id, quotes, transposed: quotes.length === 0, evidenceCount: (o.evidenceIds ?? []).length }
  })
}

/**
 * 遗忘前沉淀检查：哪些**即将冷存**的用户域结论，画像里还没有接住。
 * 只报缺口，不做任何状态改动（dream 的既有约定：遗忘只产出计划）。
 * @param {object} input
 * @param {Array<{id:string,text:string,claimDomain?:string,subject?:string}>} input.observations
 * @param {string[]} input.archivalIds - 即将冷存的 observation id
 * @param {string[]} input.representedTexts - 画像正文里已经出现过的文本
 * @param {string[]} [input.profileDomains] - 参与画像的域
 * @returns {{checked:number, missing:Array<{id:string,text:string,claimDomain:string}>}}
 */
export function planSedimentation({ observations = [], archivalIds = [], representedTexts = [], profileDomains = ['user_fact', 'user_preference'] } = {}) {
  const arch = new Set(archivalIds)
  const rep = new Set(representedTexts.map(normalizeForMatch).filter((s) => s !== ''))
  const missing = []
  for (const o of observations) {
    if (!arch.has(o.id)) continue
    if (!profileDomains.includes(o.claimDomain)) continue
    const key = normalizeForMatch(o.text)
    if (key === '') continue
    // 逐字命中或包含关系都算「接住了」：画像常把长句压短，不能用等号判。
    let covered = false
    for (const r of rep) { if (r === key || r.includes(key) || key.includes(r)) { covered = true; break } }
    if (!covered) missing.push({ id: o.id, text: o.text, claimDomain: o.claimDomain })
  }
  return { checked: archivalIds.length, missing }
}