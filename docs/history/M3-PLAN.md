> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — M3 v1 规划（M3-PLAN）

> 2026-08-28 起草。里程碑定义：Provider routing + guarded auto promotion + audit/export/rebuild。
> 工作方式延续：规划先行 → 决策点全部拍板 → 任务拆解 → 并行开发 → 合流回归 → dev 验证 → 文档同步。

## 1. 范围与目标

M3 v1 三大主题（DEVELOPMENT-PLAN 里程碑表）：

| 主题 | 目标 | 现状 | 差距 |
|---|---|---|---|
| **A. Provider routing** | 多记忆源召回 + LLM 任务路由 | 硬编码 memos 单 provider；consolidation 单 LLM 路由，无 fallback | 无 registry / 无路由表 / 无 fallback 链 / 无多源融合 |
| **B. Guarded auto promotion** | 带护栏的自动提升（personagent 式） | 仅 manual approval 门（reviewStatus 2 值） | 无 candidate 实体 / 无 policy 评估器 / 无 view / 无 rollback |
| **C. Audit / export / rebuild** | 全操作可审计 + 可导出 + 视图可重建 | export 仅 evidence 子集 JSON；无 audit；无 materialized view | 无 audit 表 / 无 JSONL 导出导入 / 无 rebuild 机制 |

铁律对齐：Evidence is truth；views are rebuildable；Learning does not imply promotion；
retrieval 不注入 = 唯一注入 authority 属于 Composer（provider 只供候选，不进 truth）。

## 2. 现状差距分析（源码核对 2026-08-28）

### A. Provider routing
- `providers/recall-contract.mjs`（23 行）：RecallProvider 契约 `{recall({text, limit}) → RecallCandidate[]}`，仅 MemOS 一个实现（`providers/memos.mjs` 78 行）
- `index.mjs` pre-step：`createMemosProvider({baseUrl})` 硬编码 → `hasProvider = memosEnabled` 布尔；providerScore 作为 semantic 分量（0.32 权重）
- LLM：仅 consolidation 一条路（`consolidationProvider + consolidationModel` 配置 → `buildLlmCall()` 闭包，withService 拿 llm 服务）；无 fallback；style 分类 / 未来 reflect 无独立路由
- Config 平铺：memosBaseUrl / memosEnabled / consolidationProvider / consolidationModel / consolidationMaxTokens / consolidationTimeoutMs

### B. Guarded auto promotion
- `expression.mjs`（109 行）：manual approval 门——consolidation 产出 style 候选 → 源证据标 `pending_promotion` → pre-step fire-and-forget 发 approval → `allowed-once`→promoted / `rejected`→dismissed（evidence.metadata.reviewStatus）
- REVIEW_STATUSES = ['promoted', 'dismissed']；无 proposed/rejected/superseded/rolled_back 五态、无 candidate 实体、无 policy floors（min_events/min_strong/age/scope）、无 classify_strength、无 decide() 可审计拒绝、无 materialized view、无 rollback
- EXPRESSION.md §2-7 已有 personagent 完整参考规格（状态机/floors/方向性/三重对齐）——M3 把它落地

### C. Audit / export / rebuild
- `service.export(scopeId, {includeNonActive})`：JSON 数组（evidence 字段子集）；exportActive 只 active
- 无 audit 表：状态迁移原因散落（supersedes 数组 / metadata.reviewStatus），无统一操作日志（谁/何时/何操作/原因）
- 无 materialized view：composer 每次 pre-step 实时算（M2 无缓存，故无"重建"需求；B3 引入 view 后重建成为必须）

## 3. 任务分解

### A1 Provider registry + 配置化（P0）
- 现状：memosBaseUrl/memosEnabled 平铺配置 + pre-step 硬编码
- 方案：`providers/registry.mjs`——recall provider 注册表：`{id, kind:'recall', enabled, timeoutMs, weight, create()}`；
  Config 支持 `recallProviders` 数组（兼容旧 memosBaseUrl/memosEnabled：缺失时默认构造 memos 项，向后兼容）
- 验收：yaml 配 2 个 recall provider → 都参与召回；禁用任一 → 另一正常；全部禁用 → hasProvider=false 走 M2 行为（回归）
- 测试：registry 单测（注册/解析/启用/权重）+ composer 集成（双 provider 候选合并）

### A2 LLM 任务路由 + fallback（P0）
- 现状：buildLlmCall 单路由（consolidationProvider/Model），无 fallback
- 方案：`providers/llm-router.mjs`——`{task: {provider, model, fallback?: [{provider, model}], timeoutMs, maxTokens}}`；
  `callFor(task, userText, system)`：主路由失败（网络/超时/空输出）→ 按 fallback 链依次尝试 → 全失败抛错（调用方决定降级）；
  兼容旧配置：consolidationProvider/Model 缺省映射到 task='consolidation'
