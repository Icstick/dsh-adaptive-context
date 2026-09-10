// scripts/consolidate-backlog.mjs — 手动批量消化积压证据（consolidation 回放）。
//
// 背景：consolidation 后台每日上限 24 批 × 4 条/批，修复后 ~3100 条积压需 ~30 天；
// 本工具在独立进程内循环调用 ACP consolidator 的 runOnce()（同一业务路径：
// 水位/审计/失败留痕/样式候选全复用），直到积压消化完或达到上限。
//
// LLM 通道：不经 host 服务，按 llm-deepseek adapter 的 wire 形状直连
// OpenAI 兼容端点（thinking:{type:'disabled'} 关闭思考——防线自检：若响应出现
// reasoning_content 会在日志告警）。
//
// 凭据与端点信任边界（审计 H-4，2026-09-10）：
//   凭据默认**只**从环境变量读（--key 指定变量名，默认 DEEPSEEK_API_KEY）；
//   读 $DSH_HOME/.credentials.yaml 的 refs 段需要显式开关 --from-credentials，
//   且会打印"即将把 <KEY> 发往 <host>"。
//   端点 baseUrl 受 host allowlist 约束（默认仅 api.deepseek.com）；扩展需显式
//   指定 --allow-hosts <h1,h2> 或 ACP_CONSOLIDATE_ALLOW_HOSTS=h1,h2，非白名单直接退出。
//   ——原来 base-url 完全自由 + 凭据可读 + 无条件 Bearer 外发，等于任意 URL 拿全局凭据。
//
// 用法：
//   node scripts/consolidate-backlog.mjs [--dir <ledgerDir>] [--batch 8]
//     [--model deepseek-v4-flash] [--max-tokens 12288] [--timeout-ms 180000]
//     [--key DEEPSEEK_API_KEY] [--limit-batches 0] [--max-fail 3] [--sleep-ms 0]
//     [--base-url https://api.deepseek.com] [--allow-hosts h1,h2] [--from-credentials]
//   --dry-run：仅跑 1 批后退出（配合副本 ledger 验证通道）

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openEvidenceLedger } from '../src/store.mjs'
import { createConsolidator } from '../src/consolidate.mjs'
import { CONSOLIDATION_MAX_BATCH } from '../src/constants.mjs'

// ---------- 端点信任边界（审计 H-4）----------
/** 默认允许的端点 host（官方域名）；扩展必须显式 --allow-hosts / 环境变量 */
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(['api.deepseek.com'])

/**
 * 解析生效的 host allowlist（默认集 ∪ 显式扩展）。
 * @param {object} a - parseArgs 原始键值
 * @returns {Set<string>} 小写 hostname 集合
 */
export function resolveAllowedHosts(a = {}) {
  const raw = String(a['allow-hosts'] || process.env.ACP_CONSOLIDATE_ALLOW_HOSTS || '')
  const extra = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])
}

/**
 * 校验 baseUrl 落在 allowlist 内——把全局凭据发往任意 URL 是本次审计的 H-4。
 * hostname 比较前统一小写；协议只允许 http/https（凭据走 Authorization 头）。
 * @param {string} baseUrl
 * @param {Set<string>} allowedHosts
 * @returns {URL} 解析后的 URL
 * @throws {Error} URL 非法 / 协议不符 / host 不在白名单
 */
export function assertAllowedBaseUrl(baseUrl, allowedHosts) {
  let url
  try {
    url = new URL(String(baseUrl))
  } catch {
    throw new Error('base-url 不是合法 URL: ' + String(baseUrl))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('base-url 协议不允许（仅 http/https）: ' + url.protocol)
  }
  const host = url.hostname.toLowerCase()
  if (!allowedHosts.has(host)) {
    throw new Error(
      'base-url 主机不在 allowlist: ' + host
      + '｜允许: ' + [...allowedHosts].join(', ')
      + '｜确需使用请显式 --allow-hosts ' + host + '（或 ACP_CONSOLIDATE_ALLOW_HOSTS=' + host + '）',
    )
  }
  return url
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const key = k.replace(/^--/, '')
    const next = argv[i + 1]
    a[key] = next && !next.startsWith('--') ? next : '1'
  }
  return {
    dir: a.dir || path.join(process.env.DSH_HOME || '', 'acp'),
    batch: Number(a.batch || 0) || CONSOLIDATION_MAX_BATCH,
    model: a.model || 'deepseek-v4-flash',
    maxTokens: Number(a.maxTokens || 12288),
    timeoutMs: Number(a['timeout-ms'] || 180000),
    keyEnv: a.key || 'DEEPSEEK_API_KEY',
    limitBatches: Number(a['limit-batches'] || 0),
    maxFail: Number(a['max-fail'] || 3),
    sleepMs: Number(a['sleep-ms'] || 0),
    dryRun: a.dry === '1' || a['dry-run'] === '1' || a.dry === 'true',
    baseUrl: a['base-url'] || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    allowedHosts: resolveAllowedHosts(a),
    fromCredentials: a['from-credentials'] === '1' || a['from-credentials'] === 'true',
  }
}

// ---------- 凭据（不落日志）----------
/**
 * 取 API key。默认**只**读环境变量；从 $DSH_HOME/.credentials.yaml 读需要显式开关。
 * @param {string} envName - 环境变量/refs 键名
 * @param {object} [opts]
 * @param {boolean} [opts.fromCredentials] - 允许回落读 .credentials.yaml
 * @returns {{key: string, source: 'env'|'credentials'} | null}
 */
