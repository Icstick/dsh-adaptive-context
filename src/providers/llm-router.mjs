// src/providers/llm-router.mjs — LLM 任务路由 + fallback 链（M3 A2）。
//
// tasks: { [task]: { provider, model, fallback?: [{provider, model}], timeoutMs, maxTokens } }
// callFor(task, userText, system)：主路由 → fallback 链依次尝试 → 全失败抛错（调用方决定降级）。
//
// 沿用 M2 index.mjs callLlmText 范式：llm.stream + purpose:'compaction' +
// BlockAssembler 流式收集；失败（finish 非 stop / 无文本 / 抛错）计入一次尝试。
//
// 纪律：
//   - 本模块零业务依赖，只做路由 + 一次纯文本生成；llm 服务经 resolveLlm() 惰性获取
//     （withService 模式：每次 callFor 重新解析，重挂载即生效）
//   - task 无路由 / llm 服务缺失 → 抛错（调用方 buildLlmCall 返回 null 走规则兜底）

import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'

export const DEFAULT_MAX_TOKENS = 1024
export const DEFAULT_TIMEOUT_MS = 30000

/**
 * 用 DSH llm 服务做一次纯文本生成（consolidation 专用）。
 * 参考 @deepseek-ai/dsh-session-title-llm 的 BlockAssembler 流式收集范式。
 * 失败（finish 非 stop / 无文本 / stream 抛错）向上抛——由 router 走 fallback，
 * 最终由 consolidate.mjs 的 deriveViaLlm 重试/丢弃。
 * @param {object} llm - DSH llm 服务（{ stream(options) }）
 * @param {object} route - { provider, model, maxTokens?, timeoutMs? }
 * @param {string} userText
 * @param {string} [system]
 * @returns {Promise<string>}
 */
export async function callLlmText(llm, route, userText, system) {
  const provider = route?.provider
  const model = route?.model
  const maxTokens = route?.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = route?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const messages = [createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: 'dsh-adaptive-context', form: 'consolidation' },
  })]
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider,
      model,
      messages,
      system,
      maxTokens,
      temperature: 0,
      signal: controller.signal,
      purpose: 'compaction', // GenerateOptions 联合类型只有 compaction|session-title
    })) {
      assembler.push(chunk)
    }
    const finish = assembler.finish
    if (finish && finish.kind && finish.kind !== 'stop') {
      throw new Error('acp consolidation llm finished with ' + finish.kind)
    }
    const text = assembler.blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) throw new Error('acp consolidation llm produced no text')
    return text
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 创建 LLM 任务路由。
 * @param {object} [opts]
 * @param {object} [opts.tasks] - { [task]: {provider, model, fallback?, timeoutMs?, maxTokens?} }
 * @param {() => object|undefined} [opts.resolveLlm] - 惰性获取 llm 服务（每次 callFor 重新解析）
 * @returns {{
 *   callFor: (task, userText, system) => Promise<string>,
 *   getRoute: (task) => object|null,
 *   chainFor: (task) => object[],
 * }}
 */
export function createLlmRouter({ tasks = {}, resolveLlm = () => undefined } = {}) {
  /** 路由解析：task → 主路由（未配置 → null） */
  function getRoute(task) {
    const route = tasks[task]
    return route && typeof route === 'object' ? route : null
  }

  /** 完整尝试链：主路由 + fallback 链 */
  function chainFor(task) {
    const route = getRoute(task)
    if (!route) throw new Error('acp llm task \'' + task + '\' has no route')
    return [route, ...(Array.isArray(route.fallback) ? route.fallback : [])]
  }

  /**
   * 按任务调用 LLM：主路由 → fallback 链依次尝试 → 全失败抛错。
   * @param {string} task - 任务名（如 'consolidation'）
   * @param {string} userText
   * @param {string} [system]
   * @returns {Promise<string>} 纯文本结果
   */
  async function callFor(task, userText, system) {
    const chain = chainFor(task)
    const llm = resolveLlm()
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('acp llm service unavailable (task ' + task + ')')
    }
    let lastError = null
    for (const entry of chain) {
      if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
        lastError = new Error('acp llm route entry invalid (task ' + task + ')')
        continue
      }
      try {
        return await callLlmText(llm, entry, userText, system)
      } catch (err) {
        lastError = err
      }
    }
    const reason = lastError ? ' (' + lastError.message + ')' : ''
    throw new Error('acp llm task ' + task + ': all routes failed' + reason)
  }

  return { callFor, getRoute, chainFor }
}
