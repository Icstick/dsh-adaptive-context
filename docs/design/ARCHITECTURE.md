> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 插件组工程架构 v0.1

> DeepSeek Harness Adaptive Context Plane：受预算与治理约束的自适应上下文控制平面。
> 依据《DSH Adaptive Context Plane：跨项目源码级与架构级深度调研报告》与《工程可行性、Agent 主导实现难度与 Token 预算审计报告》落地为一组 Cordis 插件。

## 0. 一句话定位

**ACP 不是"又一个记忆仓库"，而是 DSH 的 Context Control Plane：证据真相（Evidence Ledger）+ 编排（Context Composer）+ 治理（Governance）由 ACP 自己掌控，外部记忆后端只是可替换 Provider。**

## 1. 与 DSH 现有架构的咬合点（已核对 goldmine 快照 b150a551）

| DSH seam | ACP 使用方式 | 依据 |
|---|---|---|
| `session/event` | Canonical Evidence 摄入源（不是 `agent/pre-step` 看到的 message） | 架构总览：Session 是追加式事实源 |
| `agent/pre-step` | Context Composer + bounded injection（waterfall，必须 `next()`） | 插件核心：waterfall listener 调 next() |
| `tools/pre-execute` | Tool policy / provenance / capability guard | Host 配方：pre-execute 可 allow/deny/ask |
| `tools/post-execute` | 捕获 outcome metadata | Host 配方：post-execute 变换结果 |
| `turn/end` | enqueue background consolidation（不阻塞） | ACP 报告：MemOS/Hindsight 验证的异步模式 |
| `ctx.approval.request` | 写路径审批门（复用 dsh-memento 已验证的 pattern） | dsh-memento ARCHITECTURE 决策 2 |
| `ctx.tools.register` | 暴露 `acp_` 前缀工具 | Host 配方：不绕过 registry |
| Cordis dispose | bounded best-effort queue drain | 插件核心：effect/dispose 语义 |

**红线（来自 DSH 插件开发核心）：**
- 先 validate/execute/persist 成功后再 emit；不维护可从 ledger 重建的第二份真相
- 模型可见事实必须是 Session event；Waterfall listener 调 `next()` 才继续链
- 不为测试扩大 public export；不同时挂载同一 service key 的 provider

## 2. 与 dsh-memento / Personal Suite 的关系

- **dsh-memento**（0.4.3，三角色 seam）已覆盖：审批门、审计三链、双层预算、agentKey 作用域、快照注入（-50）。ACP **不重复实现**这些；memento 的 store 可作为 ACP 的第一个本地 Provider 候选，或 ACP 自带 SQLite Evidence Ledger 后由 memento 保持现状互不干扰。
- **Personal Suite 基线 v0.2** 原则全量接受：out-of-tree 不 fork；Profile Bundle 组合；Model Experience 契约（What the model sees / Token effect / KV Cache effect）每个模型可见功能必写；先共享 contract 后共享 package。
- **注入边界（已决策 2026-08-25）**：MVP 阶段 memento 快照（systemPrompt 段，人工记忆）与 ACP pre-step 注入（plugin message，自动证据 recall）**并行共存**——位置与内容来源不同，不重复；v0.1 后收敛到 Context Composer 唯一注入 authority（届时可选择性关闭 memento 快照注入）。

## 3. 插件组划分（monorepo，pnpm workspace）

```
D:\DSH_workspace\dsh-adaptive-context\          ← 独立位置（与 plugins/ 平级）
├── package.json                    ← workspace 根（private）
├── pnpm-workspace.yaml
├── docs/                           ← 工程文档（本目录）
├── packages/
│   ├── dsh-adaptive-context/       ← 核心插件 bundle（Evidence Ledger + Governance + Context Composer + User Model）
│   │   ├── src/                    ← index.mjs / lib 模块（见 6）
│   │   ├── cordis.patch.yml        ← 挂载本 bundle
│   │   └── package.json
│   ├── dsh-work-continuity/        ← 行为层独立插件（/checkpoint、WorkState 投影）
│   ├── dsh-expression-evolution/   ← 行为层独立插件（v0.1：Evidence→Candidate→Manual Promotion）
│   └── (provider-memos/ MVP 轻量实验接入；hindsight/openviking 后续)
```

**为什么不拆更细：** Evidence / User Model / Context Composer / Governance 共享 provenance 与 transaction 语义，拆成四个 npm 插件只会增加 hook 顺序与 schema 事务成本（报告 §"插件组合还是巨型插件"）。Expression / Work Continuity 才是真正可独立启停的行为层。

## 4. 核心数据契约（v0.1，先共享 contract 后共享 package）

见 `docs/CONTRACTS.md`。骨架：