- 验收：主 provider 故障（mock 抛错）→ fallback 生效；全失败 → consolidation 走规则兜底（现有行为）；purpose 枚举仍 'compaction'
- 测试：llm-router 单测（路由解析/fallback 链/全失败）+ consolidate 集成（沿用现有 mock）

### A3 多源 recall 分数融合（P0）
- 现状：hasProvider 布尔 → 0.32 semantic 权重切换；providerScore 单源
- 方案：RecallCandidate 增加 `sourceProvider`；compose 按 provider 分组加权（`providerWeight[providerId]` 配置，默认 1.0）；
  多源同 contentHash → 保留 utility 最高（复用 T2 dedup 逻辑）；归一化：providerScore 先除 max 再乘权重
- 验收：双 provider 排序正确（回归 composer 现有 18 测试）；单 provider 行为与 M2 一致
- 测试：composer 多源融合用例（同 hash 跨源合并 / 权重生效 / 归一化）

### B1 Candidate 生命周期（P1）——五态状态机 + schema v3
- 现状：evidence.metadata.reviewStatus（2 值），无候选实体
- 方案：`candidate` 表（schema v3 迁移）：
  `id / scope_id / domain / evidence_ids(JSON) / state(proposed|promoted|rejected|superseded|rolled_back) / policy(JSON, 评估快照) / decision_reason / created_at / updated_at`
  + `candidate_events`（append-only：candidate_id / ts / event / reason / actor）——状态 = 重放投影（restart 一致）
  与 M2 兼容：manual approval 门 → promoted 时写 candidate 行 + evidence.metadata.reviewStatus='promoted'（双向一致）
- 验收：五态迁移正确（含 supersede 候选替代、rollback）；重放投影与实时状态一致；M2 既有 approval 流程回归
- 测试：candidate store 单测（迁移/投影/事件）+ expression 集成（审批 → candidate 行）

### B2 Promotion policy 评估器（P1）——personagent floors 落地
- 现状：无
- 方案：`policy.mjs`：`evaluateCandidate(candidate, evidenceRows, ctx)` →
  - classifyStrength(authority)：user_correction/user_explicit → STRONG；single_observation → NEGATIVE_ONLY；
    agent_self_evaluation → WEAK（永不单独 promotion）；external_information → not eligible
  - floors（不可降，config 只允许更严）：min_events=2（floor）、min_strong=1、max_evidence_age_days=30、
    require_same_conversation=true、auto_promote（master switch，默认 **false**）
  - decide() 拒绝全部带 reason（对齐 EXPRESSION.md §7 拒绝路径清单）
- 验收：各拒绝路径单测（reason 完整可审计）；floor 尝试配置低于 2 → 强制 2；auto_promote=false → 全部留人工
- 测试：policy 单测（strength 映射/floors/方向性/age/会话约束/拒绝 reason）

### B3 Auto promote 执行 + materialized view + rollback（P1）
- 现状：无 view（composer 实时算）
- 方案：
  - consolidation 产出候选 → policy.evaluate → 达标且 auto_promote=true → promote（写 candidate 行 + reviewStatus 同步 + audit）
  - materialized view：promoted 候选 → `views/expression.json`（原子写 temp+rename）；pre-step 读 view 注入（不读 ledger）
  - rollback：`ctx.acp.rollback(candidateId)` → rolled_back（view 重写 + audit）
  - 未达标/auto_promote=false → 维持 M2 manual approval 路径（proposed + pending_promotion）
- 验收：promote 后 view 更新且 pre-step 注入生效；rollback 后立即失效；view 与 candidate ledger 重放一致（checksum）
- 测试：B3 集成（auto 路径/manual 路径共存/rollback/view 一致性）

### C1 Audit trail（P1）
- 现状：无统一审计
- 方案：`audit` 表：`id / ts / op(append|supersede|promote|dismiss|rollback|export|consolidate|rebuild|system) / target_id / scope_id / actor(agent|user|system|consolidation) / reason / payload(JSON)`
  写入点：ledger.append/supersede、expression 决策、consolidation 派生、export、rebuild
- 验收：关键操作都有 audit 行；audit 可查询（按 op/scope/actor）；导出含 audit
- 测试：audit store 单测（写入/查询/导出）+ 集成（append→audit 行）

### C2 Export 增强 + Import（P1）——顺带解决数据迁移遗留
- 现状：export 仅 evidence JSON 数组
- 方案：`export(scopeId, {format:'jsonl'|'json', streams:['evidence','observation','audit','candidate']})`；
  JSONL 每行一条记录；`importJsonl(path/stream)`：校验 + 幂等写入（contentHash 已存在 → skip；candidate/audit 原样）
