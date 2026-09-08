> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 开发经验与关键注意点（Lessons）

> 2026-08-27。M1+M2 开发全程踩坑与关键注意点汇总（持续更新）。
> 这些不是设计文档，是「别让下一个人再踩一遍」的清单。

## 1. DSH 插件 seam 契约（unit test 测不出来的真实契约）

| # | 坑 | 症状 | 正解 |
|---|---|---|---|
| 1 | Config 用普通对象 | 启动失败 | Schemastery z.object |
| 2 | pre-step 返回 undefined | turn 崩（undefined.kind） | 返回 {kind:'reject'} 或 {kind:'enter',messages}；先 await next() |
| 3 | session/event 签名写错 | 永不摄入 | (session, event) 两参数 |
| 4 | 事件类型臆想 | 永不摄入 | 真实类型 agent/inbox/spliced（data.inserted[]）、turn/* |
| 5 | ctx.session / proxy 隐式访问 | cannot get property without inject | 只许 ctx.get('服务名')；不 JSON.stringify proxy |
| 6 | apply 时一次性 ctx.get('commands') | 命令从未注册 | withService 模式（订阅 internal/service 等就绪） |
| 7 | 注入消息乱造 | 显示/语义错乱 | createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin,form}}) |

## 2. LLM 调用

- llm.stream 的 GenerateOptions.purpose 是联合类型：**只有 compaction | session-title**；
  自定义值（如 acp-consolidation）会静默失败——水位更新但 0 产出、日志无输出，极难定位
- 参考实现：packages/session/session-title-llm/src/index.ts（BlockAssembler 流式收集 + finishError 检查）
- sessionId 可选（Branded SessionId）；辅助调用 purpose 选 compaction

## 3. 环境与路径

- **DSH_HOME 不可靠**：用户手动重启时不设环境变量 → 插件 process.env.DSH_HOME 落 cwd 相对路径；
  治本 = 插件 Config 暴露路径字段 + profile cordis.patch.yml 写死绝对路径
- **免停服挂插件**：profile package.json 加 link 依赖 + node_modules 手动 New-Item Junction 指向源码 + dump-config 预验证 + 重启
- pnpm install 被运行中 DSH 的 better-sqlite3 DLL 锁（EPERM rename）——junction 法绕过
- transformers.js 模型缓存（MemOS embedder）会被 pnpm install 清掉：稳定库 acp-assets/minilm + 复制到 .cache/Xenova/all-MiniLM-L6-v2/

## 4. 并行开发模式（worktree + flash 子代理）

- 共享工作树并发 git checkout 会互踩 → **每代理一个 git worktree**（wt-x + feature 分支）
- worktree 无 node_modules（git 不跟踪）→ 主库 pnpm install 后 junction 共享
- workflow 工具并行 agent 有 **600s 墙钟**；大项（consolidation 级别）拆 subagent 后台跑
- flash 指定：agent(prompt, {provider: deepseek-official, model: deepseek-v4-flash})
- 子代理任务书模板：COMMON（背景/坑清单/git 纪律）+ TASK（文件白名单/验收 oracle/完成标准）
- 合并按文件冲突图排序；改同文件的组先后合；测试语义冲突（如 self-echo 与短 query）手动校准

## 5. Windows/bat/沙箱小坑

- bat 必须纯 ASCII（UTF-8 中文注释被 cmd 按 GBK 解析会乱码截行，schtasks 静默失败元凶之一）
- bat 后台运行报 Input redirection is not supported → 改用 pwsh 直接 node 启动
- schtasks 一次性任务不可靠（/ST 过去时间 /Run 不执行；未来时间到点也可能不触发）→ 关键重启让用户手动
- EADDRINUSE 处理：Get-NetTCPConnection 按端口找 PID → taskkill /F /T
- 测试跑法：node test/x.test.mjs 单文件直跑（node --test runner 被沙箱拦）

## 6. 设计语义注意点

- self-echo 过滤（content 与 query 全等或 content 包含 query）对**短 query** 会误伤包含它的历史证据；
  真实用法 query 是完整用户消息（长句）影响有限，但测试与工具调用要写真实长度 query
- supersedes 方向 = 方案甲：新行 supersedes=[旧id]、旧行 state=superseded（CONTRACTS.md §8）
- 决策 5B（审批门）优于命令式：promotion 是可审计的用户决策，走 approval/request
- fail-open 是铁律：ACP 任何故障不得阻断 turn（每次 hook 都 try/catch + 合法默认返回）

## 7. cordis patch 与 approval 契约（2026-08-27 集成验证追加）

- **cordis.patch.yml 同 id 多 entry = 后者整体覆盖（不是合并）**：adaptive-context 写了
  ledgerDir 块 + consolidation 块 → 后者吞掉前者，ledgerDir 丢失、数据落 cwd。
  同一插件的所有字段必须放同一块；用 dump-config 核对目标插件完整 config。
- **DSH approval 契约**：ApprovalRequest {agent 必填, toolName, callId?, reason?, signal?}；
  outcome = 'allowed-once'（唯一通过）| 'rejected' | 'cancelled' | 'unavailable'。
  后台任务（consolidation）无 agent → 标 pending_promotion，下个 turn 的 pre-step
  （payload.agent）fire-and-forget 发 approval.request（不阻塞 turn）；
  请求发出后会话 events 出现 approval/asked。
- **consolidation prompt 判别引导**：LLM 默认把表达风格偏好标 user_preference；
  prompt 需显式给 style 域判别示例（语气/格式/呈现方式 → style；实质偏好 → user_preference）。
## 8. M3 并行波次与契约冻结（2026-08-28）

- **两波五组**：wave1（routing / candidate-schema / policy）文件零重叠并行；wave2（auto-promote / audit-export）基于合流后 master 再起，天然规避 index.mjs 等共享文件并行冲突
- **跨组接口契约**（M3-PLAN §6）先定稿再开发：组C/组D 按冻结契约消费 B1/B2 的 API；B1 对契约的偏离（candidate_events 多 payload 列、listCandidates 返回数组）必须显式声明
- 同文件跨波次改（index.mjs）→ 顺序合并 + 手工解决（Config 段 / apply 装配段两处冲突）
- **CRLF 坑（git 冲突手工解决时）**：Windows 文件 `\r\n`，用 `String.replace(old, new)` 的 old 字符串按 `\n` 写会**静默不匹配**（冲突标记原样残留，SyntaxError）→ 必须按行 `split(/\r?\n/)` 处理
- 集成缺陷在合流后暴露：M3 的 views 装配 `path.join(config.ledgerDir, 'views')` 无兜底 → 未配 ledgerDir 的 profile（dev）启动崩溃（M2 代码的 DSH_HOME 兜底掩盖了问题）→ 治本 = apply 开头统一 ledgerDir 兜底解析 + dev profile 补显式路径

## 9. 测试隔离铁律（2026-08-28 重大事故）

- **`openEvidenceLedger({ dir2 })` 参数名笔误**（应为 `{ dir: dir2 }`）→ `opts.dir` undefined → 静默回退 `path.join(DSH_HOME,'acp')` = **正式库**！测试反复往正式库写垃圾 candidate（13 条）
- 侥幸通过原因：正式实例重启前无 view meta → verify "view not built" 通过；**用户重启后 meta 物化才暴露断言失败**
- 铁律：①测试临时库必须显式 `{dir: mkdtemp}`，怀疑时 `PRAGMA database_list` 校验实际路径；②**断言侥幸通过 ≠ 正确**，环境变化（重启/迁移）会揭穿隐藏 bug；③事故处理：确认污染范围 → 参数化 SQL 清理 → 修复测试 → 全量回归 + 复查生产库
- 数据迁移实战：export-import 幂等合并验证通过（残留库 20 → 正式库 90：导入 11 / 幂等跳过 9 / 0 错误），残留库先备份

## 10. 发布（M4，2026-08-28）

- 发布三件套：LICENSE（MIT，Copyright 用户署名）+ ACKNOWLEDGMENTS（致谢参考项目含许可）+ README（背景 + 小故事示例 + 中文优先 + 去 AI 味——用户明确要求，用 humanizer skill 加工）
- **gh repo create --source --push 的坑**：origin 被设为 HTTPS + gh 临时凭据桥；后续 `git push`（tag）无 credential helper → `Invalid username or token` → 立即 `git remote set-url origin git@github.com:<user>/<repo>.git` 切 SSH
- 冒烟验收 = 全新 clone + pnpm install + 测试通过
