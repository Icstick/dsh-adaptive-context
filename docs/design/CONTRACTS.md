> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 核心数据契约 v0.1

> 所有插件共享的 schema 语言。先共享 contract 后共享 package：v0.1 阶段契约定义在
> `packages/dsh-adaptive-context/src/schema/` 内，出现第二个真实 consumer 后再 extract 为独立包。

## 0. 作用域模型（对齐 dsh-memento 已验证的三维）

| 维度 | 取值 | 说明 |
|---|---|---|
| scope | `user-global` / `workspace` | 跨工作区 vs 按 cwd 隔离 |
| agentKey | `''`（共享） / 会话 agentPreset | 第三维，防 subagent 污染（OpenViking issue 教训） |
| session_type | root / subagent / fork | Evidence 摄入时强制记录，写边界检查 |

## 1. Evidence（真相来源，append-only）

```ts
interface Evidence {
  id: string                    // 稳定派生：hash(sourceRef + contentHash)，重放幂等
  scopeId: string
  agentKey: string
  sessionType: string

  sourceClass:
    | 'system' | 'user_input' | 'user_correction'
    | 'external_tool' | 'agent_authored'

  authority:                   // 写入时确定性声明（7 值，已决策 2026-08-25）
    | 'system_policy'          // system 摄入
    | 'user_explicit'          // user_input 摄入
    | 'user_correction'        // user_correction 摄入
    | 'single_observation'     // agent_authored 单次观察
    | 'agent_inference'        // agent_authored 推断
    | 'agent_self_evaluation'  // agent_authored 自评
    | 'external_information'   // external_tool 摄入
  // 注：user_repeated_behavior 已移除——"多次观察累积"由 Observation 层
  // (kind:'pattern' + evidenceIds 计数) 表达，单条 Evidence 不声明自身为 repeated

  confidence: number           // 0..1，仅表示"事实可信度"，不授予 authority
  durability: number           // 保留倾向（衰减），≠ truth
  sensitivity: 'public' | 'private' | 'sensitive' | 'secret'

  claimDomain:
    | 'user_fact' | 'user_preference' | 'work'
    | 'experience' | 'style' | 'external_fact'

  content: string
  contentHash: string          // sha256，去重/幂等
  sourceRef: {
    sessionEventId?: string
    toolCallId?: string
    provider?: string
    receiptUri?: string     // 预留：v0.2 接外部 Provider 时用（Provider receipt）；
                              // MVP 本地 Ledger 不填（sessionEventId 已可追溯）——2026-08-25 决策
  }

  observedAt: string           // ISO
  validFrom?: string           // temporal truth（Graphiti 模型）
  validUntil?: string

  state: 'active' | 'quarantined' | 'superseded' | 'redacted'
  supersedes?: string[]        // 直接前驱（方案甲，2026-08-25 决策）
                              // 语义：这条 Evidence 直接替代了哪些（通常 0-1 个；
                              // 一条新证据替代多条并行事实时 >1，此时数组顺序无意义）
                              // 演进历史 = getLineage(id) 回溯 + observedAt 排序，不冗余存储
  metadata?: {
    // 固定键集（2026-08-25 决策）：写路径只接受以下键，未知键拒绝
    ttlDays?: number          // 敏感内容 TTL（GOVERNANCE：sensitive 可配 TTL）
    reviewStatus?: string     // needs_review / approved / dismissed（Level 2 冲突用）
    scenarioTags?: string[]   // 场景标签（Expression 候选生成用）
    sourceVersion?: string    // 摄入方版本（审计）
  }
}
```

**语义铁律：**
```text
confidence != authority
authority  != durability
durability != relevance
relevance  != truth
```

**sourceClass 权威约束（写边界强制，0 LLM）：**
```text
external_tool        → 不得产生 user_preference / style / behavior authority
agent_self_evaluation → 永不单独 promotion
agent_inference      → 可入 Ledger，不进 active view（MVP 直接丢弃进 quarantine）
```

## 2. Episode（证据聚合单位，非事实本身）

