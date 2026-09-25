// test/dream-review-export.test.mjs — 候选池人工审 + weaver 导出（2026-09-22）
// 验收目标：状态迁移可审计、画像域**永不**导出、title 是截取不是生成、body 带溯源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { parseArgs as parseReview, reviewCandidates, renderList } from '../scripts/dream-review.mjs'
import {
  parseArgs as parseExport, deriveTitle, provenanceFooter, toWeaverRecord, buildExport, looksEphemeral,
  EXPORTABLE_DOMAINS, BLOCKED_DOMAINS, enrichCandidate, stagingBlockReason,
} from '../scripts/dream-export.mjs'

const CAND = (over = {}) => ({
  id: 'cm_a', scopeId: 'user-global', state: 'consensus', claimDomain: 'work', subject: 'linter 范围',
  text: 'linter 仅关注 adaptstar。', observationIds: ['o1'], evidenceIds: ['e1', 'e2'],
  sessions: ['s1', 's2'], days: 2, occurrences: 2, firstSeen: '2026-09-20', lastSeen: '2026-09-21',
  ...over,
})

test('review.parseArgs：--list 缺省 / --approve 的点名 id', () => {
  const a = parseReview(['--dir', 'X:/l', '--list'])
  assert.equal(a.list, true)
  assert.deepEqual(a.ids, [])
  const b = parseReview(['--approve', 'cm_1', 'cm_2'])
  assert.equal(b.approve, true)
  assert.deepEqual(b.ids, ['cm_1', 'cm_2'])
})

test('reviewCandidates：状态迁移 + 审计记 from→to；未知 id 逐条报错不中断', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-drev-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = openEvidenceLedger({ dir })
  ledger.upsertCandidateMemory(CAND({ id: 'cm_1', state: 'consensus' }))
  ledger.upsertCandidateMemory(CAND({ id: 'cm_2', state: 'candidate' }))

  const r = reviewCandidates(ledger, ['cm_1', 'cm_missing', 'cm_2'], 'approved', '人工确认')
  assert.equal(r.moved.length, 2)
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].id, 'cm_missing')
  assert.equal(ledger.getCandidateMemoryById('cm_1').state, 'approved')
  assert.equal(ledger.getCandidateMemoryById('cm_2').state, 'approved')

  const audits = ledger.auditStore.queryAudit({ op: 'dream_review' }).items
  assert.equal(audits.length, 2)
  assert.equal(audits[0].actor, 'user')
  assert.ok(String(audits[0].reason).includes('人工确认'))
  const a1 = audits.find((x) => x.targetId === 'cm_1')
  assert.ok(a1, 'cm_1 必须有审计')
  const pl = typeof a1.payload === 'string' ? JSON.parse(a1.payload) : a1.payload
  assert.equal(pl.to, 'approved')
  assert.equal(pl.from, 'consensus', 'cm_1 原本是 consensus')

  // 反向操作（人改主意）也允许，且同样留痕
  const back = reviewCandidates(ledger, ['cm_1'], 'rejected')
  assert.equal(back.moved[0].from, 'approved')
  assert.equal(ledger.auditStore.queryAudit({ op: 'dream_review' }).items.length, 3)
  ledger.close()
})

test('reviewCandidates：非法状态直接抛（不做静默兜底）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-drev2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = openEvidenceLedger({ dir })
  assert.throws(() => reviewCandidates(ledger, ['x'], 'whatever'), /must be one of/)
  ledger.close()
})

test('renderList：空集有明确文案（不返回空串）', () => {
  assert.equal(renderList([], 0), '（没有匹配的候选）')
  assert.ok(renderList([CAND()], 1).includes('cm_a'))
})

test('deriveTitle：是正文**截取**，标点收尾，不做摘要', () => {
  assert.equal(deriveTitle('linter 仅关注 adaptstar。后面还有很多字'.repeat(3), 'x'), 'linter 仅关注 adaptstar')
  assert.equal(deriveTitle('', '主体'), '主体')
  assert.equal(deriveTitle('   '), '(无正文)')
  const long = '一二三四五六七八九十'.repeat(10)
  assert.ok(deriveTitle(long).length <= 48)
})

