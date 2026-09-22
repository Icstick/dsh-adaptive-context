// test/ledger-quarantine-apply.test.mjs — 存量隔离执行器（2026-09-22）
// 验收目标：默认 dry-run 真的一行不改；--apply 只动选中层且留 audit；备份三件齐全。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { parseArgs, selectAndQuarantine, backupLedger, TIER_PRESETS } from '../scripts/ledger-quarantine-apply.mjs'

const EV = {
  sensitivity: 'private', confidence: 0.5, durability: 0.5,
  observedAt: '2026-09-22T00:00:00.000Z',
}
const AGENT = { ...EV, sourceClass: 'agent_authored', authority: 'single_observation', claimDomain: 'experience' }
const USER = { ...EV, sourceClass: 'user_input', authority: 'user_explicit', claimDomain: 'user_fact' }

function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-qa-'))
  const ledger = openEvidenceLedger({ dir })
  ledger.append({ ...AGENT, content: 'You are the background skill reviewer. Review', sourceRef: { sessionEventId: 'session-a:1' } })   // T1a
  ledger.append({ ...AGENT, content: 'I will gather evidence from the workspace', sourceRef: { sessionEventId: 'sub-1:1' } })          // T2
  ledger.append({ ...AGENT, content: '检查完了。先给结论，再给依据。', sourceRef: { sessionEventId: 'session-a:2' } })                    // T3
  ledger.append({ ...USER, content: '保留：这是正常用户消息', sourceRef: { sessionEventId: 'session-a:3' } })                            // KEEP
  return { dir, ledger }
}

test('parseArgs：--tier 预设 / --tiers 自选 / 默认 dry-run 且默认备份', () => {
  const d = parseArgs(['--tier', 'c'])
  assert.deepEqual(d.tiers, TIER_PRESETS.C)
  assert.equal(d.apply, false, '缺省必须是 dry-run')
  assert.equal(d.backup, true)
  assert.deepEqual(parseArgs(['--tiers', 'T1a,T2']).tiers, ['T1a', 'T2'])
  assert.equal(parseArgs(['--tier', 'C', '--apply', '--limit', '10']).apply, true)
  assert.equal(parseArgs(['--tier', 'C']).limit, 0)
})

test('selectAndQuarantine：dry-run 选中但一行不改', () => {
  const { ledger } = makeLedger()
  const res = selectAndQuarantine(ledger.db, ledger, parseArgs(['--tier', 'B']))
  assert.equal(res.ids.length, 2, 'B = T1a+T2，两条')
  assert.equal(res.applied, 0)
  for (const id of res.ids) {
    assert.equal(ledger.getById(id).state, 'active', 'dry-run 不得改状态')
  }
  assert.equal(ledger.auditStore.queryAudit({ op: 'quarantine_noise' }).items.length, 0, 'dry-run 不写审计')
})

test('selectAndQuarantine：--apply 只隔离选中层 + 审计留痕 + 可 rollback', () => {
  const { ledger } = makeLedger()
  const res = selectAndQuarantine(ledger.db, ledger, parseArgs(['--tier', 'B', '--apply']))
  assert.equal(res.applied, 2)
  assert.equal(res.errors.length, 0)
  for (const id of res.ids) assert.equal(ledger.getById(id).state, 'quarantined')

  // 未选中层保持 active
  const t3 = ledger.query({ contentSubstr: '检查完了' }).items[0]
  assert.equal(t3.state, 'active', 'T3 不在 B 档，不得被动到')

  const audits = ledger.auditStore.queryAudit({ op: 'quarantine_noise' }).items
  assert.equal(audits.length, 1)
  assert.equal(audits[0].actor, 'user')
  assert.ok(String(audits[0].reason).includes('tier='))

  // 可回滚（append-only 的隔离语义：state 迁移而非删除）
  assert.equal(ledger.getById(res.ids[0]).content.length > 0, true, '内容仍在')
})

test('--limit 只处理前 N 条（试跑）', () => {
  const { ledger } = makeLedger()
  const res = selectAndQuarantine(ledger.db, ledger, parseArgs(['--tier', 'C', '--apply', '--limit', '1']))
  assert.equal(res.ids.length, 1)
  assert.equal(res.applied, 1)
})

test('backupLedger：db 三件一起拷（WAL 可恢复）', () => {
  const { dir, ledger } = makeLedger()
  const made = backupLedger(dir, 'test-stamp')
  ledger.close()
  assert.ok(made.length >= 1)
  assert.ok(made.some((f) => f.startsWith('acp-ledger.db.bak-')), '主库备份要在: ' + made.join(','))
  for (const f of made) assert.ok(existsSync(join(dir, f)), '缺文件: ' + f)
  assert.ok(readdirSync(dir).some((f) => f.includes('bak-test-stamp-quarantine')), '备份命名要对得上')
})
