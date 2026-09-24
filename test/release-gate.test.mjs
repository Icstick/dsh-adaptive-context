// test/release-gate.test.mjs — 放行闸门（七类 + 三档）的判据验收
// 运行：node --test test/release-gate.test.mjs
// 判据来源：docs/plans/cloud-batch-2-20260923.md 任务 2（云端）+ 第一批抽样本机实测校准
//          （docs/ops/s3-batch1-release-20260922.md §3 的 4.2% 噪声）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gateVerdict, qualityVerdict, isEnglishOnly, stripNonProse, findAnchors,
  GATE_CONFIG, assertGateConfig,
} from '../src/release-gate.mjs'

const row = (over = {}) => ({ subject: '用户', predicate: '偏好', text: '偏好先出计划文档', ...over })
const d = (over) => gateVerdict(row(over)).decision
const cls = (over) => gateVerdict(row(over)).class

test('正常行一律 pass（判据不过度设计）', () => {
  assert.equal(d({ text: '偏好先准备候选清单再推进任务' }), 'pass')
  assert.equal(d({ text: 'B机使用ZOOT账户，平时用ZOOT，不太用worker，需装到web' }), 'pass')
  assert.equal(d({ text: '倾向将分支都合并到main，只保留main' }), 'pass')
  assert.equal(d({ text: '单位书写遵循 SI 规范：如 kHz 而非 KHz，us 写作 uS' }), 'pass')
  assert.equal(d({ text: '本机为 Windows，账户 zoot，网络走 ZeroTier 内网，另有 A、B 两台机器' }), 'pass')
})

test('① 英文残留：c<=3 且 l>=24 硬拦；中英混排不拦', () => {
  assert.equal(d({ text: 'The retry loop resets the backoff counter on every successful heartbeat.' }), 'hard_quarantine')
  // 本地校准点：这条夹着引号内的中文专名（c=2），云端 c==0 硬线会漏掉它
  assert.equal(cls({ text: 'User referred to the assistant as 姐姐 when asking for help.' }), 'english')
  assert.equal(d({ text: '把 semaphore 的 acquire 超时从 30s 调到 60s，因为 lock 竞争在 CI 上明显' }), 'pass')
  assert.equal(d({ text: 'pnpm' }), 'pass')
  assert.equal(isEnglishOnly('pnpm'), false)
  assert.equal(isEnglishOnly('用户 prefers A'), false)
  assert.equal(isEnglishOnly('User referred to the assistant as sister today'), true)
  // 行自带 source_locale != zh → 本类不适用
  assert.equal(d({ text: 'The retry loop resets the backoff counter on a heartbeat.', source_locale: 'en' }), 'pass')
})

test('② 自指：机器主语 / 对话产物；中文复合主语与外部动作不判', () => {
  assert.equal(cls({ subject: 'user-assistant address', text: '用户称呼助手为姐姐' }), 'selfref')
  assert.equal(cls({ text: '你刚才说的那个方案我同意，就这样做' }), 'selfref')
  // 回归（实测误杀样本）：中文复合主语指的是外部功能，不是「对话本身」
  assert.equal(d({ subject: 'session 列表', text: '希望 session 选择只显示用户发起的 session，并加上 session 标题' }), 'pass')
  assert.equal(d({ subject: 'session 处理', text: '处理 session 时经常重复做相同的事，可能需要沉淀相关知识或能力' }), 'pass')
  assert.equal(d({ subject: 'tool-calls 调度器改动', text: '0.1.6→0.1.7-alpha.2 的调度器改动使 2 个测试未通过。' }), 'pass')
  // 有外部动作动词 → 自指降为 soft（云端：外部动作 == 0 才强判）
  const withAction = gateVerdict({ subject: 'x', text: '你刚才说的那个方案的实现已经提交了' })
  assert.equal(withAction.hits[0].level, 'soft')
})