- **附赠价值**：v0.1 数据迁移合并（.dsh\acp 47 条 + deepseek-harness\acp 20 条）直接用 export→import 完成（遗留待办消解）
- 验收：export→import 往返幂等（hash 对比）；两库合并后无重复（contentHash dedup）
- 测试：export/import 单测（格式/幂等/迁移场景模拟）

### C3 View rebuild（P1）——views are rebuildable 落地
- 现状：无 materialized view
- 方案：`ctx.acp.rebuild(viewName)` + 启动校验：view checksum 存 acp_meta；
  启动时对比 ledger/candidate 重放 checksum → 不一致自动重建（或告警+手动，配置）；
  view 列表：expression.json（B3 引入）；注入候选缓存（若未来引入）
- 验收：篡改 view 文件 → rebuild 恢复一致；checksum 校验单测
- 测试：rebuild 单测（重放一致性/checksum 失配恢复）

## 4. 待拍板决策点

| # | 决策点 | 选项 | 推荐 |
|---|---|---|---|
| 1 | **范围** | A=P0+P1 全做；B=只做 A1-A3+B2（policy 层） | A（延续 M2 决策 1A 全做） |
| 2 | **provider 配置形态** | A=recallProviders 数组（新配置）+ 旧配置兼容；B=保持平铺只加路由层 | A（可扩展，向后兼容） |
| 3 | **多源融合策略** | A=按 provider 权重归一化融合；B=优先级链（顺序取足）；C=保持现状不升级 | A（权重可调，回归可控） |
| 4 | **auto_promote 默认值** | A=默认 false（延续全人工，配置开启）；B=默认 true（保守 floors） | A（EXPRESSION.md §8 建议默认关） |
| 5 | **candidate 形态** | A=独立 candidate 表（schema v3）；B=证据 metadata 扩展 | A（可审计重放，五态清晰） |
| 6 | **audit 粒度** | A=状态迁移+审批+导出+重建（不含查询）；B=全操作含查询 | A（B 太重，查询审计无必要） |
| 7 | **export 格式** | A=JSONL（流式，导入友好）；B=JSON 单文件 | A（迁移场景直接受益） |
| 8 | **rebuild 触发** | A=启动校验+手动命令；B=启动校验+定时；C=仅手动 | A（启动自动兜底，手动可控） |
| 9 | **并行分组** | A=按主题 3 组（A1-3 / B1-3 / C1-3）；B=细拆 5-6 组 | 待范围拍板后定（预计 4 组：A1+A2 / A3 / B1+B2 / B3+C1 / C2+C3） |

## 5. 建议节奏## 5. 波次计划（2026-08-28 细化）

**第一波（3 组并行，文件零重叠）：**

| 组 | 任务 | 文件 | 分支 |
|---|---|---|---|
| 组A | A1+A2+A3 routing | providers/registry.mjs(新) providers/llm-router.mjs(新) providers/memos.mjs composer.mjs index.mjs(Config+pre-step) | feat/routing |
| 组B1 | B1 candidate+audit schema | store.mjs(schema v3) candidate.mjs(新) audit.mjs(新) | feat/candidate-schema |
| 组B2 | B2 policy | policy.mjs(新) | feat/policy |

**第二波（2 组并行，基于第一波合流后 master）：**

| 组 | 任务 | 文件 | 分支 |
|---|---|---|---|
| 组C | B3 auto promote+view | views.mjs(新) expression.mjs consolidate.mjs index.mjs(注入装配) | feat/auto-promote |
| 组D | C1+C2+C3 audit/export/rebuild | export-import.mjs(新) rebuild.mjs(新) service.mjs | feat/audit-export |

**收尾**：全量回归（122+ 新增测试）→ dev 集成验证 → C2 迁移实战（两库 67 条合一）→ 文档同步。

## 6. 接口契约（并行开发协议，2026-08-28 定稿）

### 6.1 B1 提供（组C/组D 依赖）

```js
// candidate.mjs —— candidate 表 + candidate_events 表（append-only，重放投影）
createCandidate({scopeId, domain, evidenceIds})           → {id, state:'proposed'}
transitionCandidate(id, event, {reason, actor})           → row  // event ∈ promote|reject|rollback|supersede
listCandidates({scopeId, state, limit})                   → rows
getCandidate(id)                                          → row
replayCandidates()                                        → Map<id, row>  // 从 events 重放

// audit.mjs —— audit 表
appendAudit({op, targetId, scopeId, actor, reason, payload}) → id
queryAudit({op, scopeId, actor, limit})                   → rows
```

- schema v3：新增 candidate / candidate_events / audit 三表（SCHEMA_VERSION 2→3 迁移）
- store 层写操作（append/supersede/observation upsert）内置 audit 行（actor='system'）
- 上层写操作（promote/dismiss/rollback/export/rebuild）由调用组显式 appendAudit

### 6.2 B2 提供（组C 依赖）