export function loadApiKey(envName, { fromCredentials = false } = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(envName)) throw new Error('env name 需为字母数字下划线: ' + envName)
  if (process.env[envName]) return { key: process.env[envName], source: 'env' }
  if (!fromCredentials) return null
  const cred = path.join(process.env.DSH_HOME || '', '.credentials.yaml')
  if (!existsSync(cred)) return null
  const text = readFileSync(cred, 'utf8')
  // 迷你 YAML：refs 段下的 KEY: value 行（容忍引号）
  const re = new RegExp('^\\s*' + envName + '\\s*:\\s*[\'"\\n]?([^\'"\\n]+)', 'm')
  const m = text.match(re)
  return m ? { key: m[1].trim(), source: 'credentials' } : null
}

// ---------- OpenAI 兼容 SSE 单次生成 ----------
async function chatCompletion({ baseUrl, model, system, userText, maxTokens, timeoutMs, apiKey, logger }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reasoningChars = 0
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: true,
        thinking: { type: 'disabled' }, // P3 防线：wire 层关思考（serialize.js 同形状）
      }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      const detail = res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200)
      throw new Error('http ' + detail)
    }
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buf = ''
    let text = ''
    let finishReason = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop()
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let j
          try { j = JSON.parse(data) } catch { continue }
          const choice = j.choices && j.choices[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta || {}
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            reasoningChars += delta.reasoning_content.length
          }
          if (typeof delta.content === 'string') text += delta.content
        }
      }
    }
    if (reasoningChars > 0) {
      logger?.warn?.('[acp-backlog] 警告：响应含 reasoning_content ' + reasoningChars + ' 字符——thinking 未按预期关闭（wire 被忽略？）')
    }
    if (finishReason === 'length') throw new Error('acp consolidation llm finished with length (max-tokens)')
    if (finishReason && finishReason !== 'stop') throw new Error('acp consolidation llm finished with ' + finishReason)
    text = text.trim()
    if (!text) throw new Error('acp consolidation llm produced no text')
    return text
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 主流程（仅直接执行时运行；供 test 导入上面的纯函数）----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) await main()

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  // 端点信任边界：凭据只发往 allowlist 内的 host（审计 H-4）
  try {
    assertAllowedBaseUrl(opts.baseUrl, opts.allowedHosts)
  } catch (err) {
    console.error('[acp-backlog] ' + String((err && err.message) || err))
    process.exit(3)
  }

  const keyInfo = loadApiKey(opts.keyEnv, { fromCredentials: opts.fromCredentials })
  if (!keyInfo) {
    console.error('[acp-backlog] 未找到 API key。默认只读环境变量 ' + opts.keyEnv
      + '；如需读 $DSH_HOME/.credentials.yaml 的 refs 段，请显式加 --from-credentials')
    process.exit(2)
  }
  const apiKey = keyInfo.key
  console.log('[acp-backlog] 即将把 ' + opts.keyEnv + '（来源: ' + (keyInfo.source === 'env' ? '环境变量' : '.credentials.yaml')
    + '）发往 ' + new URL(opts.baseUrl).hostname)

  const ledger = openEvidenceLedger({ dir: opts.dir })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const llmCall = (userText, system) => chatCompletion({
    baseUrl: opts.baseUrl, model: opts.model, system, userText,
    maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, apiKey,
    logger: console,
  })
  const cons = createConsolidator({
    ledger,
    scopeId: 'user-global',
    llmCall,
    maxBatch: opts.batch,
    maxRunsPerDay: 1e9, // 手动回放不受日频限制
    minEvidence: 1,
    minTurns: 1e9, // 仅 runOnce 显式驱动，不经 enqueue 节流
    logger: console,
  })

  let batches = 0
  let digested = 0
  let observations = 0
  let failStreak = 0
  const t0 = Date.now()
  for (;;) {
    if (opts.limitBatches > 0 && batches >= opts.limitBatches) break
    if (cons.undigestedEvidence().length === 0) break
    const r = await cons.runOnce()
    batches += 1
    digested += r.digested || 0
    observations += r.observations || 0
    const after = cons.undigestedEvidence().length
    if (r.reason === 'llm_failed') {
      failStreak += 1
      console.log('[acp-backlog] 批 #' + batches + ' LLM 失败（连续 ' + failStreak + '），剩余 ' + after)
      if (failStreak >= opts.maxFail) {
        console.error('[acp-backlog] 连续失败 ' + opts.maxFail + ' 次，中止（水位未推进，可重跑）')
        break
      }
    } else {
      failStreak = 0
      console.log('[acp-backlog] 批 #' + batches + ' 消化 ' + (r.digested ?? 0) + ' 产出 ' + (r.observations ?? 0)
        + '（剩余 ' + after + '，' + Math.round((Date.now() - t0) / 1000) + 's）')
    }
    if (r.ran === false && r.digested === 0) break
    if (opts.dryRun) break
    if (opts.sleepMs > 0) await sleep(opts.sleepMs)
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log('[acp-backlog] 完成：批 ' + batches + ' / 消化 ' + digested + ' / 产出 observation ' + observations
    + ' / 剩余未消化 ' + cons.undigestedEvidence().length + ' / 用时 ' + secs + 's')
  try { ledger.close() } catch { /* noop */ }
  process.exit(0)
}