> **阶段：v0.1 实现（2026-08-25 决策）**。MVP 不建 Episode 表——Evidence 经 sourceRef.sessionEventId 直接关联即可。

```ts
interface Episode {
  id: string
  scopeId: string
  kind: 'conversation_turn' | 'task_episode' | 'tool_episode' | 'feedback_episode'
  startedAt: string
  endedAt: string
  evidenceIds: string[]
  participants: string[]
  summary?: string
  outcome?: string
  artifactRefs?: string[]
}
```

## 3. Observation（可版本化派生认知）

```ts
interface Observation {
  id: string
  // —— 冲突检测键（机器可比，稳定，小）——
  subject: string              // 认知主体："包管理器"
  predicate: string            // 认知谓词："选择"
  claimDomain: string          // 复用 Evidence 的 claimDomain
  // —— 认知正文（LLM 生成，人类可读，浓缩认知）——
  text: string                 // "用户过去是 React 爱好者，现在已切换到 Vue"
  // —— 元数据 ——
  kind: 'fact' | 'preference' | 'pattern' | 'inference' | 'style'
  confidence: number
  authority: AuthorityClass
  durability: number
  validFrom?: string
  validUntil?: string
  evidenceIds: string[]        // supporting evidence（proof count = length）
  state: 'candidate' | 'active' | 'superseded' | 'quarantined'
  version: number
}

派生规则：新证据 → strengthen / weaken / refine 旧 Observation，不静默覆盖；每次变更 +1 version。

**规模与检索设计（已决策 2026-08-25）：**
```text
text 上限 500 字符——Observation 是浓缩认知，原始大内容留在 Evidence（8000 上限）
Profile 只存 refs，永不携带正文
数量级：500 evidence → 约 50–100 observations（consolidation 去重比 ~10:1~5:1）
检索三层：
  L1 冲突检测  subject+predicate 联合索引（精确匹配）
  L2 Recall    text 子串（instr，中文友好）
  L3 Semantic  可选（MemOS Provider，MVP 无则跳过）
排序：proof count（evidenceIds.length）做预筛选（<2 条证据不进候选）
     + freshness + authority；composer 注入只带 text 截断版（≤200 字符）
```

## 4. Profile（Materialized View，可重建）

```ts
interface Profile {
  subjectId: string
  generatedAt: string
  sourceVersion: number        // 由 Ledger 版本派生
  stableFacts: ObservationRef[]
  preferences: ObservationRef[]
  recentState: ObservationRef[]
  interactionPatterns: ObservationRef[]
  inferredTraits: ObservationRef[]
}
```

可追溯性：Profile item → Observation → Evidence → DSH session event。

**MVP 阶段（2026-08-25 决策）**：五数组 schema 一次定稿；explicit-only 下
`recentState` / `interactionPatterns` / `inferredTraits` 标注 **v0.1 启用**（MVP 恒空），
`stableFacts` / `preferences` MVP 即有内容。

**MVP 只允许 explicit 进 active view**（explicit correction / explicit statement）；agent inference 进 Ledger 不进 Profile。

## 5. WorkState（与 User Profile 完全分离）

```ts
interface WorkState {
  id: string
  projectId?: string
  parentWorkId?: string
  goal: string
  status: 'planned' | 'active' | 'blocked' | 'paused' | 'done'
  focus?: string
  decisions: { text: string; reason?: string; evidenceIds: string[] }[]
  checkpoints: { timestamp: string; state: string; evidenceIds: string[] }[]
  unresolved: string[]
  nextSteps: string[]
  artifacts: string[]
  handoff?: { summary: string; nextAgentHints?: string[] }
  version: number
}
```

MVP 只通过 `/checkpoint` 或明确 checkpoint 条件持久化，禁止每 turn LLM 重新总结。

## 6. BehaviorCandidate（Expression Evolution，v0.1 manual promotion）

```ts
interface BehaviorCandidate {
  id: string
  scenarioTags: string[]
  description: string
  badExample?: string
  preferredExample?: string
  evidenceIds: string[]
  status: 'proposed' | 'promoted' | 'rejected' | 'rolled_back' | 'superseded'
  promotedBy?: 'policy' | 'human'
  supersedes?: string
}
```

Promotion gate（v0.1 起点，三级对齐 personagent classify_strength，可调）：
```text
STRONG        明确 directed correction（针对目标 + 具体 replacement）/ 被接受的 retry
NEGATIVE_ONLY 无具体内容的 rejection / 旁观者纠正 / agent 自省（不单独 promotion）
WEAK          笑声 / 同意 / 闲聊 / agent 自评（任何数量都不 promotion）
not eligible  external_tool（不得产生行为权威）

