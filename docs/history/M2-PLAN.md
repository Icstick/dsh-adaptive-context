> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# M2 v0.1 — 技术拆解与并行方案（规划稿）

> 2026-08-27。范围已拍板：**方案 A**（P0 全 + P1 全）。
> 本文拆解 6 项任务的技术点、验收 oracle、依赖与并行边界；
> 决策点 2-5 未拍板前不写代码。开发环境验证 = dev 实例（3081/18802）+ 仓库单测。

## 1. 任务拆解总表

| ID | 任务 | 涉及文件 | 可并行组 | 状态 |
|---|---|---|---|---|
| T1 | 自注入回声修复（P0-1） | composer.mjs + test/composer | 组 A | 待讨论细节后开工 |
| T2 | 内容级 dedup（P0-2） | composer.mjs + test/composer | 组 A（同 T1） | 待开工 |
| T3 | memos-provider 接入（P0-3） | index.mjs + providers/memos.mjs + test | 组 B | 待开工 |
| T4 | Background consolidation（P1-4） | 新 consolidate.mjs + store schema v2 + index.mjs turn/end + LLM 接入 + test | 组 C | 依赖决策点 2/3 |
| T5 | Temporal truth（P1-5） | store/service/composer 贯通 + test | 组 D | 依赖决策点 4 |
| T6 | Expression promotion（P1-6） | 新命令 + promotion 状态机 + test | 组 E | 依赖决策点 5 |

## 2. 各任务技术点

### T1 自注入回声（P0-1）
- 现状：inbox/spliced 摄入发生在 pre-step 之前，composer 拉全量 active 时把当前消息自己注入回去
- 方案：pre-step 过滤 content 与当前 userText 全等（或互为子串）的候选；再按 observedAt 排除最近 90s 内且 sourceRef 前缀等于当前 sessionId 的候选
- 验收：注入列表不再出现当前 turn 的用户消息；历史消息正常注入
- 测试：composer 单测（构造 3 条候选：当前消息/近期同 session/历史）

### T2 内容级 dedup（P0-2）
- 现状：compose 只按 id 去重；benchmark 3 连重复内容全注入
- 方案：dedup 段加 contentHash 去重（store 候选有 contentHash；provider 候选现场 hashHex(content)）；同 hash 保留 utility 最高
- 验收：3 条同 content 候选 → 注入 1 条，telemetry.dropped 有 2 条 duplicate-content
- 测试：composer 单测

### T3 memos-provider 接入（P0-3）
- 现状：composer hasProvider 恒 false，semantic 分闲置；providers/memos.mjs 已实现（3s 超时 fail-open）
- 方案：index.mjs pre-step 构造 provider（createMemosProvider，baseUrl 默认 18801 可配置）→ await recall(query=userText) → 归一化 RecallCandidate（providerScore）→ compose([...ledger 候选, ...provider 候选], hasProvider=true)
- 验收：dev 实例 MemOS 有数据时 telemetry 显示 provider 候选参与排序；MemOS 关闭时 fail-open 不阻断 turn
- 测试：providers.test 已有 5 项；新增 compose 集成测试（provider 候选路径）
- 配置：Config 加 memosBaseUrl/memosEnabled（默认启用）

### T4 Background consolidation（P1-4）——最大项
- turn/end hook：入 per-scope serial queue（MVP 单全局队列）；不阻塞下一轮（fire-and-forget + 队列背压上限）
- 派生：从未消化 active 证据（observedAt > 上次 consolidation 水位）批量 LLM 提取 Observation：subject/predicate/claimDomain + text ≤500 + evidenceIds 引用
- LLM 来源：ACP inject ['llm']（DSH LLM 服务），route 走 memos host-llm 同款 prepareCall 模式（参考 dist/adapters/deepseek-harness/host-llm.js）
- 存储：observation 表（schema v2 + 迁移），键 = subject|predicate|claimDomain；冲突时新 Observation supersedes 旧的（挂 evidenceIds）
- 节流：默认每 N turn 或 evidence 积压 ≥ K 条才跑（N/K 可配置）——决策点 2
- 失败：LLM 失败静默重试上限后跳过，不阻塞
- 验收：dev 会话多轮后 observation 表有派生条目；热路径延迟不受影响（turn 不等 consolidation）

### T5 Temporal truth（P1-5）
- 现状：store.query/readGuard 已支持 validAt；service.recall 已透传；缺口在 compose/pre-step 不传 validAt + 无双视图暴露
- 方案：compose 透传 validAt（默认 now）；ctx.acp 暴露 history(id)（getLineage 已有）与 recall(validAt=过去) 双视图；pre-step 的注入候选默认 now 视图
- 验收：superseded 证据在 validAt=旧时点可召回、now 视图不可召回；lineage 完整
- 测试：service/read-guard 补 temporal 双视图用例

### T6 Expression manual promotion（P1-6）
- 目标：style/expression 证据的 candidate→confirmed 手动路径（用户确认才提升为表达风格权威）
- 形态：决策点 5 未拍——/checkpoint 式命令（/acp promote <id>）vs approval/request 面板
- 状态机：promote(evidenceId, {confirmed}) → metadata.reviewStatus 迁移；confirmed style 证据进 expression section（sectionOf 已有映射）
- 验收：用户可对候选 style 证据手动确认/驳回；驳回后不再进 expression section

## 3. 待拍板决策点（2-5）