test('buildExport：白名单只放 work/external_fact，画像域一律挡下', () => {
  const items = [
    CAND({ id: 'a', claimDomain: 'work' }),
    CAND({ id: 'b', claimDomain: 'external_fact' }),
    CAND({ id: 'c', claimDomain: 'user_preference' }),
    CAND({ id: 'd', claimDomain: 'user_fact' }),
    CAND({ id: 'e', claimDomain: 'style' }),
    CAND({ id: 'f', claimDomain: 'work', evidenceIds: [] }),   // 无回链也要挡
  ]
  const { records, blocked } = buildExport(items, { lib: 'work-skill' })
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((r) => r.library), ['work-skill', 'work-skill'])
  assert.equal(blocked.length, 4)
  assert.deepEqual([...EXPORTABLE_DOMAINS], ['work', 'external_fact'])
  assert.ok(BLOCKED_DOMAINS.includes('user_preference') && BLOCKED_DOMAINS.includes('style'))
})

test('toWeaverRecord：字段对齐 wv putOne 契约，body 带可回溯脚注', () => {
  const r = toWeaverRecord(CAND())
  assert.ok(r.title)
  assert.ok(r.summary.length <= 200)
  assert.equal(r.source, 'acp-dreaming:cm_a')
  assert.deepEqual(r.tags, ['acp-dreaming', 'work'])
  assert.equal(r.confidence, 0.8, 'occurrences=2 → 0.8')
  assert.ok(r.body.includes('linter 仅关注 adaptstar'))
  assert.ok(r.body.includes('证据回链'))
  assert.ok(r.body.includes('e1 e2'))
  assert.equal(r.library, undefined, '不给 --lib 就不带 library 字段')
  assert.equal(toWeaverRecord(CAND({ occurrences: 5 })).confidence, 0.9)
  assert.ok(provenanceFooter(CAND()).includes('2 个会话'))
})

test('export.parseArgs：默认 state=approved，不给 --out 就是预览', () => {
  const a = parseExport([])
  assert.equal(a.state, 'approved')
  assert.equal(a.out, '')
  assert.equal(parseExport(['--state', 'consensus', '--lib', 'project']).lib, 'project')
})

test('端到端：dreaming → 人工审 → 导出（weaver 侧零写入）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-drev3-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = openEvidenceLedger({ dir })
  ledger.upsertCandidateMemory(CAND({ id: 'cm_ok', state: 'consensus', claimDomain: 'work' }))
  ledger.upsertCandidateMemory(CAND({ id: 'cm_me', state: 'consensus', claimDomain: 'user_preference' }))

  // 未审 → 导不出任何东西
  assert.equal(buildExport(ledger.queryCandidateMemory({ state: 'approved' }).items).records.length, 0)

  reviewCandidates(ledger, ['cm_ok', 'cm_me'], 'approved')
  const approved = ledger.queryCandidateMemory({ state: 'approved' }).items
  const { records, blocked } = buildExport(approved, { lib: 'work-skill' })
  assert.equal(records.length, 1, '只有 work 域出得去')
  assert.equal(records[0].source, 'acp-dreaming:cm_ok')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].domain, 'user_preference')
  ledger.close()
})

test('buildExport：blocked 的 reason 区分「画像域」与「不在白名单」（2026-09-24）', () => {
  const mk = (domain, id) => CAND({ id, claimDomain: domain })
  const { records, blocked } = buildExport([
    mk('user_preference', 'cm_p'),
    mk('experience', 'cm_e'),
    mk('work', 'cm_w'),
  ])
  assert.equal(records.length, 1, '只有 work 域出得去')
  assert.equal(blocked.length, 2)
  const byId = Object.fromEntries(blocked.map((b) => [b.id, b.reason]))
  assert.match(byId.cm_p, /画像域/)
  assert.match(byId.cm_e, /白名单/, 'experience 只是不在白名单，不该被说成画像域')
  assert.ok(!/画像域/.test(String(byId.cm_e)))
})


