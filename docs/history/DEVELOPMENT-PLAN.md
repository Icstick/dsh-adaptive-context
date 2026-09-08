> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 开发计划（Development Plan）

> 2026-08-25。规划定稿后的实施路线：里程碑、任务分解、顺序与验收。
> 工程量估算来自审计报告（MVP 2.5–4 人月；Agent 主导可压缩）。

## 1. 里程碑总览

| 里程碑 | 目标 | 估算 | 依赖 |
|---|---|---|---|
| **M0 脚手架** | monorepo 骨架 + 两插件基础结构 + CI 就绪 | 0.5–1 周 | 无 |
| **M1 MVP** | Evidence Ledger + Governance + Context Composer + User Model explicit + /checkpoint + MemOS 实验接入 | 2.5–4 人月 | M0 |
| **M2 v0.1** | Background consolidation + temporal truth + Expression manual + Work checkpoints | 3–4 人月 | M1 |
| **M3 v1** | Provider routing + guarded auto promotion + audit/export/rebuild | 4–6 人月 | M2 |
| **M4 发布准备（临时）** | 即插即用 + 拔除无污染 + 可回溯 + GitHub 发布（两插件） | 0.5 周（Agent 主导可压缩至半天） | M3 |


## 1.5 当前进度（2026-08-27）

```text
M0 脚手架            ✅ 完成
M1 MVP               ✅ 完成（84 测试；正式 web profile 集成实测全通）
M2 v0.1:
  T1+T2 self-echo 过滤 + 内容 dedup     ✅ feat/echo-dedup 合入
  T3 memos-provider（hasProvider 语义） ✅ feat/memos-provider 合入
  T4 background consolidation           ✅ feat/consolidation 合入（dev 实测 5 条 observation）
  T5 temporal truth 双视图              ✅ feat/temporal 合入
  T6 expression approval 审批门        ✅ feat/expression-approval 合入（style 候选触发待观察）
```

**累计测试：253/253 通过**（M3 合流后全量）
**M3 完成判定：2026-08-28**——九任务两波并行合流 + dev 集成验证（schema v3 迁移/审计/startupRebuild 首次物化全通过）
**M2 完成判定：2026-08-27**——六任务合入 master + 审批门契约修正（@b5981dc，122/0）+ dev 全链路验证
（self-echo 生效、consolidation LLM 派生闭环、purpose 枚举修复）。
执行方式：5 worktree 并行 flash 子代理 → 逐个 --no-ff 合流 → 119/0 回归 → dev 验证。

### M2 任务分解（v0.1，决策记录见 M2-PLAN.md）

| # | 任务 | 分支 | 验收 |
|---|---|---|---|
| T1 | self-echo：compose 排除当前消息（content 与 query 全等/包含） | feat/echo-dedup | 注入无当前消息（dev 实测 ✓） |
| T2 | contentHash 内容级 dedup（保留 utility 最高） | feat/echo-dedup | 3 重复 → 1 条 + dropped 记录 |
| T3 | MemOS provider 接入（normalizeMemosHits + hasProvider） | feat/memos-provider | providerScore 参与排序 + fail-open |
| T4 | consolidation：串行队列/节流（≥10 证据或 ≥5 turn）/LLM 派生+规则兜底/observation 表 v2 | feat/consolidation | dev 实测 5 条 observation 产出 |
| T5 | temporal：recall allowSuperseded 双视图 + history lineage | feat/temporal | 旧时点可召回、now 不可召回 |
| T6 | expression：approval 审批门（requestPromotion 桥 + reviewStatus 迁移） | feat/expression-approval | mock approval 回调迁移正确 |

### M3 任务分解（v1，决策记录见 M3-PLAN.md，2026-08-28 完成）

| # | 任务 | 分支 | 验收 |
|---|---|---|---|
| A1 | Provider registry（recallProviders 配置化 + 旧配置兼容） | feat/routing | registry 单测 + fail-open |
| A2 | LLM 任务路由 + fallback 链 | feat/routing | 主路由故障 → fallback 生效 |
| A3 | 多源 recall 分数融合（providerWeights 归一化） | feat/routing | 双 provider 排序正确 |
| B1 | Candidate 五态 + audit schema v3（事件重放） | feat/candidate-schema | 重放投影一致 + 迁移 v2→v3 |
| B2 | Promotion policy 评估器（floors 不可降） | feat/policy | 拒绝路径 reason 完整 |
| B3 | Guarded auto promotion + materialized view + rollback | feat/auto-promote | auto/manual 双路径 + view 一致性 |
| C1 | Audit trail（op/actor/reason/payload） | feat/audit-export | 关键操作留痕 |
| C2 | JSONL export/import（幂等） | feat/audit-export | 往返字节幂等 |
| C3 | View rebuild + checksum 启动校验 | feat/audit-export | 篡改恢复 + dev 首次物化实测 |