test('③ 会话临时态：S6 单族即硬；云端 S 族需 ≥2 族；锚点豁免降级', () => {
  assert.equal(d({ text: '用户同意继续当前任务' }), 'hard_quarantine')
  assert.equal(d({ text: 'MCP 已安装：MCP 已安装完成。' }), 'hard_quarantine')
  assert.equal(d({ text: '刚才那个报错应该是我改了 config 后才出现的，我先把它注释掉试试' }), 'hard_quarantine')
  // 云端反例：满是「之前/那个」但有 commit 锚点 + 完成态 → 放行
  // 云端反例原文写的是 6 位 a1b2c3；本实现按 git 惯例取 ≥7 位，故此处用 7 位
  assert.equal(d({ text: '之前那个 ECONNRESET 在生产出现，根因是连接池 max=5 太小，已把 max 调到 50（commit a1b2c3d）' }), 'pass')
  // 单族无锚点 → soft（进人工队列，不静默丢）
  assert.equal(d({ text: '用户计划稍后讨论 memory 是否保留' }), 'soft_tag')
  // 本机校准：S6 刻意不收「本次已」，避免误杀有效工作事实
  assert.equal(d({ text: '复制 systemd unit 并修改 WORKER_ID 即可；本次已确认扩容到 4 个 cloud worker' }), 'soft_tag')
  // 锚点豁免：hard 降 soft
  assert.equal(gateVerdict({ text: '用户同意继续当前任务（见 commit a1b2c3d）' }).hits[0].level, 'soft')
})

test('④ 环境绑定：用户目录 / 本机回环；共享网段与工作区盘符不算', () => {
  assert.equal(cls({ text: '在 /home/ubuntu/.dsh 下有缓存 blobs，直接删了就行' }), 'env-bound')
  assert.equal(cls({ text: '用户给出的本地地址为 127.0.0.1:16384。' }), 'env-bound')
  // 回归：ZeroTier 地址是三机共享（s3 第一批 §2 拿它当放行效果证据）
  assert.equal(d({ text: 'W 笔记本 ZeroTier IP 10.173.250.47；B 机 10.173.250.80' }), 'pass')
  // 回归：D:\\DSH_workspace 是三机共识路径；斜杠枚举更不是路径
  assert.equal(d({ text: '产物统一落 D:\\DSH_workspace\\reference\\ate-corpus\\。' }), 'pass')
  assert.equal(d({ text: '@@BOOKING和.sd为S100/V50格式；Adaptstar包含Qstar/Hstar/Astar/Dstar' }), 'pass')
  assert.equal(d({ text: 'S100/V50 也使用 prj/prg/tim/lvl 等后缀名，可能与已有结论交叉污染' }), 'pass')
  // 绝对路径仍进 tags（人工该看一眼），但不改判
  assert.equal(gateVerdict({ text: '产物统一落 D:\\DSH_workspace\\reference\\ate-corpus\\。' }).tags.includes('abs-path?'), true)
})

test('⑤ 一次性路径：临时产物硬拦；只谈 /tmp 语义不拦', () => {
  assert.equal(cls({ text: '跑完后 /tmp/dsh-7f3a91/out.json 就是结果' }), 'one-shot-path')
  assert.equal(d({ text: '/tmp 在各平台语义不同：Linux 重启清空，macOS 按 TMPDIR 每用户隔离' }), 'pass')
})

test('⑥ 过期版本：版本号 + 时效断言；兼容下界与版本陈述不拦', () => {
  assert.equal(cls({ text: '目前 pnpm 最新是 9.1.0，用这个就行' }), 'stale-version')
  assert.equal(d({ text: '兼容 Node >=22.19' }), 'pass')
  // 回归（实测误杀样本）：「当前版本为 X」是版本陈述，不是时效断言
  assert.equal(d({ text: 'dsh-usage-card 当前版本为 0.13.0，需要升级' }), 'pass')
})

test('⑦ 纯情绪：短且无实词才拦；带因果修复不拦', () => {
  assert.equal(cls({ text: '终于跑通了，太爽了！' }), 'empty-emotion')
  assert.equal(d({ text: '终于跑通了：问题是 migrate 前没加 BEGIN，加事务后 SQLITE_BUSY 消失' }), 'pass')
})

