// test/views.test.mjs — M3 B3 materialized view（views are rebuildable）。
// 验收 oracle：
//   1) writeExpression → 文件生成（原子写 temp+rename）+ 文件头 checksum；
//      readExpression 往返一致
//   2) readExpression：文件缺失/损坏/schema 不符 → null（fail-open）
//   3) verifyExpression 与 candidate 重放对比：一致 → ok；篡改（行/checksum）→ 失配
//   4) 漂移：promoted 候选 rollback 后视图未重建 → verify 失配；rebuildExpression 恢复
//   5) buildExpressionRows：只投影 promoted 候选（rejected/rolled_back 排除）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import {
  createViews, buildExpressionRows, checksumOf,
  EXPRESSION_VIEW_FILE, VIEW_SCHEMA, VIEW_VERSION,
} from '../src/views.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-view-'))
  const ledger = openEvidenceLedger({ dir })
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, ledger }
}

function freshViews(t, opts = {}) {
  const { dir, ledger } = fresh(t)
  const vdir = mkdtempSync(path.join(tmpdir(), 'acp-view-files-'))
  t.after(() => rmSync(vdir, { recursive: true, force: true }))
  const views = createViews({ dir: vdir, ledger, candidateStore: ledger.candidateStore, ...opts })
  return { dir, ledger, views, vdir }
}

/** 造一条 style 证据 + 一个 promoted 候选（view 行的标准来源） */
function seedPromoted(t, { scopeId = 'user-global' } = {}) {
  const { ledger, views, vdir } = freshViews(t, { scopeId })
  const res = ledger.append({
    sourceClass: 'user_input',
    authority: 'user_explicit',
    confidence: 1,
    durability: 0.7,
    sensitivity: 'private',
    claimDomain: 'style',
    content: '回答风格：先给结论，再给理由',
    sourceRef: { sessionEventId: 'view-1', messageId: 'm1' },
  })
  const ev = ledger.getById(res.id)
  const cand = ledger.candidateStore.createCandidate({ scopeId, domain: 'style', evidenceIds: [ev.id] })
  ledger.candidateStore.transitionCandidate(cand.id, 'promote', { reason: 'test', actor: 'user' })
  return { ledger, views, vdir, ev, cand }
}

// ── oracle 1：write/read 往返 + 原子写 ─────────────────────────────────────

test('writeExpression → readExpression 往返一致；文件头含 schema/checksum', (t) => {
  const { views, vdir } = freshViews(t)
  const rows = [
    { id: 'ev_1', content: '先给结论', claimDomain: 'style', state: 'active', scopeId: 'user-global' },
    { id: 'ev_2', content: '简洁', claimDomain: 'style', state: 'active', scopeId: 'user-global' },
  ]
  const res = views.writeExpression(rows)
  assert.equal(res.rows, 2)
  assert.equal(res.checksum, checksumOf(rows))
  assert.ok(existsSync(path.join(vdir, EXPRESSION_VIEW_FILE)))

  const parsed = JSON.parse(readFileSync(path.join(vdir, EXPRESSION_VIEW_FILE), 'utf8'))
  assert.equal(parsed.schema, VIEW_SCHEMA)
  assert.equal(parsed.version, VIEW_VERSION)
  assert.equal(parsed.checksum, res.checksum)
  assert.deepEqual(views.readExpression(), rows)
})