```ts
// Evidence = 真相来源（append-only）
interface Evidence {
  id: string
  scopeId: string            // user/workspace/agent 三层作用域
  sourceClass: 'system' | 'user_input' | 'user_correction' | 'external_tool' | 'agent_authored'
  authority: 'system_policy' | 'user_explicit' | 'user_correction' | 'single_observation' | 'agent_inference' | 'agent_self_evaluation' | 'external_information'  // 7 值（写入时确定性声明）
  confidence: number         // 0..1，≠ authority
  durability: number         // 保留倾向，≠ truth
  sensitivity: 'public' | 'private' | 'sensitive' | 'secret'
  claimDomain: 'user_fact' | 'user_preference' | 'work' | 'experience' | 'style' | 'external_fact'
  content: string
  contentHash: string
  sourceRef: { sessionEventId?: string; toolCallId?: string; provider?: string; receiptUri?: string }
  observedAt: string
  validFrom?: string
  validUntil?: string
  state: 'active' | 'quarantined' | 'superseded' | 'redacted'
  supersedes?: string[]
}

// Observation = 可版本化派生认知（materialized view 的原料）
// Profile = 用户画像 materialized view（stableFacts/preferences/recentState/interactionPatterns/inferredTraits）
// WorkState = goal/decisions/checkpoints/unresolved/nextSteps/artifacts（与 Profile 完全分离）
```

**五条不可变原则（写进 ADR）：**
```
Evidence is truth; views are rebuildable.
Confidence is not authority.
Retrieval does not imply disclosure.
Learning does not imply promotion.
Memory does not own work continuity.
```

## 5. DSH hook 映射时序（一次 turn）

```
user message
  → agent/pre-step: Composer 并行读取 materialized views + provider recall
      → Read Governance 过滤（scope/sensitivity/temporal/authority-domain）
      → token 打包（section quota）→ source-labelled plugin message → next()
  → model step（1..n）
  → tools/pre-execute: Tool policy guard
  → session/event: Evidence ingestion（幂等，contentHash + sourceRef）
  → turn/end: enqueue consolidation（后台 queue，下一轮不等待）
```

**显式纠正 fast-path：** 用户明确纠正 → 同步 append Evidence → Recent Explicit Overlay 立即可见 → 后台 consolidation。

## 6. 核心 bundle 内部模块（packages/dsh-adaptive-context/）

```
src/
├── index.mjs              ← function plugin 入口（export name/inject/Config/apply）
├── service.mjs            ← Service Definition：ctx.acp（evidence/recall/compose/checkpoint）
├── store.mjs              ← Provider：SQLite Evidence Ledger（WAL，同步，node:sqlite）
├── authority.mjs          ← AuthorityClass 枚举 + promotion gate（确定性）
├── lifecycle.mjs          ← Evidence state 迁移（supersede/quarantine/rollback）
├── governance.mjs         ← Write Guard / Read Guard（确定性检测，0 LLM）
├── composer.mjs           ← Context Composer（资格判定→排序→token 打包）
├── budget.mjs             ← section quota + telemetry
├── extract.mjs            ← SessionEvent → Evidence 规范化（幂等）
├── queue.mjs              ← per-scope serial background queue
├── strings.mjs            ← 模型可见文案（en/zh）
└── types.d.ts             ← declaration merging（memory/acp/* 事件词汇）
```

## 7. 验证与测试（对齐 plugin-verification 矩阵）

- 变化面：function/service → `node --test` 定向；新包 → typecheck + verify-package-invariants
- Contract tests：Evidence idempotency（重放 3 次 = 1 条）、authority promotion gate、rollback 重建、composer budget ceiling、fail-open（provider 宕机不阻断 turn）
- 验收 KPI（来自审计报告）：provenance coverage 100%、重放重复 Evidence 0、ACP context p95 ≤ 900 tokens/step、backend outage 不导致 DSH turn 失败、cross-scope leakage 0

## 8. 里程碑

| 阶段 | 内容 | 目标 |
|---|---|---|
| MVP（2.5–4 人月） | Evidence Ledger + Governance 最小安全集 + Context Composer + User Model explicit + /checkpoint | 跨 session context 可靠注入，≤900 tokens/step |
| v0.1 | Background consolidation + temporal truth + Expression Evidence→Candidate（manual promotion）+ Work checkpoints | ≤1200 tokens/step |
| v1 | Capability-aware provider routing + guarded auto promotion + audit/export/rebuild | 长期运行平台 |


## 9. 已拍板决策与遗留开放项

**已拍板（2026-08-25，用户确认）：**
1. **memento 关系**：ACP 自带 SQLite Evidence Ledger，dsh-memento 保持现状互不干扰
2. **工程位置**：独立 monorepo `D:\DSH_workspace\dsh-adaptive-context\`（与 plugins/ 平级）
3. **Provider 优先级**：MVP 轻量接入 MemOS 实验后端（契约验证为主，关闭其自动注入）
4. **实现顺序**：Evidence Ledger 先
5. **冲突检测**：两级设计（Level 1 确定性 supersede + Level 2 LLM reflector 仅产 candidate）

**遗留开放项（2026-08-25 三批讨论后已清零）：**
1. ~~Expression promotion 词汇统一~~ → 已定：三级（STRONG/NEGATIVE_ONLY/WEAK）
2. ~~Composer semantic 分来源~~ → 已定：MemOS Provider 提供，无则并入 lexical
3. ~~memento 注入共存边界~~ → 已定：MVP 并行，v0.1 收敛 Composer 唯一注入
4. ~~COMPOSER 预算层级~~ → 已定：三级承诺（MVP≤900 / v0.1≤1200 / 长期 6000-8000）

**规划阶段三批讨论全部完成（2026-08-25），无遗留开放项。下一步：feature 分支实现。**