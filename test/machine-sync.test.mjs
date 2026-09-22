// test/machine-sync.test.mjs — 单机接续脚本（2026-09-22）
// 验收目标：**只做加法**（绝不改写/删除既有内容）、幂等、找不到目标时如实报而不是瞎写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, ensureDisabled, ensureRecallProviders, findProfilePatches } from '../scripts/machine-sync.mjs'

const PATCH = [
  '- id: system-prompt',
  '  config:',
  '    x: 1',
  '',
  '- id: memos-local-memory',
  '  config:',
  '    enabled: true',
  '',
  '- id: adaptive-context',
  '  config:',
  '    hotTokens: 1600',
  '    sectionQuota:',
  '      memory: 290',
  '',
  '- id: work-continuity',
  '  config: {}',
  '',
].join('\n')

test('parseArgs：缺省 dry-run；--apply / --verify / --home', () => {
  assert.equal(parseArgs([]).apply, false)
  assert.equal(parseArgs(['--apply']).apply, true)
  assert.equal(parseArgs(['--verify']).verify, true)
  assert.equal(parseArgs(['--home', 'X:/h']).home, 'X:/h')
})

test('ensureDisabled：插入在 entry 首行之后，且只加一行', () => {
  const r = ensureDisabled(PATCH, 'memos-local-memory')
  assert.equal(r.changed, true)
  const lines = r.text.split('\n')
  const i = lines.findIndex((l) => l.trim() === '- id: memos-local-memory')
  assert.equal(lines[i + 1], '  disabled: true')
  assert.equal(lines.length, PATCH.split('\n').length + 1, '只多一行')
})

test('ensureDisabled：幂等——已有就什么都不做', () => {
  const once = ensureDisabled(PATCH, 'memos-local-memory').text
  const twice = ensureDisabled(once, 'memos-local-memory')
  assert.equal(twice.changed, false)
  assert.match(twice.reason, /已是/)
  assert.equal(twice.text, undefined)
})

test('ensureDisabled：entry 不存在 → 如实报，不改文本', () => {
  const r = ensureDisabled(PATCH, 'no-such-plugin')
  assert.equal(r.changed, false)
  assert.match(r.reason, /不存在/)
})

test('ensureDisabled：不会把别的 entry 的 disabled 误算成自己的', () => {
  const withOther = ['- id: memos-local-memory', '  config:', '    enabled: true', '- id: other', '  disabled: true', ''].join('\n')
  assert.equal(ensureDisabled(withOther, 'memos-local-memory').changed, true)
})

test('ensureRecallProviders：插到 config 块尾，缩进 4 空格且在块内', () => {
  const r = ensureRecallProviders(PATCH)
  assert.equal(r.changed, true)
  const lines = r.text.split('\n')
  const i = lines.findIndex((l) => l.trim() === '- id: adaptive-context')
  const j = lines.findIndex((l) => l === '    recallProviders: []')
  const k = lines.findIndex((l) => l.trim() === '- id: work-continuity')
  assert.ok(i < j && j < k, '必须落在 adaptive-context 块内')
})

test('ensureRecallProviders：幂等', () => {
  const once = ensureRecallProviders(PATCH).text
  const twice = ensureRecallProviders(once)
  assert.equal(twice.changed, false)
  assert.match(twice.reason, /已设置/)
})

test('ensureRecallProviders：entry 没有 config 块 → 跳过并让人工确认', () => {
  const r = ensureRecallProviders(['- id: adaptive-context', '  # 只有注释', '- id: next', ''].join('\n'))
  assert.equal(r.changed, false)
  assert.match(r.reason, /没有 config/)
})

test('只做加法：改动后的文本必须包含原文的每一行', () => {
  const a = ensureDisabled(PATCH, 'memos-local-memory').text
  const b = ensureRecallProviders(a).text
  for (const line of PATCH.split('\n')) {
    if (!line.trim()) continue
    assert.ok(b.includes(line), '丢了行: ' + JSON.stringify(line))
  }
})

test('findProfilePatches：只挑含 adaptive-context 的 profile', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'acp-sync-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'other'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), PATCH, 'utf8')
  writeFileSync(join(home, 'profiles', 'other', 'cordis.patch.yml'), '- id: whatever\n', 'utf8')
  const found = findProfilePatches(home)
  assert.equal(found.length, 1)
  assert.equal(found[0].profile, 'web')
})

test('findProfilePatches：没有 profiles 目录 → 空数组，不抛', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'acp-sync2-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assert.deepEqual(findProfilePatches(home), [])
})
