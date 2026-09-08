> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — Consolidation 设计（v0.1 候选）

> 来源：Hindsight observations 模型源码/文档研究（MIT，2026-08-25 核实）。
> 本文件是 v0.1 后台 consolidation 的规格输入，MVP 不实现（热路径禁 reflection）。

## 1. Hindsight Observations 模型（研究摘要）

```text
retain() 完成 → 后台自动 consolidation：
  新 facts → 与已有 observations 比较
    ├─ 已有相似 observation → refine（强化/细化，不覆盖）
    └─ 无 → 创建新 observation

每个 observation：
  - 引用支持的 memories（带精确引用 quotes）
  - proof count（支持计数）
  - evidence-grounded（不是 LLM 现场发明的摘要）
```

### Near-duplicate reconciliation
- 阈值 `HINDSIGHT_API_CONSOLIDATION_DEDUP_THRESHOLD`（默认 0.97，enabled by default）
- 创建/更新 observation 时与最相似者比较 → merge（合并证据集）或 keep（保留分离）
- 关键：检查读取双方全文——在**有意义的细节差异**（数字/否定/命名实体/语言）时
  正确保留分离，不 collapse
- 只在同 tag scope 内比较（volatile tag 会导致永不 dedup，用 observation_scopes: shared 跨会话）

### Contradictory evidence：保留完整旅程
```text
Week1 "User loves React"        → "User prefers React"
Week2 "praises component model" → "enthusiastic about React's component model"
Week3 "switched to Vue"         → "was a React enthusiast..., but has now switched to Vue"
```
最终 observation 记录**完整演变**，不是"User prefers Vue"。系统：
1. 检测冲突
2. 保留历史（把之前理解并入新 observation）
3. 不盲目覆盖

## 2. 对 ACP 的映射

| Hindsight | ACP | 差异说明 |
|---|---|---|
| observation（去重信念） | Observation（可版本化派生认知） | 已有相同抽象 |
| supporting facts + quotes | evidenceIds + 可追溯链 | ACP 用 id 引用，正文在 Ledger |
| refine 不覆盖 | Observation version+1，evidenceIds 更新 | 一致 |
| dedup threshold 0.97 | v0.1 可配置阈值 | 一致 |
| 保留完整旅程 | Evidence 层 valid_from/valid_until + supersede | **互补**：Hindsight 在认知层保留语义旅程，ACP 在真相层保留时间线 |
| observation_scopes（tag 作用域） | scopeId + claimDomain | 一致 |

**关键差异（ACP 更强）**：
1. Hindsight 的 observation 由 LLM 后台生成，**没有确定性 Level 1 冲突检测**
   ——ACP 的确定性 supersede（user_correction 立即生效）是 Hindsight 没有的
2. Hindsight 没有 authority 维度——observation 的权威完全由 LLM 判定
3. ACP 的 Observation 必须 100% 可追溯到 Evidence（provenance coverage 验收 KPI）

## 3. v0.1 Consolidation 后台流程（设计）

```text
turn/end → enqueue（per-scope serial queue）
  → Evidence batch 累积（≥8 条 或 45s idle 或 8-12k tokens 强制）
  → Episode Builder（按 conversation_turn/task 聚合）
  → [确定性] 主题归一化 + Level 1 冲突检测（supersede 已在写入时做）
  → [LLM] Fact/Preference/Work 抽取（cheap model，后台）
  → [LLM] Observation 创建/refine（supports + proof count + evidenceIds）
  → 与近邻 Observation 比较（dedup threshold）→ merge / keep
  → Observation 更新（version+1）→ Profile materialized view 重建
  → Behavior candidate 生成（仅 v0.1 Expression 启用时）
```

### 约束（继承报告红线）
```text
× LLM 不得直接改 Evidence 的 state（只有确定性 Level 1 和人工可以）
× LLM 生成的 observation 只是 candidate，进 view 前要过 governance
× 热路径永不等待 consolidation（下一轮用旧 committed state）
× LLM 失败不阻塞 durable Evidence（Evidence 已落盘，consolidation 可重试）
```

## 4. 与 CONTRACTS 冲突检测的关系

```text
Level 1（确定性，写入时）：
  subject+predicate+claimDomain 相同 + user_correction → supersede
  这条已保证"显式纠正立即生效"，不依赖 consolidation

Level 2（LLM reflector，后台）：
  Evidence batch → LLM 语义比对 → needs_review / candidate
  这条处理"语义相似但字段不同"的冲突，只标记不裁决
```

Consolidation 的 observation refine 是第三层：**认知层**的语义合并，
发生在 Evidence 层裁决之后——它只改变 Observation 视图，不改变 Evidence 真相。

## 5. MVP 明确不做

```text
× 自建 LLM consolidation 引擎（复用 Provider 或 v0.1 再建）
× Mental Model 预计算（Hindsight 的 standing answer）
× Near-duplicate reconciliation（阈值调优需要数据）
× Profile 推断（explicit-only）
```

## 6. 验收指标（v0.1）

```text
Observation provenance coverage 100%（每条可追到 Evidence id）
stale current-truth rate < 2%
false personalization < 1%
explicit correction 下一 turn 生效 ≥ 99%
consolidation 后台 input ≤ 1800 tokens/turn
```