自动 promotion 需 ≥2 个独立兼容 evidence，其中 ≥1 STRONG；冲突时停止自动 promotion。
v0.1 默认只允许 manual promotion（human-approved）。
```

（原五级 strong/medium/weak/very weak/not eligible 弃用——medium/very weak 无明确判据，
统一为 personagent 源码验证过的三级。）

## 7. Provider Capability Contract

> **阶段标注（2026-08-25 决策）**：MVP 只实现**最小 RecallProvider**（供 MemOS
> 轻量 adapter），v0.2 扩展完整 capability 契约（Reflect/Profile/Skill/Timeline）。

### 7.1 MVP 最小契约（MemOS 实验接入用）

```ts
interface RecallProvider {
  recall(query: RecallQuery, signal: AbortSignal): Promise<RecallCandidate[]>
}
// RecallQuery: { text?: string; scopeId?: string; limit?: number }
// RecallCandidate: { id: string; content: string; score: number; sourceProvider: string }
```

### 7.2 完整契约（v0.2+）

```ts
interface RecallProvider {
  recall(query: RecallQuery, signal: AbortSignal): Promise<RecallCandidate[]>
}
interface ReflectProvider {
  consolidate(request: ConsolidationRequest): Promise<DerivedKnowledge[]>
  reflect?(request: ReflectRequest): Promise<ReflectResult>
}
interface ProfileProvider {
  getProfile(subject: SubjectRef): Promise<ProfileSnapshot | null>
}
interface SkillProvider {
  searchSkills(query: SkillQuery): Promise<SkillCandidate[]>
  getSkill(id: string): Promise<Skill | null>
}
interface TimelineProvider {
  queryTimeline(query: TimelineQuery): Promise<TimelineItem[]>
}
```

**禁止设计 `interface MemoryBackend { remember/recall/profile/reflect/skill }`**（lowest-common-denominator 陷阱，报告明确反对）。

## 8. 冲突检测（语义冲突 reflector）——两级设计

> 决策来源：Graphiti invalidation scoping issue（LLM 错误 retire 语义相似但不相关的事实）
> + personagent"冲突时停止自动 promotion"规则。
> 结论：**LLM 生成的 contradiction 决策不能拥有删除/撤销真相的最终权限。**

### Level 1（MVP，确定性，0 LLM）

```text
触发条件：subject + predicate + claimDomain 相同的新证据写入
动作：
  新证据 authority 为 user_correction / user_explicit
    → 旧证据 state=superseded；新证据 supersedes 追加旧证据 id（直接前驱，方案甲）
    （注意：supersedes 属于替代者一侧——"新证据替代了谁"，不是被替代者记新 id）
  新证据 authority 低于旧证据
    → 不 supersede，仅标记新证据为 candidate
  同 authority 冲突（两个 user_explicit 矛盾）
    → 保留两条 active，标记 needs_review（人工裁决）
```

确定性规则保证：显式用户纠正立即生效（fast-path），无需 LLM。

### Level 2（v0.1，LLM reflector，后台）

```text
Evidence batch → LLM 语义比对 → 产出"疑似冲突" candidate
约束：
  × 不得直接修改 Evidence 的 active/superseded 状态
  × 不得直接修改 Observation/Profile
  ✓ 只能：标记 needs_review / 生成 candidate（供人工或策略 promotion）
```

### 为什么两级

1. Graphiti 教训：语义相似≠相关，LLM 判定不可作最终裁决
2. personagent 教训：冲突时应停止自动 promotion，而非模型自行选边
3. 热路径纪律：显式纠正必须同步生效，不能等 LLM 后台