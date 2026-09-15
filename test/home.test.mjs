// test/home.test.mjs — DSH home 解析的回落链与「绝不回落 cwd」不变量。
//
// 回归背景（2026-09-15）：此前多处写 `process.env.DSH_HOME || ''`，DSH_HOME 未设时
// path.join('', 'acp') === 'acp'（相对路径）→ 账本被静默写到进程 cwd 下。
// 本文件第 2 组用例即该缺陷的红-绿阀门：旧写法必须被判为相对路径，新写法必须绝对。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { resolveDshHome } from '../src/home.mjs'
import { openEvidenceLedger } from '../src/store.mjs'

// ---------- 1. 显式 DSH_HOME ----------

test('resolveDshHome：显式 DSH_HOME 被采纳并解析为绝对路径', () => {
  const got = resolveDshHome({ DSH_HOME: path.join(tmpdir(), 'explicit-dsh') })
  assert.ok(path.isAbsolute(got))
  assert.equal(got, path.resolve(path.join(tmpdir(), 'explicit-dsh')))
})

test('resolveDshHome：相对形式的 DSH_HOME 被 resolve 成绝对路径', () => {
  const got = resolveDshHome({ DSH_HOME: 'some/rel/home' })
  assert.ok(path.isAbsolute(got), '相对 DSH_HOME 必须被 resolve，否则后续 join 仍是相对的')
})

test('resolveDshHome：首尾空白被 strip 后仍有效', () => {
  const got = resolveDshHome({ DSH_HOME: '  ' + path.join(tmpdir(), 'pad') + '  ' })
  assert.equal(got, path.resolve(path.join(tmpdir(), 'pad')))
})

// ---------- 2. 回落与「绝不回落 cwd」不变量（核心回归） ----------

test('resolveDshHome：DSH_HOME 缺席时回落 ~/.dsh', () => {
  assert.equal(resolveDshHome({}), path.join(homedir(), '.dsh'))
})

test('resolveDshHome：DSH_HOME 为空串时回落 ~/.dsh（旧写法在此产生相对路径）', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '' }), path.join(homedir(), '.dsh'))
})

test('resolveDshHome：DSH_HOME 为纯空白时回落 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), path.join(homedir(), '.dsh'))
})

test('回归：旧的 `DSH_HOME || \'\'` 写法产生相对路径，新写法不会', () => {
  // 旧写法 —— 这正是 2026-09-15 修掉的缺陷（DSH_HOME 缺席时回落值是空串）
  const unsetDshHome = ''
  const legacy = path.join(unsetDshHome, 'acp')
  assert.equal(legacy, 'acp')
  assert.equal(path.isAbsolute(legacy), false, '旧写法应被判为相对路径（即缺陷本身）')

  // 新写法 —— 无论 DSH_HOME 是否设置，都必须是绝对路径
  for (const env of [{}, { DSH_HOME: '' }, { DSH_HOME: '   ' }, { DSH_HOME: 'x/y' }]) {
    const got = path.join(resolveDshHome(env), 'acp')
    assert.ok(path.isAbsolute(got), '新写法在 env=' + JSON.stringify(env) + ' 下仍非绝对路径: ' + got)
  }
})

// ---------- 3. 接线：openEvidenceLedger 的默认落点 ----------

test('接线：未显式传 dir 时，账本落在 $DSH_HOME/acp 而非 cwd', () => {
  const saved = process.env.DSH_HOME
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'acp-home-'))
  try {
    process.env.DSH_HOME = fakeHome
    const ledger = openEvidenceLedger({})
    assert.ok(existsSync(path.join(fakeHome, 'acp', 'acp-ledger.db')),
      '账本应落在 $DSH_HOME/acp 下')
    assert.equal(existsSync(path.join(process.cwd(), 'acp-ledger.db')), false,
      '账本不得落在 cwd —— 这正是被修掉的缺陷形态')
    ledger?.close?.()
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(fakeHome, { recursive: true, force: true })
  }
})