```js
// policy.mjs
evaluateCandidate({candidate, evidenceRows, config}) →
  {decision: 'promote'|'hold'|'reject', reason: string, policy: {...快照}}
classifyStrength(authority) → 'STRONG'|'NEGATIVE_ONLY'|'WEAK'|'not_eligible'
// floors: min_events=2(floor) min_strong=1 max_evidence_age_days=30
//         require_same_conversation=true auto_promote=false(master switch)
// 拒绝 reason 清单对齐 EXPRESSION.md §7（每拒绝必有 reason）
```

### 6.3 组A 内部

```js
// registry.mjs
createProviderRegistry({recallProviders, defaults}) → {
  listRecallProviders(),
  recallAll({text, limit}) → Promise<RecallCandidate[]>
  // 并行召回 + 各自超时 + fail-open（单 provider 故障不阻断）
}
// RecallCandidate 扩展：{id, content, providerScore, sourceProvider, sourceRef, observedAt, contentHash?}

// llm-router.mjs
createLlmRouter({tasks, resolveLlm}) → {
  callFor(task, userText, system) → Promise<string>
  // 主路由 → fallback 链依次尝试 → 全失败抛错（调用方决定降级）
}
// tasks: {[task]: {provider, model, fallback?: [{provider, model}], timeoutMs, maxTokens}}

// composer.mjs 扩展（A3）
compose(candidates, {hasProvider, providerWeights, ...})
// providerWeights: {[providerId]: number}，缺省 1.0；providerScore 归一化后乘权重
```

### 6.4 组C 内部

```js
// views.mjs —— materialized view（views are rebuildable）
createViews({dir, ledger, candidateStore}) → {
  readExpression() → rows | null,
  writeExpression(rows) → {path, checksum},   // 原子写 temp+rename
  verifyExpression() → {ok, checksum, mismatches}  // 与 candidate 重放对比
}
// expression.mjs 扩展：
//   manual 审批（allowed-once）→ candidate promote 行 + view 重写 + audit(actor='user')
//   autoPromote（policy 达标且 auto_promote=true）→ 同上但 actor='policy'
//   rollback(candidateId) → rolled_back + view 重写 + audit
// consolidate.mjs：style 候选产出后调 policy.evaluateCandidate → 达标自动 / 否则维持 pending_promotion
// index.mjs：pre-step 注入段读 views（不读 ledger）
```

### 6.5 组D 内部

```js
// export-import.mjs
exportJsonl({ledger, candidateStore, auditStore, streams}) → string
  // streams: ['evidence','observation','candidate','audit']，JSONL 每行一条
importJsonl(text, {ledger, candidateStore, auditStore}) → {inserted, skipped, errors}
  // evidence 按 contentHash 幂等（已有则 skip）；observation/candidate/audit 原样

// rebuild.mjs
rebuildView(viewName, deps) → {ok, checksum}
verifyView(viewName, deps) → {ok, checksum}   // 启动校验用

// service.mjs 扩展：
//   export(scopeId, {format:'jsonl'|'json', streams}) —— 保持现有 JSON 兼容
//   import(jsonlText) → 结果统计
//   audit({op, scopeId, limit}) → 查询
//   rebuild(viewName) → 手动重建
//   startupVerify() → 启动时 checksum 校验（不一致自动重建，配置开关）
```

### 6.6 并行纪律（沿用 M2 教训）

1. 每代理一个 feature 分支，只改自己清单内文件；共享文件（index.mjs/store.mjs/service.mjs）严格按波次隔离
2. 合并只由我执行（先各分支过测试 → 逐个 --no-ff 合并 → 全量回归）
3. 共享仓库禁止 git add -A（只 add 自己文件）
4. 接口契约冻结：组C/组D 按 6.1/6.2 契约开发，不自行改 B1/B2 API
## 执行进度（2026-08-28）

| 组 | 分支 | commit | 测试 | 状态 |
|---|---|---|---|---|
| 组B2 policy | feat/policy | 8fa729a | +39 | ✅ 合入 |
| 组B1 candidate/audit | feat/candidate-schema | 5c6ac7a | +21 | ✅ 合入 |
| 组A routing | feat/routing | 1916833 | +24 | ✅ 合入 |
| 组D audit/export/rebuild | feat/audit-export | cfabb12 | +22 | ✅ 合入 |
| 组C auto-promote | feat/auto-promote | 06810e2 | +28 | ✅ 合入（index.mjs 冲突手工解决） |

- 全量回归：master **253/0**
- 集成缺陷修复 1 个：apply 时 ledgerDir 兜底解析（M3 views 装配导致未配 ledgerDir 的 profile 启动失败）→ 6119a7e + dev profile 补显式 ledgerDir
- dev 集成验证通过：schema v3 迁移 / audit 内置写入 / startupRebuild 首次物化 + checksum / 证据摄入

---

## 决策记录