> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — Context Composer 设计与 Token 预算

> Context Composer 是整个 ACP 的核心。它不是 `topK(memory)`，而是"每个模型步骤前决定
> 什么进模型、什么不进"的控制组件。本文件定义它的流程、评分、预算与降级路径。

## 1. 为什么它必须是核心

DSH 官方语义：system prompt、tool schemas、retained history **每 step 重发**，只有
byte-identical prefix 才保持 KV-cache 前缀稳定。因此 ACP 每多注入 1 token，在多步
Agent 中会被重复计费 S 次（S = steps_per_turn，编码场景 3–6 常见）。

> **最大化 ACP 价值的不是"搜得更准"，而是"注入得更少但更相关"。**

## 2. 流程（每个模型步骤前执行）

```text
agent/pre-step 触发（waterfall，调 next()）
    ↓
1. Resolve Scope        ← 会话 cwd / agentKey / session_type
2. Resolve Work Focus   ← 当前 WorkState（若有）
3. Policy / Safety      ← 读取治理策略
4. Determine Disclosure ← 请求方与目标域
5. Build RecallPlan     ← 显式 refs 优先，plan-constrained（禁 broad retrieve 再截断）
6. Parallel Provider Recall（bounded，AbortSignal）
7. Normalize            ← 异构 score 归一化
8. Read Governance      ← scope/release/sensitivity/temporal/authority-domain
9. Rank                 ← 资格判定 → 相关度排序（两步）
10. Diversity / Dedup   ← MMR + cross-turn dedup
11. Token Packing       ← section quota + utility/token
12. Source-labelled Render ← 注入为 plugin message（带来源，不伪装成 System Instruction）
```

## 3. 资格判定（Eligibility，先于排序）

```text
eligible =
  scopeAllowed
  AND releaseAllowed
  AND sensitivityAllowed
  AND temporalValid
  AND authorityAllowedForTargetDomain
```

不通过 → drop + trace（可审计），不参与排序。

## 4. 排序公式（v0.1 基线，可调）

```text
Relevance =
    0.32 × semantic
  + 0.18 × lexical
  + 0.16 × work_focus
  + 0.12 × temporal_fit
  + 0.10 × evidence_support
  + 0.07 × freshness
  + 0.05 × provider_prior

Quality   = 0.50 + 0.50 × confidence
Utility   = Relevance × Quality + explicit_ref_boost + explicit_correction_boost
          - redundancy_penalty - risk_penalty
```

**刻意不把 authority 乘进 score。**
**Provider 自适应（2026-08-25 第二批决策）**：
```text
MemOS Provider 在线：Relevance = 0.32×semantic + 0.18×lexical + ...（完整公式）
本地 Ledger 单独用：   semantic 分量并入 lexical → 0.50×lexical + 0.16×work_focus
                       + 0.12×temporal_fit + 0.10×evidence_support
                       + 0.07×freshness + 0.05×provider_prior
（semantic 是 provider 可选能力：有 Provider 用 0.32，无则 0.32 并入 lexical）
``` authority 决定"能否改变行为/Profile/Work"，不决定"和 query 相关不相关"。

**semantic 分来源（已决策 2026-08-25）**：
```text
MVP：semantic 分由 MemOS Provider 返回的 relevance 归一化提供；
     本地 Ledger 单独用时（无 Provider）该分量降级为 lexical 近似（0.32 权重并入 lexical）。
v0.1：可接入自建 embedding 或 Hindsight 等外部 Provider。
设计原则：semantic 是 provider 可选能力，不是 Composer 的硬依赖。
```

## 5. Token 预算（Model Experience 契约）

### 5.1 总预算

```yaml
context:
  ratio: 0.12              # 可用模型窗口 × ratio
  soft_max_tokens: 6000
  hard_max_tokens: 8000
```

### 5.2 Section quota（默认，可动态）

| Context 类型 | 默认上限 | Coding/research 续作时 |
|---|---:|---:|
| Current WorkState / decisions | 25% | ~40% |
| User Profile | 15% | 15% |
| Observations / relevant memory | 35% | 25% |
| Expression few-shot | 20% | 10% |
| provenance / safety metadata | 5% | 5% |

### 5.3 MVP 更保守的固定预算（≤900 tokens/step）

```text
User Model       <= 180
Work State       <= 250
Relevant Memory  <= 300
Expression       <= 120
Provenance       <= 50
----------------------------
ACP total        <= 900 tokens


### 5.4 三级承诺（已决策 2026-08-25）

```text
MVP    ACP 增量预算 ≤ 900 tokens/step（不含用户 prompt / DSH system / tools / history）
v0.1   ACP 增量预算 ≤ 1200 tokens/step
长期   soft 6000 / hard 8000 = ACP 上下文规划的软/硬上限
        （与模型窗口 ratio 0.12 共同约束，见 5.1）
```

900 / 6000 / 8000 不是矛盾：它们是**不同成熟度的承诺**——MVP 保守值 / v0.1 目标 / 长期硬边界。

```

### 5.4 Composer 输出必须可观察

```text
retrieved = 17 items
admitted = 5 items
dropped_by_budget = 12
tokens = 842 / 900
```

## 6. Packing 策略

禁止简单 `topK`。采用：

```text
utility / token
+ MMR diversity
+ category floor/cap
```

优先级（自上而下）：

```text
explicit current refs
> active work decisions
> explicit user corrections
> high-confidence profile facts
> relevant observations
> raw episodes（最后展开）
```

## 7. 降级路径（MVP 就够用）

```text
MVP = deterministic weighted top-k + section quota
     （无 LLM reranker；token/延迟/可测试性均更优）
```

## 8. 热路径纪律

```text
正常请求只做：
  parallel DB/provider read
  → deterministic ranking
  → security filter
  → token budget
  → agent/pre-step

禁止：
  × reflection 进热路径
  × 每 turn LLM 重写 Profile
  × provider 双写（同一内容两个插件都注入）
```