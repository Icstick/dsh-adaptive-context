> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — Schema 逐字段审查清单

> 2026-08-25 交叉讨论输入。✓=合理可定稿；⚠️=需澄清表述；❓=需拍板的设计决策。
> **状态：全部决策已拍板并落地 CONTRACTS.md（59267ae + 本提交）**。
> 依据：源码研究（personagent/Hindsight/MemOS）+ DSH 约束 + 报告建议。

## 1. Evidence 逐字段

| 字段 | 判定 | 审查意见 |
|---|---|---|
| id（hash(sourceRef+contentHash)） | ✓ | 与 personagent event_id（sha256 语义字段）同构，幂等已验证 |
| scopeId | ✓ | user-global/workspace 二维，对齐 memento |
| agentKey | ✓ | 第三维，防 subagent 污染 |
| sessionType | ✓ | root/subagent/fork，写边界检查用 |
| sourceClass（5 值） | ✓ | 写边界的输入 |
| **authority（8 值）** | ❓ | **谁赋值？何时赋值？** 必须确定性。user_repeated_behavior 是派生概念，不应在写入时声明——见讨论 1 |
| confidence | ✓ | 0..1，与 authority 分离已明确 |
| durability | ✓ | 保留倾向，非 truth |
| sensitivity | ✓ | 4 级；但 GOVERNANCE 说 sensitive 可配 TTL——TTL 字段在哪？⚠️ |
| claimDomain（6 值） | ✓ | experience vs style 区分保留 |
| content | ✓ | 上限 8000 字符？tool result 可能超——截断策略？⚠️ |
| contentHash | ✓ | sha256 去重 |
| sourceRef | ⚠️ | receiptUri 来自 Hindsight Memory Defense——MVP 是否需要？见讨论 4 |
| observedAt / validFrom / validUntil | ✓ | temporal truth 三件套 |
| state（4 值） | ✓ | 已补 redacted |
| **supersedes: string[]** | ❓ | **数组语义**：一条被多条替代？多条共同替代一条？见讨论 3 |
| metadata: Record | ⚠️ | 无约束自由 JSON——需限制键集或标注用途 |

## 2. Episode 逐字段

| 字段 | 判定 | 审查意见 |
|---|---|---|
| 整体 | ⚠️ | **MVP 不实现**（Episode Builder 在 v0.1 consolidation）——契约需标注阶段，否则误导实现者 |
| kind（4 值） | ⚠️ | feedback_episode 具体指什么？与 conversation_turn 边界？ |
| participants | ⚠️ | 指 speaker_ids？DSH 场景通常是单 user + agent——是否必需？ |

## 3. Observation 逐字段

| 字段 | 判定 | 审查意见 |
|---|---|---|
| **subject/predicate/value 三元组** | ❓ | **结构化 vs Hindsight 自由文本**——三元组利于 Level 1 确定性冲突检测（subject+predicate 相同），但 LLM 生成三元组不稳定。见讨论 2 |
| kind（5 值） | ✓ | fact/preference/pattern/inference/style |
| authority / durability | ✓ | 继承 Evidence 语义 |
| evidenceIds | ✓ | provenance 可追溯 |
| state（candidate/active/superseded/quarantined） | ⚠️ | candidate→active 谁 promote？Level 2 reflector 只产 candidate，人工/策略 promote——需写明 |
| version | ✓ | refine +1 |

## 4. Profile 逐字段

| 字段 | 判定 | 审查意见 |
|---|---|---|
| 五个 ObservationRef 数组 | ⚠️ | MVP explicit-only 下 inferredTraits/interactionPatterns 恒空——**MVP 是否简化**（只留 stableFacts/preferences），v0.1 再扩？见讨论 5 |
| sourceVersion | ✓ | 由 Ledger 版本派生，可重建 |

## 5. WorkState 逐字段

| 字段 | 判定 | 审查意见 |
|---|---|---|
| 整体 | ✓ | 与 AI Workroot 对齐，MVP /checkpoint 持久化，无需改动 |

## 6. BehaviorCandidate 逐字段

| 字段 | 判定 | 审查意见 |
|---|---|---|
| promotedBy: 'policy'|'human' | ⚠️ | v0.1 manual only——policy 值保留为未来，标注 |
| status 五态 | ✓ | 与 personagent 生命周期一致 |

## 7. Provider Capability Contract

| 项 | 判定 | 审查意见 |
|---|---|---|
| 标"v0.2+，MVP 不实现" | ⚠️ | **与 MVP 接 MemOS 矛盾**——MVP 用最小 recall adapter（不实现完整契约），完整契约 v0.2。需标注区分 |

## 讨论清单（按返工成本排序）

1. **authority 赋值路径**：8 值里哪些是"写入时确定性声明"，哪些是"派生"？user_repeated_behavior 由谁、何时提升？
2. **Observation 结构化程度**：subject/predicate/value 三元组 vs 自由文本——决定 Level 1 冲突检测可行性
3. **supersedes 数组语义**：一条被多条替代？还是多条共同替代一条？与 Graphiti temporal invalidation 的关系
4. **receiptUri 去留**：MVP 需要吗？
5. **Profile MVP 简化**：五数组 vs 二数组起步？