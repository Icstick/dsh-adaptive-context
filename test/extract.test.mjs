// test/extract.test.mjs — extract 规范化测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEvidenceWorthy, extractText, sourceClassOf, authorityOf,
  claimDomainOf, isCorrection, toEvidenceCandidate, isSystemInjected,
  isCompactionCheckpoint,
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

test('真实 DSH 事件：agent/inbox/spliced 用户消息 → user_input', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 4,
    time: 1787669403035,
    data: {
      target: 'next-turn',
      inserted: [{ content: [{ type: 'text', text: '这个项目用 pnpm' }], source: { kind: 'user', rpcId: 'r1' }, role: 'user', id: 'msg-1' }],
    },
  }
  assert.equal(isEvidenceWorthy(ev), true)
  assert.equal(extractText(ev), '这个项目用 pnpm')
  assert.equal(sourceClassOf(ev), 'user_input')
  assert.equal(authorityOf(ev), 'user_explicit')
  const cand = toEvidenceCandidate(ev, { sessionId: 'session-a' })
  assert.deepEqual(cand.sourceRef, { sessionEventId: 'session-a:4' })
  // 幂等：同一事件两次同 sourceRef
  const cand2 = toEvidenceCandidate(ev, { sessionId: 'session-a' })
  assert.deepEqual(cand.sourceRef, cand2.sourceRef)
  assert.equal(cand.contentHash, cand2.contentHash)
})

test('真实 DSH 事件：agent/inbox/spliced 工具结果 → external_tool', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 9,
    data: {
      inserted: [{ content: [{ type: 'text', text: 'package.json 显示 packageManager: pnpm' }], source: { kind: 'tool' }, role: 'user', id: 'msg-2' }],
    },
  }
  assert.equal(sourceClassOf(ev), 'external_tool')
  assert.equal(authorityOf(ev), 'external_information')
  assert.equal(claimDomainOf(ev), 'external_fact')
})

test('真实 DSH 事件：turn/start 无文本不摄入', () => {
  const ev = { type: 'turn/start', seq: 5, data: { turn: 1 } }
  assert.equal(isEvidenceWorthy(ev), false)
})
test('send_message 续派（coordinator relay）→ agent_authored（不再 fallback user_input）', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 11,
    data: {
      inserted: [{
        content: [{ type: 'text', text: '继续完成剩余的部分，不要改动已有代码' }],
        source: { kind: 'coordinator', form: 'relay', senderSessionId: 'parent-1' },
        role: 'user', id: 'msg-3',
      }],
    },
  }
  assert.equal(sourceClassOf(ev), 'agent_authored')
  assert.equal(authorityOf(ev), 'single_observation')
  assert.equal(claimDomainOf(ev), 'experience')
  assert.equal(isCorrection(ev), false) // 非 user 来源永不判纠正
})

test('子代理完成通知（subagent-settled）→ agent_authored', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 12,
    data: {
      inserted: [{
        content: [{ type: 'text', text: 'Background subagent child-1 finished and will do no further work unless you send it more.' }],
        source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-1' },
        role: 'user', id: 'msg-4',
      }],
    },
  }
  assert.equal(sourceClassOf(ev), 'agent_authored')
  assert.equal(isCorrection(ev), false)
})

test('未知 source.kind → agent_authored（保守，不再冒充 user_input）', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 13,
    data: {
      inserted: [{ content: [{ type: 'text', text: '来自未知来源的消息' }], source: { kind: 'mystery-kind' }, role: 'user', id: 'msg-5' }],
    },
  }
  assert.equal(sourceClassOf(ev), 'agent_authored')
  assert.equal(authorityOf(ev), 'single_observation')
  assert.equal(claimDomainOf(ev), 'experience')
})

test('子代理任务书（含纠正词）不判 correction → user_input', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 14,
    data: {
      inserted: [{
        content: [{ type: 'text', text: '你是 dsh-desktop-shell 项目的 M4-C 子代理 C1。任务：实现 crates/browser-provider（纯逻辑 crate）。不要改动其他 crate 的接口。' }],
        source: { kind: 'user' }, role: 'user', id: 'msg-6',
      }],
    },
  }
  assert.equal(isCorrection(ev), false) // 任务书特征负向排除
  assert.equal(sourceClassOf(ev), 'user_input')
  assert.equal(authorityOf(ev), 'user_explicit')
  assert.equal(claimDomainOf(ev), 'user_fact')
})

