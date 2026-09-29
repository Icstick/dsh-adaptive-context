import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractQuotedSpans, quoteSupport, attachQuotes, planSedimentation, normalizeForMatch } from '../src/chapter.mjs'

test('extractQuotedSpans：只收成对引号里的整段', () => {
  assert.deepEqual(extractQuotedSpans('用户说「先做 4 再做 3」，然后同意了'), ['先做 4 再做 3'])
  assert.deepEqual(extractQuotedSpans('他说“不要提交代码”'), ['不要提交代码'])
  assert.deepEqual(extractQuotedSpans('「」太短不收'), [])
  assert.deepEqual(extractQuotedSpans('没有引号的转述'), [])
})

test('quoteSupport：逐字命中（容忍空白与全半角标点）', () => {
  const ev = ['报错了？我这边也不对，先回滚']
  assert.equal(quoteSupport('先回滚', ev).supported, true)
  assert.equal(quoteSupport('先回滚。', ev).supported, true, '句号差异不该影响')
  assert.equal(quoteSupport('完全没出现的话', ev).supported, false)
})

test('attachQuotes：没有引文的行标成转述，不当错误', () => {
  const ev = new Map([['ev1', { content: '继续吧' }], ['ev2', { content: '这个地方用「先出计划文档」的办法' }]])
  const out = attachQuotes([
    { id: 'o1', text: '用户要求「先出计划文档」', evidenceIds: ['ev2'] },
    { id: 'o2', text: '倾向先探索', evidenceIds: ['ev1'] },
    { id: 'o3', text: '外机导入的引用「查不到」', evidenceIds: [] },
  ], ev)
  assert.equal(out[0].transposed, false)
  assert.equal(out[0].quotes[0].supported, true)
  assert.equal(out[1].transposed, true, '纯转述：transposed=true，但不是错')
  assert.equal(out[2].quotes[0].supported, false, '核不到就是核不到，不猜')
})

test('planSedimentation：即将冷存、画像没接住的用户域条目才报', () => {
  const obs = [
    { id: 'a', text: '倾向先出计划文档', claimDomain: 'user_preference' },
    { id: 'b', text: '相当依赖本地环境与本地文件', claimDomain: 'user_fact' },
    { id: 'c', text: '某次跑批把 X 修好了', claimDomain: 'experience' },
    { id: 'd', text: '当下正在处理 A', claimDomain: 'user_preference' },
  ]
  const r = planSedimentation({
    observations: obs,
    archivalIds: ['a', 'b', 'c', 'd'],
    representedTexts: ['倾向先出计划文档'],
  })
  assert.equal(r.checked, 4)
  assert.deepEqual(r.missing.map((x) => x.id), ['b', 'd'], 'experience 不进画像因此不报；已接住的 a 不报')
})

test('normalizeForMatch：空白与标点不参与比较', () => {
  assert.equal(normalizeForMatch('先 做 4，再做 3。'), normalizeForMatch('先做4,再做3.'))
})