执行方式：两波五组并行（wave1: A/B1/B2 → wave2: C/D）→ 合流回归（253/0）→ dev 集成验证（ledgerDir 兜底修复 6119a7e）。


## 2. 任务分解（M1 MVP）

### 2.1 Evidence Ledger（feature/evidence-ledger）★ 先行

| # | 任务 | 验收 Oracle |
|---|---|---|
| 1 | store.mjs 返工：按定稿 schema（7 值 authority、metadata 键集、supersedes 语义） | 现有 10 测试全过 + 新增 metadata 键集测试 |
| 2 | extract.mjs：SessionEvent → Evidence 规范化（sourceClass→authority 确定性映射） | 幂等：同事件重放 3 次 = 1 条 |
| 3 | lifecycle.mjs：state 迁移（supersede/quarantine/redact/rollback）+ getLineage | supersede 后历史可回溯 |
| 4 | governance.mjs 强化：assertAuthorityConsistent 接入 append | external_tool+user_explicit 拒绝 |
| 5 | 契约测试集 test/conformance/ | 全部 KPI 可验证 |

### 2.2 Context Composer（feature/context-composer）

| # | 任务 | 验收 Oracle |
|---|---|---|
| 6 | budget.mjs：section quota + telemetry | 输出 retrieved/admitted/dropped |
| 7 | composer.mjs：资格判定→排序→token 打包 | p95 ≤ 900 tokens/step |
| 8 | pre-step 注入（plugin message + untrusted 标记） | fail-open：异常不阻断 turn |

### 2.3 Governance 强化（feature/governance）

| # | 任务 | 验收 Oracle |
|---|---|---|
| 9 | Read Guard 按资格矩阵落地 | quarantine 永不注入 |
| 10 | 用户权利：inspect/export/correct/release/redact/delete | export 后可重建 |

### 2.4 Work Continuity（feature/work-continuity）

| # | 任务 | 验收 Oracle |
|---|---|---|
| 11 | /checkpoint 命令：goal/decisions/next/artifacts 持久化 | 新会话恢复 WorkState |
| 12 | 与 ctx.acp 共享 Ledger（work 域） | Case E 可恢复 |

### 2.5 MemOS 实验接入（feature/memos-provider）

| # | 任务 | 验收 Oracle |
|---|---|---|
| 13 | 最小 RecallProvider adapter（recall + AbortSignal） | MemOS 在线时 semantic 分可用 |
| 14 | 关闭 MemOS 自动注入（唯一注入 authority 属 Composer） | 无双注入 |
| 15 | Benchmark A/B/F/G 4 case 跑通并归档 | docs/benchmark-results/ |

## 3. 任务顺序与依赖

```text
M0 脚手架
  └─ 2.1 Evidence Ledger（1→5，串行）
       ├─ 2.3 Governance（9→10，依赖 1-3 的 state 语义）
       └─ 2.2 Composer（6→8，依赖 1 的 query + 3 的 state）
            └─ 2.5 MemOS（13→15，依赖 8 的 pre-step 注入）
2.4 Work Continuity（11→12，可并行于 2.2/2.3）
```

**依赖原则**：
- Evidence Ledger 是真相基座，一切依赖它 → 最先完成
- Governance 依赖 Ledger 的 state 语义（quarantine/supersede 已定义）
- Composer 依赖 Ledger 的 query（候选来源）→ 第三
- MemOS 接入依赖 Composer 的 pre-step 注入 → 最后（验证完整链路）
- Work Continuity 可并行（独立插件，只共享 Ledger）

## 4. 验收标准（M1 完成 = 全绿）

```text
□ Evidence idempotency：重放 3 次 = 1 条（0 重复）
□ authority 校验：矛盾组合拒绝（external_tool+user_explicit）
□ Read Guard：quarantine 永不注入、external_information 无偏好权威
□ Composer：p95 ≤ 900 tokens/step，telemetry 可观察
□ fail-open：MemOS 停掉后 DSH 正常应答
□ cross-scope leakage = 0
□ Benchmark A/B/F/G 4 case 归档到 docs/benchmark-results/  ✅
□ 单元测试全过（node test/*.test.mjs）  ✅（84/84）
□ git 历史清晰（每任务一个 commit，conventional commits）  ✅
□ 集成到 web profile 实测一轮  ✅（2026-08-27：摄入/注入/命令/WorkState 全通）
```

## 5. 里程碑退出标准（M0 → M1 判定）

```text
M0 完成：monorepo 可 pnpm install + 测试可跑 + 文档 10 份齐
M1 完成：上表全绿 + 集成到 web profile 实测一轮
```