**决策点 2（consolidation 节流）**：
- 选项 A：每 turn 跑（简单，贵——每 turn 1 次 LLM 派生调用）
- 选项 B：积压触发——未消化证据 ≥ 10 条 或 距上次 ≥ 5 turn（推荐：热路径零成本，批处理摊薄 prompt 成本）
- 选项 C：完全手动触发（/checkpoint consolidate）——零自动成本，但闭环不自动

**决策点 3（Observation 键生成）**：
- 选项 A：LLM 提 subject/predicate（prompt 强制输出 JSON + schema 校验；失败重试 1 次后丢弃该批）
- 选项 B：规则提（用户消息首句做 subject + 动词模板）——确定性但粗糙
- 推荐 A + 确定性 fallback：LLM 为主，规则兜底保证不空转

**决策点 4（temporal 接口语义）**：
- 选项 A：recall(q, {validAt})——validAt 缺省 now；superseded 证据仅在显式 allowSuperseded 时可见（现状 readGuard 语义，推荐：最小改动）
- 选项 B：新增 dedicated history API（更清晰但接口面更大）

**决策点 5（Expression 交互形态）**：
- 选项 A：命令式 /acp promote <id> | /acp dismiss <id>（复用 work-continuity 已验证的 commands+withService 模式，推荐）
- 选项 B：approval/request 面板（memento 风格审批门，正式但工程量×2）

## 4. 并行方案（flash 子代理）

- 组 A（T1+T2）：composer.mjs 单文件——1 个代理
- 组 B（T3）：index.mjs + providers——1 个代理（与 A 不同文件，可并行；接口契约：compose(rawCandidates, {hasProvider, ...}) 不变）
- 组 C（T4）：consolidation 全栈——1 个代理（最大，需要先拍决策点 2/3 + 读 CONSOLIDATION.md）
- 组 D（T5）：temporal 贯通——1 个代理（小）
- 组 E（T6）：expression——1 个代理（需要先拍决策点 5）

并行纪律（沿用已踩坑教训）：
1. 每代理一个 feature 分支（feat/ 或 fix/ 前缀），只改自己清单内文件
2. 合并只由我执行（先各自分支过测试 → 逐个 fast-forward 合并到 master → 全量回归）
3. 共享仓库禁止子代理 git add -A（只 add 自己文件）
4. dev 环境验证在合并后统一做（并行期间只跑仓库单测）

## 5. 建议节奏

先拍决策点 2-5（本讨论）→ 拍完起 5 个并行子代理 → 合流回归 → dev 环境集成验证 → 文档同步 + 提交。

---

## 决策记录（2026-08-27 已拍板）

| 决策点 | 拍板 | 备注 |
|---|---|---|
| 1 范围 | **A**（P0 全 + P1 全） | 用户原话：直接上A吧 |
| 2 节流 | **B**（积压触发：未消化 ≥10 条或距上次 ≥5 turn） | N=10/K=5 可配置 |
| 3 键生成 | **A**（LLM 主 + 规则兜底） | LLM 失败重试 1 次后丢弃该批 |
| 4 temporal | **A**（recall(q,{validAt})，缺省 now） | 最小改动 |
| 5 Expression | **B**（approval/request 审批门） | memento 风格；ACP inject 加 'approval'；候选 style 证据生成审批请求，用户面板确认/驳回 → reviewStatus 迁移 |

决策点 5B 补充设计：
- 触发：consolidation 产出 style 域候选（或用户对某 style 证据发起 promote）时生成 approval/request
- 审批 payload：证据内容 + source 溯源 + promote/dismiss 选项（对齐 memento makeCommandGate 的 approval 用法）
- 通过：reviewStatus=promoted → 进 expression section；驳回：reviewStatus=dismissed → 永不自动进
- 审计：审批结果落 evidence.metadata.reviewStatus（可导出审计）

---

## 执行进度（2026-08-27）

| 任务 | 分支 | commit | 状态 |
|---|---|---|---|
| T1+T2 自注入回声+dedup | feat/echo-dedup | 74301d5 | ✅ 合入 master |
| T3 memos-provider | feat/memos-provider | 43d708c | ✅ 合入 master |
| T5 temporal | feat/temporal | 1566ea8 | ✅ 合入 master（测试 query 适配 self-echo） |
| T6 expression 审批门 | feat/expression-approval | a5cdc8f | ✅ 合入 master（inject 断言适配） |
| T4 consolidation | feat/consolidation | f7ea70a | ✅ 合入 master（index.mjs 冲突手工合并） |

- 合并方式：5 worktree 并行（flash 模型）+ --no-ff merge + 手动解决 2 处测试语义冲突
- 全量测试：master **119/0**
- 修复 1 个集成缺陷：llm.stream 的 purpose 用了非法值 'acp-consolidation'（GenerateOptions
  联合类型只有 compaction|session-title）→ 'compaction'（e939343）
- dev 集成验证进行中：self-echo 生效已确认；consolidation 触发观察中（observation 表产出）

### 追加进度（2026-08-27 晚）

- 审批门契约修正（b5981dc，122/0）：ApprovalRequest.agent 必填 / outcome allowed-once /
  pending 标记 + pre-step fire-and-forget 触发；dev 全链路验证通过（approval/asked 事件出现）
- 正式实例升级 M2（consolidation 配置生效）
- 修复 cordis patch 同 id 覆盖（ledgerDir 丢失）→ 合并单块
- 遗留：dev UI 审批响应确认；数据迁移（两库合并）；LLM style 分类噪声优化