test('looksEphemeral：只认「第一人称进行时」，不误杀以「已」开头的真知识（ACP-B19）', () => {
  // 该降权的：进度快照 / 状态通报（2026-09-24 实测样本）
  for (const s of [
    '当前在 dsh-desktop-shell 的某分支上先做提交；需排查右上角 unavailable',
    '已读完三份报告并认可质量，正复现 git-guardrails 串行描述 bug',
    '正在复现 git-guardrails 串行描述 bug',
  ]) assert.equal(looksEphemeral(s), true, '应降权: ' + s)
  // 不该碰的：真知识（尤其「已确认 X 是 Y」这种以「已」开头的结论）
  for (const s of [
    'Plugin bundle structure is package.json + cordis.patch.yml',
    '已确认 Node 的 zstdDecompressSync 只解第一帧',
    'Node 的 zstdDecompressSync 只解第一帧，必须用 CLI 流式解',
    '',
  ]) assert.equal(looksEphemeral(s), false, '不得降权: ' + s)
  assert.equal(looksEphemeral(null), false)
})

test('toWeaverRecord：进度快照降权 0.2 且带 ephemeral 标签，真知识不受影响', () => {
  const eph = toWeaverRecord(CAND({ text: '当前在 dsh-desktop-shell 的某分支上先做提交', occurrences: 5 }))
  assert.ok(eph.tags.includes('ephemeral'))
  assert.equal(eph.confidence, 0.7, '0.9 - 0.2')
  const real = toWeaverRecord(CAND({ text: 'Plugin bundle structure is package.json', occurrences: 5 }))
  assert.ok(!real.tags.includes('ephemeral'))
  assert.equal(real.confidence, 0.9)
})
// ===================== 回链档位：理由分开，判据不放松（2026-09-25，方案 3） =====================
// 此前一律写「无证据回链」——把「外机按设计清空」与「本机写入缺回链」压成同一句话，
// 读的人只能理解成「本机数据有缺陷」。判据**不变**（两类都挡下）：回链不可核验就仍然
// 进不了 staging —— 放行会让 572 个簇从「已知缺证据」变成「看起来有证据」（K 报告 §5.3 的陷阱）。

test('无证据回链：外机档与本机档都挡下，但理由必须分开', () => {
  const items = [
    CAND({ id: 'cm_foreign', claimDomain: 'work', evidenceIds: [], backlinkTier: 'unverifiable_foreign' }),
    CAND({ id: 'cm_local', claimDomain: 'work', evidenceIds: [], backlinkTier: 'missing_backlink' }),
    CAND({ id: 'cm_plain', claimDomain: 'work', evidenceIds: [] }),
  ]
  const { records, blocked } = buildExport(items)
  assert.equal(records.length, 0, '仍然全部挡下 —— 这一档只改「怎么说」，不改「放不放」')
  const byId = Object.fromEntries(blocked.map((b) => [b.id, b.reason]))
  assert.equal(blocked.length, 3)
  assert.ok(/不可核验/.test(byId.cm_foreign), '外机档要说「不可核验（外机）」，不能说成本机缺数据：' + byId.cm_foreign)
  assert.ok(/外机/.test(byId.cm_foreign))
  assert.ok(/本机/.test(byId.cm_local), '本机档要说清是本机产出缺回链（真异常）：' + byId.cm_local)
  assert.ok(!/不可核验/.test(byId.cm_local))
  assert.equal(byId.cm_plain, '无证据回链', '不带档位信息时保持既有文案（向后兼容）')
})

test('stagingBlockReason：外机档理由是「不可核验」而不是「无证据回链」', () => {
  const foreign = enrichCandidate(CAND({ id: 'cm_f', claimDomain: 'work', evidenceIds: [], backlinkTier: 'unverifiable_foreign' }), [])
  const local = enrichCandidate(CAND({ id: 'cm_l', claimDomain: 'work', evidenceIds: [], backlinkTier: 'missing_backlink' }), [])
  const rForeign = stagingBlockReason(foreign)
  const rLocal = stagingBlockReason(local)
  assert.ok(/不可核验/.test(rForeign), rForeign)
  assert.ok(/本机/.test(rLocal), rLocal)
  // 判据不变：都挡
  assert.ok(rForeign && rLocal)
})