test('归一前置：代码块 / URL 被剥离，不参与自然语言判定；锚点单独留存', () => {
  const s = stripNonProse('修好了\n\u0060\u0060\u0060js\nconst a = 1\n\u0060\u0060\u0060\n见 https://example.com/x')
  assert.equal(s.body.includes('const a'), false)
  assert.equal(s.body.includes('https://'), false)
  assert.equal(s.spans.length, 2)
  assert.equal(findAnchors('见 https://example.com/x').some((a) => a.kind === 'url'), true)
  // 整条只有代码块 → 归一后主体为空 → 英文类不会误判
  assert.equal(d({ text: '\u0060\u0060\u0060\nconst theQuickBrownFoxJumpsOverLazyDog = 1\n\u0060\u0060\u0060' }), 'pass')
})

test('阈值皆配置：注入 cfg 即改变判定；坏配置早失败', () => {
  const strict = { ...GATE_CONFIG, english: { ...GATE_CONFIG.english, hardMinLatin: 2, hardMaxCjk: 0 } }
  assert.equal(gateVerdict({ text: 'pnpm run build' }, strict).class, 'english')
  assert.equal(gateVerdict({ text: 'pnpm run build' }).class, null)
  const off = { ...GATE_CONFIG, disabled: ['english'] }
  assert.equal(gateVerdict({ text: 'The retry loop resets the backoff counter on every heartbeat.' }, off).decision, 'pass')
  assert.throws(() => assertGateConfig({ ...GATE_CONFIG, english: { ...GATE_CONFIG.english, hardMinLatin: -1 } }))
  assert.throws(() => assertGateConfig({ ...GATE_CONFIG, envBound: { decision: 'drop' } }))
})

test('不静默丢弃：soft / hard 都带类名·证据片段·置信度，只有 pass 无类', () => {
  const soft = gateVerdict({ text: '用户计划稍后讨论 memory 是否保留' })
  assert.equal(soft.decision, 'soft_tag')
  assert.equal(soft.class, 'ephemeral')
  assert.equal(soft.evidence_span.length > 0, true)
  assert.equal(soft.confidence > 0, true)
  const pass = gateVerdict({ text: '偏好先准备候选清单再推进任务' })
  assert.equal(pass.decision, 'pass')
  assert.equal(pass.class, null)
})

test('兼容层：旧 qualityVerdict 三名仍可用（旧导入路径不变）', () => {
  assert.equal(qualityVerdict(row()), null)
  assert.equal(qualityVerdict(row({ text: '用户同意继续当前任务' })), 'ephemeral')
  assert.equal(qualityVerdict(row({ subject: 'user-assistant address' })), 'selfref-subject')
  assert.equal(qualityVerdict(row({ subject: 'approval', text: 'User changed the approval policy from ask to never' })), 'english-only')
})

test('误杀回归：第一批已放行的真实好行，新闸门一律 pass', () => {
  const released = [
    '偏好先准备候选清单再推进任务',
    '倾向先处理简单任务，并优先梳理 hermes_dev',
    '希望无需逐步确认，可自主推进任务',
    '倾向并行推进设计文稿，可尝试 Agent Team，并希望尽量推进设计阶段',
    '倾向采用push+pull的同步方式',
    '提交代码时倾向拆分为多个 commit 分别提交',
    '希望需要确认的内容通过提问方式征询',
    '只操作自有仓库，不操作他人分支或 fork',
    '倾向先完成报告导出，再打磨视觉外观',
    '希望 memOS 可摘除，dreaming 尽量放云端完成',
    '偏好分阶段运行任务，认为一次性跑太久',
  ]
  for (const t of released) {
    const v = gateVerdict({ subject: '用户', text: t })
    assert.equal(v.decision, 'pass', t + ' → ' + JSON.stringify(v.hits))
  }
})