test('原子写：二次写入覆盖旧内容，不留 temp 残留文件', (t) => {
  const { views, vdir } = freshViews(t)
  views.writeExpression([{ id: 'a', content: 'one', claimDomain: 'style' }])
  views.writeExpression([{ id: 'b', content: 'two', claimDomain: 'style' }])
  const rows = views.readExpression()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'b')
  const leftovers = readdirSafe(vdir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

// ── oracle 2：readExpression fail-open ─────────────────────────────────────

test('readExpression：文件缺失 → null', (t) => {
  const { views } = freshViews(t)
  assert.equal(views.readExpression(), null)
})

test('readExpression：文件损坏 → null（fail-open，不抛错）', (t) => {
  const { views, vdir } = freshViews(t)
  writeFileSync(path.join(vdir, EXPRESSION_VIEW_FILE), 'not-json{{{', 'utf8')
  assert.equal(views.readExpression(), null)
})

test('readExpression：schema/version 不符 → null', (t) => {
  const { views, vdir } = freshViews(t)
  writeFileSync(path.join(vdir, EXPRESSION_VIEW_FILE), JSON.stringify({ schema: 'other', version: 99, rows: [1] }), 'utf8')
  assert.equal(views.readExpression(), null)
})

// ── oracle 3：verifyExpression 与 candidate 重放对比 ───────────────────────

test('verifyExpression：与重放一致 → ok + checksum', (t) => {
  const { ledger, views } = seedPromoted(t)
  views.rebuildExpression()
  const v = views.verifyExpression()
  assert.equal(v.ok, true)
  assert.equal(v.mismatches.length, 0)
  assert.equal(v.checksum, checksumOf(views.readExpression()))
  // 重放一致性：checksum 与 candidate 重放重建一致
  const replayChecksum = checksumOf(buildExpressionRows({ candidateStore: ledger.candidateStore, ledger }))
  assert.equal(v.checksum, replayChecksum)
})

test('verifyExpression：文件缺失 → ok:false + 明确 mismatch', (t) => {
  const { views } = freshViews(t)
  const v = views.verifyExpression()
  assert.equal(v.ok, false)
  assert.ok(v.mismatches.some((m) => m.includes('view file missing')))
})

test('verifyExpression：篡改行内容 → tampered/drift 失配', (t) => {
  const { views, vdir } = seedPromoted(t)
  views.rebuildExpression()
  // 篡改：行内容改掉但文件头 checksum 保持旧值
  const file = path.join(vdir, EXPRESSION_VIEW_FILE)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  parsed.rows[0].content = '被篡改的内容'
  writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8')
  const v = views.verifyExpression()
  assert.equal(v.ok, false)
  assert.ok(v.mismatches.some((m) => m.includes('tampered')))
  assert.ok(v.mismatches.some((m) => m.includes('drift')))
})

test('verifyExpression：仅篡改 checksum 字段 → tampered 失配（行未被改）', (t) => {
  const { views, vdir } = seedPromoted(t)
  views.rebuildExpression()
  const file = path.join(vdir, EXPRESSION_VIEW_FILE)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  parsed.checksum = 'f'.repeat(64)
  writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8')
  const v = views.verifyExpression()
  assert.equal(v.ok, false)
  assert.ok(v.mismatches.some((m) => m.includes('tampered')))
  // 行内容未被改 → 无 drift 失配
  assert.equal(v.mismatches.some((m) => m.includes('drift')), false)
})

// ── oracle 4：漂移 + rebuild 恢复 ──────────────────────────────────────────

test('verifyExpression：rollback 后视图未重建 → 漂移失配（in view only）；rebuild 恢复', (t) => {
  const { ledger, views, cand } = seedPromoted(t)
  views.rebuildExpression()
  assert.equal(views.verifyExpression().ok, true)

  // rollback 候选（不重建视图）→ 视图 stale
  ledger.candidateStore.transitionCandidate(cand.id, 'rollback', { reason: 'test', actor: 'user' })
  const v = views.verifyExpression()
  assert.equal(v.ok, false)
  assert.ok(v.mismatches.some((m) => m.includes('drift')))
  assert.ok(v.mismatches.some((m) => m.includes('in view only')))

  // rebuildExpression → 视图与重放一致
  views.rebuildExpression()
  assert.equal(views.verifyExpression().ok, true)
  assert.equal(views.readExpression().length, 0)
})

// ── oracle 5：buildExpressionRows 投影规则 ─────────────────────────────────

test('buildExpressionRows：只投影 promoted 候选；rejected/rolled_back 排除', (t) => {
  const { ledger, views, ev, cand } = seedPromoted(t)
  const res2 = ledger.append({
    sourceClass: 'user_input', authority: 'user_explicit', confidence: 1, durability: 0.5,
    sensitivity: 'private', claimDomain: 'style', content: '被拒绝的风格', sourceRef: { sessionEventId: 'view-2' },
  })
  const ev2 = ledger.getById(res2.id)
  const cand2 = ledger.candidateStore.createCandidate({ scopeId: 'user-global', domain: 'style', evidenceIds: [ev2.id] })
  ledger.candidateStore.transitionCandidate(cand2.id, 'reject', { reason: 'no', actor: 'user' })

  const rows = buildExpressionRows({ candidateStore: ledger.candidateStore, ledger, scopeId: 'user-global' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, ev.id)
  assert.equal(rows[0].candidateId, cand.id)
  assert.equal(rows[0].content, ev.content)
  assert.equal(rows[0].claimDomain, 'style')
  assert.equal(rows[0].state, 'active')
  assert.equal(rows[0].decisionReason, 'test')
  assert.deepEqual(rows[0].evidenceIds, [ev.id])
  // views.readExpression 与 buildExpressionRows 同源（rebuild 后一致）
  views.rebuildExpression()
  assert.deepEqual(views.readExpression(), rows)
})

// ── 辅助 ───────────────────────────────────────────────────────────────────

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
