// src/home.mjs — DSH home 解析的唯一入口。零运行时依赖（仅 node:os / node:path）。
//
// 背景（2026-09-15 修正）
// ----------------------
// 此前 ACP 多处写作 `process.env.DSH_HOME || ''`。DSH_HOME 未设时：
//
//     path.join('', 'acp')  ===  'acp'      // 相对路径！
//
// 于是账本被静默写到**进程 cwd** 下——产生「数据去哪了」类故障，且不报错。
//
// 当时的应对是在 profiles/web/cordis.patch.yml 里把 ledgerDir / rulesDir
// **写死绝对路径**（注释记作「DSH_HOME 环境变量不可靠」）。但绝对路径绑死机器
// （用户名、盘符），跨机完全不可移植，反而把问题放大。
//
// 根因不是环境变量，是这里的回落写错了。现统一回落链，配置侧即可删除覆盖。
//
// 回落顺序与 @deepseek-ai/dsh-home-paths 的 resolveDshHome 一致：
//     显式入参 > $DSH_HOME（非空白，strip 后）> ~/.dsh
// **绝不回落到 cwd。**

import { homedir } from 'node:os'
import path from 'node:path'

/**
 * 解析 DSH home 绝对路径。
 * @param {Record<string, string|undefined>} [env] - 环境对象；默认 process.env（便于测试注入）
 * @returns {string} 绝对路径，永不返回相对路径
 */
export function resolveDshHome(env = process.env) {
  const raw = env?.DSH_HOME
  return raw && raw.trim() ? path.resolve(raw.trim()) : path.join(homedir(), '.dsh')
}