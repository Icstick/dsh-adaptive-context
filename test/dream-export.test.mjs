import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { looksEphemeral, toWeaverRecord, toStagingRecord } from '../scripts/dream-export.mjs'
import * as ex from '../scripts/dream-export.mjs'
// 判据 A/B（2026-09-25）新增导出：supportDomains / looksCrossDomain / buildStagingExport。
// 用 ex.* 访问而不是命名导入——这样「还没实现」表现为**断言失败**（红得可读），不是模块加载错误。
const { supportDomains, looksCrossDomain, buildStagingExport, enrichCandidate } = ex

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

test('toStagingRecord：必须带 occurrences —— promote 的判据 B 读的就是它', () => {
  // 2026-09-25 实测：此前没输出 occurrences → staging 记录无该键 → occ 恒 0 → 判据 B 永不成立。
  const rec = toStagingRecord(
    { id: 'c1', subject: '用户', claimDomain: 'work', occurrences: 7, sessions: ['s1', 's2', 's3'], days: 3 },
    { title: 'T', summary: 'S', body: 'B', source: 'acp-dreaming:c1', tags: ['t'], confidence: 0.9 },
  )
  assert.equal(rec.occurrences, 7)
  assert.equal(rec.sessions, 3)
  assert.equal(rec.days, 3)
  assert.equal(Object.hasOwn(rec, 'occurrences'), true)
  // 缺字段时也要给出 0，而不是 undefined（promote 端 Number(undefined ?? 0) 才稳）
  const bare = toStagingRecord({ id: 'c2' }, { title: 'T2', summary: 'S2' })
  assert.equal(bare.occurrences, 0)
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

// ═══════════════════════════════════════════════════════════════════════════════
// 判据 A：跨域配对（2026-09-25）
// 依据：Discovery by Dreaming（arXiv:2607.16256）——「跨域巩固有价值，域内复述没有价值」。
// 落地：候选的**支撑域集合** >= 2 才允许进 staging。支撑域 = 候选自身 claimDomain ∪
//       全部支撑证据的 claimDomain（证据域是更松的一侧，取并集不会把真跨域判掉）。
// ═══════════════════════════════════════════════════════════════════════════════

test('supportDomains：证据域 + 各自域取并集（去重、排序、忽略空值）', () => {
  assert.deepEqual(supportDomains('work', ['user_fact', 'user_fact']), ['user_fact', 'work'])
  assert.deepEqual(supportDomains('work', []), ['work'])
  assert.deepEqual(supportDomains(null, ['external_fact']), ['external_fact'])
  assert.deepEqual(supportDomains(null, []), [])
})

test('looksCrossDomain：>= 2 个不同域才算跨域；单域复述不算', () => {
  assert.equal(looksCrossDomain(['user_fact', 'work']), true)
  assert.equal(looksCrossDomain(['work']), false)
  assert.equal(looksCrossDomain(['external_fact', 'external_fact']), false, '同域重复不是跨域')
  assert.equal(looksCrossDomain([]), false)
  assert.equal(looksCrossDomain(undefined), false)
})

test('判据 A：单域支撑（域内复述）不进 staging，理由可读', () => {
  const { records, blocked } = buildStagingExport([
    // 域内复述 = 结论域与它的证据域**完全同一个域**（work 结论，支撑也全是 work 证据）
    { id: 'c1', text: 'wv 的 inbound 文件是首行 manifest 加 N 行 entry', claimDomain: 'work', occurrences: 3, evidenceIds: ['e1', 'e2'],
      evidenceDomains: ['work'], evidenceAuthorities: ['user_explicit'],
      conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
  ])
  assert.equal(records.length, 0, '单域不该产生 staging 记录')
  assert.equal(blocked.length, 1)
  assert.match(blocked[0].reason, /跨域/)
})

test('判据 A：跨域支撑（work 结论 + user_preference 证据）允许进 staging', () => {
  const { records, blocked } = buildStagingExport([
    { id: 'c9', text: 'linter 仅关注 adaptstar', claimDomain: 'work', occurrences: 3, evidenceIds: ['e1', 'e2'],
      evidenceDomains: ['user_fact', 'user_preference'], evidenceAuthorities: ['user_explicit'],
      conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
  ])
  assert.equal(blocked.length, 0)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].evidenceDomains, ['user_fact', 'user_preference'])
  assert.equal(records[0].crossDomain, true)
})

test('判据 A 之上的白名单仍然生效：画像域不得随 staging 出 ACP（§10.2 隐私边界）', () => {
  // 2026-09-25 实测发现的真泄漏：staging 通道最初只过「判据 A/B」，会把 user_preference 也写进去。
  // DREAMING §11.4 的前提是「白名单已挡画像三域」——所以 staging 必须先过同一道白名单。
  const { records, blocked } = buildStagingExport([
    { id: 'p1', text: '偏好简单直观的展示', claimDomain: 'user_preference', occurrences: 5, evidenceIds: ['e1'],
      evidenceDomains: ['user_fact'], evidenceAuthorities: ['user_explicit'],
      conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
    { id: 'p2', text: '本机为 Windows，账户 zoot', claimDomain: 'user_fact', occurrences: 5, evidenceIds: ['e1'],
      evidenceDomains: ['user_fact'], evidenceAuthorities: ['user_explicit'],
      conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
  ])
  assert.equal(records.length, 0, '画像域一条都不许进 staging')
  assert.equal(blocked.length, 2)
  for (const b of blocked) assert.match(b.reason, /画像域|白名单/)
})

test('enrichCandidate：从证据行算支撑域与两侧 authority（非放大：取最弱）', () => {
  const c = enrichCandidate(
    { id: 'c7', text: '某条结论', claimDomain: 'work', evidenceIds: ['e1', 'e2'], observationAuthorities: ['user_explicit'] },
    [{ claimDomain: 'user_fact', authority: 'user_explicit' }, { claimDomain: 'external_fact', authority: 'agent_inference' }],
  )
  assert.deepEqual(c.evidenceDomains.slice().sort(), ['external_fact', 'user_fact'])
  assert.equal(c.evidenceAuthority, 'agent_inference', '取最弱的那条')
  assert.equal(c.conclusionAuthority, 'user_explicit')
  // 结论 user_explicit(5) > 证据最低 agent_inference(1) → 判据 B 必须挡下
  const { blocked } = buildStagingExport([c])
  assert.match(blocked[0].reason, /authority/)
})

test('判据 A 预期副作用：进度快照（高频复现但单域）自然掉出候选池', () => {
  // 「当前在做 X」天然反复出现 → occurrences 很高；但它的支撑证据始终落在同一个域。
  // 这条与 B19 的 ephemeral **互补**：B19 抓的是词面形态，A 抓的是支撑结构——
  // 词面认不出的那种（「在 dsh-desktop-shell 上先做提交」）A 也能挡。
  const { records, blocked } = buildStagingExport([
    { id: 'c3', text: '在 dsh-desktop-shell 上先做提交', claimDomain: 'work', occurrences: 19, evidenceIds: ['e1', 'e2'],
      evidenceDomains: ['work'], evidenceAuthorities: ['user_explicit'],
      conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
  ])
  assert.equal(records.length, 0, '高复现不等于有价值——跨域判据让它掉出去')
  assert.equal(blocked.length, 1)
  assert.match(blocked[0].reason, /跨域/)
  // 词面形态那条仍按原判据挡（ephemeral 先于跨域判定）
  const ephem = buildStagingExport([
    { id: 'c4', text: '状态：正在跑全量测试', claimDomain: 'work', occurrences: 19, evidenceIds: ['e1'],
      evidenceDomains: ['work'], evidenceAuthorities: ['user_explicit'],
      conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
  ])
  assert.match(ephem.blocked[0].reason, /ephemeral/)
})

// ═══════════════════════════════════════════════════════════════════════════════
// 判据 B：权威不放大（2026-09-25）
// 依据：AuthMem-Bench（arXiv:2608.01679）——49 组配置里 48 组出现 authority collapse，
//       失败点在**巩固那一步**。所以巩固产物不得比它支撑证据里最弱的一条更有权威。
// 序取 src/store.mjs deriveObservationAuthority（代码里的实际序）与 src/policy.mjs 的 STRENGTH_MAP。
// ═══════════════════════════════════════════════════════════════════════════════

test('toStagingRecord：必须带 supportDomains / conclusionAuthority / evidenceAuthority', () => {
  const rec = toStagingRecord(
    { id: 'c1', subject: '用户', claimDomain: 'work', occurrences: 7, sessions: ['s1'], days: 3,
      evidenceDomains: ['user_fact', 'work'], conclusionAuthority: 'user_explicit', evidenceAuthority: 'user_explicit' },
    { title: 'T', summary: 'S', body: 'B', source: 'acp-dreaming:c1', tags: [], confidence: 0.9 },
  )
  assert.deepEqual(rec.supportDomains, ['user_fact', 'work'])
  assert.equal(rec.evidenceDomains.join(','), 'user_fact,work')
  assert.equal(rec.conclusionAuthority, 'user_explicit')
  assert.equal(rec.evidenceAuthority, 'user_explicit')
  assert.equal(rec.crossDomain, true)
  // 缺字段时给 null，不编造值（promote 端据此判「不可核验」而不是静默放行）
  const bare = toStagingRecord({ id: 'c2', claimDomain: 'work' }, { title: 'T2', summary: 'S2' })
  assert.equal(bare.conclusionAuthority, null)
  assert.equal(bare.evidenceAuthority, null)
  assert.equal(bare.crossDomain, false)
})

test('两处判据保持同步：CROSS_DOMAIN_MIN / AUTHORITY_RANK 不得分叉', () => {
  const peer = 'D:/DSH_workspace/.tooling/scripts/wv-staging-promote.mjs'
  if (!existsSync(peer)) return
  const theirs = readFileSync(peer, 'utf8')
  assert.match(theirs, /CROSS_DOMAIN_MIN\s*=\s*2/, '对端缺 CROSS_DOMAIN_MIN')
  // 秩表：本仓 src/policy.mjs 是权威定义，对端必须复刻同一组值
  const here = readFileSync(fileURLToPath(new URL('../src/policy.mjs', import.meta.url)), 'utf8')
  const grabRank = (src) => {
    const m = src.match(/AUTHORITY_RANK\s*=\s*(?:Object\.freeze\()?\{([\s\S]*?)\n\}/)
    if (!m) return '(not found)'
    return m[1].split(',').map((s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '')).filter(Boolean).sort().join(',')
  }
  const mine = grabRank(here)
  const peerRank = grabRank(theirs)
  assert.notEqual(mine, '(not found)', 'policy.mjs 里没有 AUTHORITY_RANK')
  assert.notEqual(peerRank, '(not found)', 'wv-staging-promote.mjs 里没有 AUTHORITY_RANK')
  assert.equal(peerRank, mine, 'authority 秩表已分叉——判据 B 要求两处同序')
})