// test/ack-only.test.mjs — 纯应答短消息不进蒸馏队列（2026-09-22）
// 验收目标：判定保守（宁可漏判，不误杀含信息的短句）+ 真的把队列里的零信息续跑句剔掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEvidenceLedger } from '../src/store.mjs'
import { isAckText, isAckOnlySkippable, createConsolidator, ACK_FILLERS } from '../src/consolidate.mjs'
import { ACK_ONLY_MAX_CHARS } from '../src/constants.mjs'

test('isAckText：纯应答为真', () => {
  for (const s of ['继续', '继续吧', '重启好了', '可以继续', '好', '好的', '可以的',
    '重试一下', '再试一下', '接着继续', '好，可以继续', '已经重启了', '测试测试~',
    '  继续  ', '？？？', '']) {
    assert.equal(isAckText(s), true, '应判为应答: ' + JSON.stringify(s))
  }
})

test('isAckText：含信息的一律保留（真机实测过的反例集）', () => {
  const keep = [
    '可以继续，就保留warn吧',   // 含偏好（warn 级别保留）
    'B+C吧',                    // 含选项（拉丁字母）
    '行，那就2吧',              // 含选项（数字）
    '可以push',                 // 含授权
    '分两个comit先提交吧',       // 含习惯
    '继续吧,lint超时了',         // 含现象
    '好，做C的隔离',            // 含指令
    '报错了？',                 // 含信号
    '先准备候选list吧',
    'B机使用的是ZOOT账户',
    '先做报告导出，再打磨视觉外观吧',
    '清掉吧，回头再说',
    '不用了，保持这样就好',
  ]
  for (const s of keep) assert.equal(isAckText(s), false, '不该判为应答: ' + s)
})

test('isAckText：超长文本一律不判应答（长度闸门）', () => {
  const long = '继续'.repeat(ACK_ONLY_MAX_CHARS)   // 全是应答词但超长 → 不判
  assert.ok(long.length > ACK_ONLY_MAX_CHARS)
  assert.equal(isAckText(long), false)
})

test('isAckOnlySkippable：只作用于 user_input；纠正不参与判定', () => {
  assert.equal(isAckOnlySkippable({ sourceClass: 'user_input', content: '继续' }), true)
  assert.equal(isAckOnlySkippable({ sourceClass: 'user_correction', content: '继续' }), false)
  assert.equal(isAckOnlySkippable({ sourceClass: 'agent_authored', content: '继续' }), false)
  assert.equal(isAckOnlySkippable({ sourceClass: 'user_input', content: '继续' }, false), false, '开关可关')
})

test('ACK_FILLERS 不含数字/拉丁字母（保住「B+C吧」「可以push」的关键）', () => {
  for (const f of ACK_FILLERS) {
    assert.equal(/[0-9A-Za-z]/.test(f), false, 'fillers 不得含字母数字: ' + f)
  }
})

test('createConsolidator：纯应答不进队列，含信息的照进', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-ack-'))
  const ledger = openEvidenceLedger({ dir })
  const EV = {
    sensitivity: 'private', confidence: 0.9, durability: 0.5,
    observedAt: '2026-09-22T00:00:00.000Z',
    sourceClass: 'user_input', authority: 'user_explicit', claimDomain: 'user_fact',
  }
  ledger.append({ ...EV, content: '继续', sourceRef: { sessionEventId: 's:1' } })
  ledger.append({ ...EV, content: '重启好了', sourceRef: { sessionEventId: 's:2' } })
  ledger.append({ ...EV, content: '可以继续，就保留warn吧', sourceRef: { sessionEventId: 's:3' } })

  const c = createConsolidator({ ledger, minEvidence: 1, minTurns: 1, llmCall: null })
  const queue = c.undigestedEvidence()
  assert.equal(queue.length, 1, '只剩含信息的那条')
  assert.equal(queue[0].content, '可以继续，就保留warn吧')

  // 关掉开关 → 三条都进（可回滚性）
  const c2 = createConsolidator({ ledger, minEvidence: 1, minTurns: 1, llmCall: null, skipAckOnly: false })
  assert.equal(c2.undigestedEvidence().length, 3)
  ledger.close()
})
