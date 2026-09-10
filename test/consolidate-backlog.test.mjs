// test/consolidate-backlog.test.mjs — 审计 H-4（2026-09-10）：维护脚本的凭据/端点信任边界。
// 覆盖：host allowlist（默认集 + 显式扩展 + 各类绕过形态）/ 凭据来源闸门（默认只读 env）/
//       子进程端到端：非白名单端点退出、缺 --from-credentials 时不读 .credentials.yaml。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ALLOWED_HOSTS, resolveAllowedHosts, assertAllowedBaseUrl, loadApiKey,
} from '../scripts/consolidate-backlog.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/consolidate-backlog.mjs', import.meta.url))

function freshDir(t, prefix = 'acp-backlog-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 跑脚本（子进程），返回 { status, stderr, stdout } */
function runScript(args, env = {}) {
  const clean = { ...process.env, ...env }
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: clean, timeout: 60000 })
}

// ── allowlist ─────────────────────────────────────────────────────────────

test('assertAllowedBaseUrl：默认白名单放行官方域名', () => {
  const hosts = resolveAllowedHosts({})
  assert.deepEqual([...DEFAULT_ALLOWED_HOSTS], ['api.deepseek.com'])
  for (const url of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/',
    'https://API.DeepSeek.com/v1',
    'https://api.deepseek.com:443/chat',
  ]) {
    assert.equal(assertAllowedBaseUrl(url, hosts).hostname.toLowerCase(), 'api.deepseek.com', url)
  }
})

test('assertAllowedBaseUrl：非白名单 / 各类绕过形态一律拒绝', () => {
  const hosts = resolveAllowedHosts({})
  const bad = [
    'https://evil.example.com',
    'https://api.deepseek.com.evil.com',   // 后缀伪装
    'https://evil-api.deepseek.com',       // 前缀伪装
    'https://api.deepseek.com@evil.com',   // userinfo 伪装（真实 host 是 evil.com）
    'http://127.0.0.1:8080',               // 本地回环不在默认白名单
    'http://[::ffff:127.0.0.1]/v1',        // IPv4-mapped IPv6
    'file:///etc/passwd',                  // 协议不符
    'not a url',
  ]
  for (const url of bad) {
    assert.throws(() => assertAllowedBaseUrl(url, hosts), /allowlist|协议|合法 URL/, url)
  }
})

test('resolveAllowedHosts：--allow-hosts / 环境变量可显式扩展；默认集始终在', (t) => {
  const saved = process.env.ACP_CONSOLIDATE_ALLOW_HOSTS
  t.after(() => {
    if (saved === undefined) delete process.env.ACP_CONSOLIDATE_ALLOW_HOSTS
    else process.env.ACP_CONSOLIDATE_ALLOW_HOSTS = saved
  })
  delete process.env.ACP_CONSOLIDATE_ALLOW_HOSTS
  const set = resolveAllowedHosts({ 'allow-hosts': 'Gateway.Corp.Local, api-proxy.internal' })
  assert.ok(set.has('api.deepseek.com'), '默认集仍在')
  assert.ok(set.has('gateway.corp.local'), '小写化后的显式扩展')
  assert.ok(set.has('api-proxy.internal'))

  process.env.ACP_CONSOLIDATE_ALLOW_HOSTS = 'env-host.example.com'
  assert.ok(resolveAllowedHosts({}).has('env-host.example.com'))
})

// ── 凭据来源闸门 ───────────────────────────────────────────────────────────

test('loadApiKey：默认只读环境变量；未开开关时不读 .credentials.yaml', (t) => {
  const home = freshDir(t)
  writeFileSync(path.join(home, '.credentials.yaml'), 'refs:\n  ACP_TEST_KEY_HYPHEN_X: file-secret\n', 'utf8')
  const savedHome = process.env.DSH_HOME
  t.after(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    delete process.env.ACP_TEST_KEY_HYPHEN_X
  })
  process.env.DSH_HOME = home

  assert.equal(loadApiKey('ACP_TEST_KEY_HYPHEN_X'), null, '未开开关 → 不读文件')
  assert.equal(loadApiKey('ACP_TEST_KEY_HYPHEN_X', { fromCredentials: false }), null)
  assert.deepEqual(
    loadApiKey('ACP_TEST_KEY_HYPHEN_X', { fromCredentials: true }),
    { key: 'file-secret', source: 'credentials' },
  )

  process.env.ACP_TEST_KEY_HYPHEN_X = 'env-secret'
  assert.deepEqual(loadApiKey('ACP_TEST_KEY_HYPHEN_X'), { key: 'env-secret', source: 'env' }, 'env 优先')
  assert.deepEqual(loadApiKey('ACP_TEST_KEY_HYPHEN_X', { fromCredentials: true }).source, 'env')
})

test('loadApiKey：非法名字（正则注入面）直接抛错', () => {
  assert.throws(() => loadApiKey('BAD-NAME'), /字母数字下划线/)
  assert.throws(() => loadApiKey('a.*'), /字母数字下划线/)
})

// ── 端到端（子进程）────────────────────────────────────────────────────────

test('端到端：非白名单 base-url → 退出码 3，凭据不外发', () => {
  const r = runScript(['--base-url', 'https://evil.example.com', '--key', 'ACP_TEST_NO_SUCH_KEY'])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /allowlist/)
  assert.match(r.stderr, /evil.example.com/)
  assert.doesNotMatch(r.stdout + r.stderr, /即将把/, '未过白名单不得进入外发路径')
})

test('端到端：白名单端点但无 env key 且未加 --from-credentials → 退出码 2 且提示开关', (t) => {
  const home = freshDir(t)
  writeFileSync(path.join(home, '.credentials.yaml'), 'refs:\n  ACP_TEST_NO_SUCH_KEY: file-secret\n', 'utf8')
  const r = runScript(['--key', 'ACP_TEST_NO_SUCH_KEY', '--dir', freshDir(t)], {
    DSH_HOME: home,
    ACP_TEST_NO_SUCH_KEY: '',
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--from-credentials/)
})

test('端到端：显式 --from-credentials → 打印外发目标（含来源），key 不出现在输出里', (t) => {
  const home = freshDir(t)
  writeFileSync(path.join(home, '.credentials.yaml'), 'refs:\n  ACP_TEST_NO_SUCH_KEY: file-secret\n', 'utf8')
  const r = runScript(
    ['--key', 'ACP_TEST_NO_SUCH_KEY', '--from-credentials', '--dir', freshDir(t)],
    { DSH_HOME: home, ACP_TEST_NO_SUCH_KEY: '' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /即将把 ACP_TEST_NO_SUCH_KEY（来源: \.credentials\.yaml）发往 api\.deepseek\.com/)
  assert.doesNotMatch(r.stdout + r.stderr, /file-secret/, '凭据不落日志')
})
