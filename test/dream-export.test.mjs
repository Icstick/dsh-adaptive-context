import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { looksEphemeral, toWeaverRecord } from '../scripts/dream-export.mjs'

// ACP-B19（2026-09-25）：判据强化 + 「两处必须同步」的守护。
// 判据有意复刻在两处：本仓 dream-export.mjs（降权不挡下）与 .tooling/scripts/wv-staging-promote.mjs（挡下）。
// 云端只有后者，不能靠 import 共享，只能靠一条测试盯着两边别分叉。

test('looksEphemeral：进度快照形态被识别', () => {
  assert.equal(looksEphemeral('当前在 dsh-desktop-shell 的某分支上先做提交'), true)
  assert.equal(looksEphemeral('正在复现 RPC 缺陷'), true)
  assert.equal(looksEphemeral('已读完三份报告'), true)
  assert.equal(looksEphemeral('我正在复现 dsh-browser 的 RPC 缺陷'), true)
  assert.equal(looksEphemeral('我们正在核对三仓漂移'), true)
  assert.equal(looksEphemeral('进展：已完成三仓对齐'), true)
  assert.equal(looksEphemeral('状态：等 A/B 上线'), true)
})

test('looksEphemeral：认知动词与建议句是真知识，不误杀', () => {
  assert.equal(looksEphemeral('已确认 Node 的 zstdDecompressSync 只解第一帧'), false)
  assert.equal(looksEphemeral('已验证 junction 在 Session 0 读不了'), false)
  assert.equal(looksEphemeral('已定位到 rpc-host.ts:86 的 owner 取值错误'), false)
  assert.equal(looksEphemeral('接下来应该先跑全量测试再提交'), false)
  assert.equal(looksEphemeral(''), false)
  assert.equal(looksEphemeral(null), false)
})

test('toWeaverRecord：进度快照降权 + 打 ephemeral 标签（不挡下）', () => {
  const base = { id: 'c1', claimDomain: 'work', occurrences: 5, evidenceIds: [], sessions: [], days: 1 }
  const eph = toWeaverRecord({ ...base, text: '当前在改设置页' })
  assert.equal(eph.tags.includes('ephemeral'), true)
  assert.equal(eph.confidence, 0.7)
  const plain = toWeaverRecord({ ...base, id: 'c2', text: 'junction 在 Session 0 读不了' })
  assert.equal(plain.tags.includes('ephemeral'), false)
  assert.equal(plain.confidence, 0.9)
})

test('两处判据保持同步（本仓 dream-export.mjs ↔ .tooling/wv-staging-promote.mjs）', () => {
  const peer = 'D:/DSH_workspace/.tooling/scripts/wv-staging-promote.mjs'
  if (!existsSync(peer)) return
  const grab = (src) => {
    const m = src.match(/EPHEMERAL_PATTERNS\s*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\n\]/)
    return m ? m[1].replace(/\s+/g, ' ').trim() : '(not found)'
  }
  const here = fileURLToPath(new URL('../scripts/dream-export.mjs', import.meta.url))
  const mine = grab(readFileSync(here, 'utf8'))
  const theirs = grab(readFileSync(peer, 'utf8'))
  assert.notEqual(mine, '(not found)')
  assert.equal(mine, theirs, '两处 ephemeral 判据已分叉——B19 要求同步改')
})