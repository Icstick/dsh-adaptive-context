// test/extract.test.mjs — extract 规范化测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEvidenceWorthy, extractText, sourceClassOf, authorityOf,
  claimDomainOf, isCorrection, toEvidenceCandidate,
} from '../src/extract.mjs'
import { evidenceIdOf } from '../src/constants.mjs'

test('user 普通消息 → user_input / user_explicit / user_fact', () => {
  const ev = { type: 'user/message', id: 'e1', content: '我们这个项目用 pnpm' }
  assert.equal(isEvidenceWorthy(ev), true)
  assert.equal(sourceClassOf(ev), 'user_input')
  assert.equal(authorityOf(ev), 'user_explicit')
  assert.equal(claimDomainOf(ev), 'user_fact')
})

test('user 纠正消息 → user_correction / user_correction / user_preference', () => {
  const ev = { type: 'user/message', id: 'e2', content: '更正：这个项目之后统一用 Bun' }
  assert.equal(isCorrection(ev), true)
  assert.equal(sourceClassOf(ev), 'user_correction')
  assert.equal(authorityOf(ev), 'user_correction')
  assert.equal(claimDomainOf(ev), 'user_preference')
})

test('tool 结果 → external_tool / external_information / external_fact', () => {
  const ev = { type: 'tool/result', id: 'e3', content: 'package.json 显示 packageManager: pnpm@10' }
  assert.equal(sourceClassOf(ev), 'external_tool')
  assert.equal(authorityOf(ev), 'external_information')
  assert.equal(claimDomainOf(ev), 'external_fact')
})

test('空内容不摄入', () => {
  assert.equal(isEvidenceWorthy({ type: 'user/message', id: 'e4', content: '' }), false)
  assert.equal(isEvidenceWorthy({ type: 'unknown/x', id: 'e5', content: 'hi' }), false)
})

test('toEvidenceCandidate 幂等：同事件两次同 id', () => {
  const ev = { type: 'user/message', id: 'e6', content: '默认用 pnpm' }
  const a = toEvidenceCandidate(ev)
  const b = toEvidenceCandidate(ev)
  assert.equal(a.contentHash, b.contentHash)
  assert.deepEqual(a.sourceRef, b.sourceRef)
  // 写入 store 后同 id（靠 evidenceIdOf 派生）
  assert.equal(evidenceIdOf({ sourceRef: a.sourceRef, contentHash: a.contentHash }),
               evidenceIdOf({ sourceRef: b.sourceRef, contentHash: b.contentHash }))
})

test('agent 消息 → agent_authored / single_observation / experience', () => {
  const ev = { type: 'assistant/message', id: 'e7', content: '我检查了配置文件' }
  assert.equal(sourceClassOf(ev), 'agent_authored')
  assert.equal(authorityOf(ev), 'single_observation')
  assert.equal(claimDomainOf(ev), 'experience')
})