// src/providers/registry.mjs — Recall Provider 注册表（M3 A1）。
//
// 多记忆源召回：注册表持有 N 个 recall provider 描述符，recallAll 并行召回，
// 各自超时 + fail-open（单 provider 故障不阻断，返回其余结果）。
//
// 兼容旧配置（M2 行为不变）：未提供 recallProviders 时，自动用
// defaults.memosBaseUrl / defaults.memosEnabled 构造默认 memos 项。
//
// 描述符形状（kind 固定 'recall'）：
//   { id, enabled, timeoutMs, weight, baseUrl? }
//   可选 create() 工厂（自定义 provider 实例）；未知 id 且无工厂 → 视为不可用（fail-open）。
//
// 纪律：
//   - 只做召回编排，不做评分/排序（融合归 composer，M3 A3）
//   - 候选统一打 sourceProvider = 描述符 id（多源归一）
//   - 候选通过 recall-contract 校验（id/content/score/sourceProvider 齐全）
//   - 全部 provider 禁用 → recallAll 返回 []（hasProvider=false 由调用方从
//     listRecallProviders() 判定，走 M2 无 provider 行为）

import { createMemosProvider, MEMOS_DEFAULT_BASE_URL, MEMOS_DEFAULT_TIMEOUT_MS } from './memos.mjs'
import { isValidRecallCandidate } from './recall-contract.mjs'

/** 内置 provider 工厂（id → factory）。M3 MVP 只有 memos；v0.2 扩展 Reflect/Profile 等。 */
const DEFAULT_FACTORIES = Object.freeze({
  memos: (desc) => createMemosProvider({
    baseUrl: desc.baseUrl,
    timeoutMs: desc.timeoutMs,
  }),
})

/**
 * 创建 Recall Provider 注册表。
 * @param {object} [opts]
 * @param {object[]} [opts.recallProviders] - 描述符数组（缺省/undefined → 用 defaults 构造默认 memos 项；
 *   显式 [] → 无 provider）
 * @param {object} [opts.defaults] - 旧配置兼容 { memosBaseUrl, memosEnabled, timeoutMs }
 * @param {object} [opts.factories] - 额外 provider 工厂 { id: (desc) => provider }（测试注入用）
 * @returns {{
 *   listRecallProviders: () => object[],
 *   recallAll: ({text, limit}) => Promise<object[]>,
 * }}
 */
export function createProviderRegistry({ recallProviders, defaults = {}, factories = {} } = {}) {
  const allFactories = { ...DEFAULT_FACTORIES, ...factories }
  const instances = new Map()

  /** 描述符 → 规范化副本（缺省字段补齐） */
  function normalizeDescriptor(desc) {
    if (!desc || typeof desc !== 'object') return null
    if (typeof desc.id !== 'string' || desc.id.length === 0) return null
    return {
      id: desc.id,
      kind: 'recall',
      enabled: desc.enabled !== false,
      timeoutMs: desc.timeoutMs ?? defaults.timeoutMs ?? MEMOS_DEFAULT_TIMEOUT_MS,
      weight: typeof desc.weight === 'number' && desc.weight >= 0 ? desc.weight : 1,
      baseUrl: desc.baseUrl,
      create: desc.create, // 自定义工厂透传（canBuild/getProvider 用）
    }
  }

  /** 旧配置兼容：memosBaseUrl/memosEnabled 缺失时自动构造默认 memos 项（M2 行为不变） */
  function defaultMemosDescriptor() {
    return normalizeDescriptor({
      id: 'memos',
      enabled: defaults.memosEnabled ?? true,
      timeoutMs: defaults.memosTimeoutMs ?? MEMOS_DEFAULT_TIMEOUT_MS,
      weight: 1,
      baseUrl: defaults.memosBaseUrl ?? MEMOS_DEFAULT_BASE_URL,
    })
  }

  /** 最终描述符列表：recallProviders 缺省 → 默认 memos 项；显式数组 → 原样（空数组 = 无 provider） */
  function resolveDescriptors() {
    const list = Array.isArray(recallProviders) && recallProviders !== undefined
      ? recallProviders
      : [defaultMemosDescriptor()]
    return list
      .map(normalizeDescriptor)
      .filter((d) => d !== null)
  }

  /** 描述符能否实例化（内置工厂或自定义 create） */
  function canBuild(desc) {
    return typeof desc.create === 'function' || typeof allFactories[desc.id] === 'function'
  }

  /** 惰性实例化并缓存 provider */
  function getProvider(desc) {
    if (!instances.has(desc.id)) {
      const factory = typeof desc.create === 'function' ? desc.create : allFactories[desc.id]
      if (typeof factory !== 'function') return null
      instances.set(desc.id, factory(desc))
    }
    return instances.get(desc.id)
  }

  /** 单 provider 召回：超时 + fail-open */
  async function recallOne(desc, { text, limit }) {
    const provider = getProvider(desc)
    if (!provider || typeof provider.recall !== 'function') return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), desc.timeoutMs)
    const recallPromise = Promise.resolve().then(() => provider.recall({ text, limit }, controller.signal))
    try {
      const hits = await Promise.race([
        recallPromise,
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('acp recall timed out: ' + desc.id)), { once: true })
        }),
      ])
      if (!Array.isArray(hits)) return []
      return hits
        .map((h) => (h !== null && typeof h === 'object' ? { ...h, sourceProvider: desc.id } : h))
        .filter(isValidRecallCandidate)
    } catch {
      return [] // fail-open：单 provider 故障/超时不阻断其余
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 已启用的 recall provider 描述符列表（含 weight，供 composer providerWeights 装配）。
   * @returns {object[]} 规范化描述符副本
   */
  function listRecallProviders() {
    return resolveDescriptors()
      .filter((d) => d.enabled && canBuild(d))
      .map((d) => ({ ...d }))
  }

  /**
   * 并行召回全部启用 provider，合并候选（fail-open：单 provider 故障不阻断）。
   * @param {object} [query]
   * @param {string} [query.text] - 召回查询文本
   * @param {number} [query.limit] - 每 provider 上限
   * @returns {Promise<object[]>} RecallCandidate[]（sourceProvider 已按描述符 id 打标）
   */
  async function recallAll({ text, limit } = {}) {
    const providers = listRecallProviders()
    if (providers.length === 0) return []
    const results = await Promise.all(providers.map((desc) => recallOne(desc, { text, limit })))
    return results.flat()
  }

  return { listRecallProviders, recallAll }
}
