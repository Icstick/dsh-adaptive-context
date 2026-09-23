// test/ledger-import-stamp.test.mjs
// ---------------------------------------------------------------------------
// 背景（2026-09-23 真实踩到）：ledger-import 每次都用**同名** <in>.manifest.json，
// 而后续「无新行」的运行会把它覆盖成 count:0 / ids:[] —— 于是 ledger-release 再也
// 看不到可放行的 id，放行依据被抹掉（当时只能从导入载荷 .jsonl 重建）。
// 本测试钉住：导入必须**额外**落一份带时间戳的副本。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function env(id, text) {
  return {
    kind: 'observation', version: 1, ts: Date.now(),
    data: {
      id, scopeId: 'user-global', subject: 's-' + id, predicate: 'p', claimDomain: 'work',
      authority: 'user_explicit', text, evidenceIds: [], supersedes: [],
      state: 'active', observedAt: new Date().toISOString(), createdAt: Date.now(),
    },
  }
}

test('ledger-import 额外落一份带时间戳的 manifest（历史不被覆盖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-imp-'))
  const dsh = join(root, 'dsh')
  mkdirSync(join(dsh, 'acp'), { recursive: true })
  const inFile = join(root, 'from-x-observation.jsonl')
  writeFileSync(inFile, [env('obs_stamp_1', '一'), env('obs_stamp_2', '二')].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const r = spawnSync(process.execPath, ['scripts/ledger-import.mjs', '--in', inFile, '--from', 'X', '--apply'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, DSH_HOME: dsh },
  })
  assert.equal(r.status, 0, '导入应成功: ' + r.stderr)

  const files = readdirSync(root).filter((f) => f.startsWith('from-x-observation.jsonl.manifest'))
  assert.ok(files.includes('from-x-observation.jsonl.manifest.json'), '原有的同名 manifest 必须保留（向后兼容）')
  const stamped = files.find((f) => /\.manifest-\d{4}-\d{2}-\d{2}T/.test(f))
  assert.ok(stamped, '必须额外落一份带时间戳的副本，实际: ' + JSON.stringify(files))

  const m = JSON.parse(readFileSync(join(root, stamped), 'utf8'))
  assert.equal(m.count, 2)
  assert.deepEqual(m.ids.sort(), ['obs_stamp_1', 'obs_stamp_2'])
})