test('短纠正句不受任务书排除影响（"你是对的，不要用那个方案"）', () => {
  const ev = { type: 'user/message', id: 'e8', content: '你是对的，不要用那个方案' }
  assert.equal(isCorrection(ev), true)
  assert.equal(sourceClassOf(ev), 'user_correction')
})

test('tool 结果含纠正词不判 correction', () => {
  const ev = { type: 'tool/result', id: 'e9', content: 'lint 输出：不要使用 console.log，改用 logger' }
  assert.equal(isCorrection(ev), false)
  assert.equal(sourceClassOf(ev), 'external_tool')
})

test('system-reminder 内容不摄入', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 15,
    data: {
      inserted: [{
        content: [{ type: 'text', text: '<system-reminder> Additional instructions from: AGENTS.md  T...' }],
        source: { kind: 'user' }, role: 'user', id: 'msg-7',
      }],
    },
  }
  assert.equal(isEvidenceWorthy(ev), false)
  assert.equal(isSystemInjected('<system-reminder> x'), true)
  assert.equal(isSystemInjected('普通用户消息'), false)
})

test('子代理会话降权：kind=user 消息 → agent_authored / agent_inference / experience（quarantine）', () => {
  const ev = {
    type: 'agent/inbox/spliced',
    seq: 16,
    data: {
      inserted: [{ content: [{ type: 'text', text: '你是子代理。任务：实现 feature X。不要改其他部分。' }], source: { kind: 'user' }, role: 'user', id: 'msg-8' }],
    },
  }
  const cand = toEvidenceCandidate(ev, { sessionId: 'child-session', subagent: true })
  assert.equal(cand.sourceClass, 'agent_authored')
  assert.equal(cand.authority, 'agent_inference')
  assert.equal(cand.claimDomain, 'experience')
  assert.equal(cand.confidence, 0.5)
  assert.equal(cand.durability, 0.5)
  // sourceRef 仍保留原会话与 seq（审计可回溯）
  assert.deepEqual(cand.sourceRef, { sessionEventId: 'child-session:16' })
})

test('非子代理会话不降权（opts.subagent 缺省）', () => {
  const ev = { type: 'user/message', id: 'e10', content: '这个项目用 pnpm' }
  const cand = toEvidenceCandidate(ev, { sessionId: 'root-session' })
  assert.equal(cand.sourceClass, 'user_input')
  assert.equal(cand.authority, 'user_explicit')
  assert.equal(cand.claimDomain, 'user_fact')
})

test('compaction checkpoint（user/message + surfaceOp replace）→ 不摄入', () => {
  // 官方引擎压缩后重建的 checkpoint 消息（surfaceOp replace 顶层特征）
  const checkpoint = {
    type: 'user/message',
    seq: 500,
    content: '已压缩 761 条历史记录（约 372810 tokens）',
    surfaceOp: { op: 'replace', start: 10, end: 480 },
    sourceEventSeqs: [499, 500, 1, 2, 3],
  }
  assert.equal(isCompactionCheckpoint(checkpoint), true)
  assert.equal(isEvidenceWorthy(checkpoint), false, '压缩重建消息不摄入——原始被压内容已实时摄入')
  // 对照：真实用户消息 surfaceOp='append' 或缺失 → 正常摄入
  assert.equal(isEvidenceWorthy({ type: 'user/message', content: '我们用 pnpm' }), true)
  assert.equal(isEvidenceWorthy({ type: 'user/message', content: '继续', surfaceOp: 'append' }), true)
})

test('eventKindOf：事件自带 source.kind（非 user）不冒充 user_input', () => {
  // 插件以 user 角色 append 但显式标注 source.kind='plugin' → agent_authored
  const pluginMsg = {
    type: 'user/message',
    data: { source: { kind: 'plugin', plugin: 'some-plugin' } },
    content: '插件注入的说明文本',
  }
  assert.equal(sourceClassOf(pluginMsg), 'agent_authored')
  assert.equal(claimDomainOf(pluginMsg), 'experience')
  // source.kind='user' 显式标注 → 仍判 user
  const userMsg = { type: 'user/message', data: { source: { kind: 'user' } }, content: '真实用户消息' }
  assert.equal(sourceClassOf(userMsg), 'user_input')
})
