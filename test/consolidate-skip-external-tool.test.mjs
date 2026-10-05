// test/consolidate-skip-external-tool.test.mjs —— 2026-10-04 审计 P0-1
//
// 守护的 issue：蒸馏队列积压 7,773 条里 7,156 条（92%）是 external_tool（工具输出转写），
// 而队列头原本没有这道过滤 → 进水 1,068/天 vs 出水 480/天，永不收敛（水位停在 2026-09-27）。
//
// 本文件测**三道**：
//   ① 默认（shadow）：CONSOLIDATION_SKIP_EXTERNAL_TOOL === false ⇒ 一条都不多剔（行为不变）
//   ② 打开后：external_tool 被跳过，其它 sourceClass 不受影响
//   ③ 与既有两道过滤**正交**：这道只管 external_tool，不越界去管 agent_authored / 纯应答

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExternalToolSkippable } from '../src/consolidate.mjs'
import { CONSOLIDATION_SKIP_EXTERNAL_TOOL } from '../src/constants.mjs'

const ev = (sourceClass, extra = {}) => ({ sourceClass, claimDomain: 'experience', content: 'x', ...extra })

// 这条断言的**性质**在 2026-10-04 变了：原来是「守护 shadow 期不许默认打开」，
// 现在开关已被有意打开（妹妹的决定）——它转而**守护「这个值是有人决定的，不是被谁顺手改的」**。
// 换句话说：改这个常量不该让测试变绿，而该让人来改这条断言。
test('P0-1：开关状态是有意为之的（2026-10-04 起打开）', () => {
  assert.equal(
    CONSOLIDATION_SKIP_EXTERNAL_TOOL, true,
    '这个值等于生产行为；要改它就同步改这条断言与 constants.mjs 的注释（打开/回滚的判据都写在那儿）',
  )
})

test('P0-1 shadow 语义仍然可用：显式传 false 时一条都不剔', () => {
  // 开关可回滚是**这道过滤的设计承诺**之一（constants.mjs 的注释里写着回滚方式）。
  // 所以即使默认已打开，「传 false 就等于没这道过滤」仍然必须成立。
  for (const sc of ['external_tool', 'user_input', 'agent_authored', 'agent_inference', 'external_information']) {
    assert.equal(isExternalToolSkippable(ev(sc), false), false, sc + ' 在显式关闭下不该被剔除')
  }
})

test('P0-1 打开后：external_tool 被跳过（默认已打开）', () => {
  assert.equal(isExternalToolSkippable(ev('external_tool')), true)
  assert.equal(isExternalToolSkippable(ev('external_tool'), true), true)
})

test('P0-1 打开后：其它 sourceClass 一律不受影响', () => {
  for (const sc of ['user_input', 'user_explicit', 'user_correction', 'agent_authored', 'agent_inference', 'agent_self_evaluation', 'external_information']) {
    assert.equal(isExternalToolSkippable(ev(sc), true), false, sc + ' 不该被这道过滤碰到')
  }
})

test('P0-1 正交性：这道只管 sourceClass，不看 claimDomain', () => {
  // 既有那道（isConsolidationSkippable）判的是 agent_authored && experience。
  // 这道若也去看 domain，就会与它耦合 —— 明确钉住「只看 sourceClass」。
  assert.equal(isExternalToolSkippable(ev('external_tool', { claimDomain: 'user_fact' }), true), true)
  assert.equal(isExternalToolSkippable(ev('external_tool', { claimDomain: '' }), true), true)
  assert.equal(isExternalToolSkippable(ev('agent_authored', { claimDomain: 'experience' }), true), false, 'agent_authored+experience 由另一道管')
})

test('P0-1 健壮性：畸形输入不抛', () => {
  assert.equal(isExternalToolSkippable(null, true), false)
  assert.equal(isExternalToolSkippable(undefined, true), false)
  assert.equal(isExternalToolSkippable({}, true), false)
})
