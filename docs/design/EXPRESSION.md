> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — Expression Evolution 设计（v0.1 候选）

> 来源：personagent 源码研究（evidence.py / candidates.py / promotion.py，MIT 许可，
> 2026-08-25 核实）。以下为 clean 参考后的 ACP 化设计，非复制实现。

## 1. 核心不变量（来自 personagent 文档注释，值得逐字保留精神）

> "A single automatic signal must never permanently change behaviour."
> 单一自动信号永不永久改变行为。

> "Evidence does not imply authority."
> 证据不蕴含权威。

> "Testimony is worth keeping even when it is wrong."
> 即使是错的证词也值得保留——坏教学记录正是发现被教坏的方式。

## 2. 生命周期状态机（与 ACP BehaviorCandidate 映射）

```text
proposed --promote--> promoted --rollback--> rolled_back
    |                     |
    |                     +--supersede--> superseded   (被新候选替代)
    +--reject---------> rejected
```

- 每个 transition append 到候选 ledger，**没有任何行被编辑/删除**
- 当前状态 = ledger 重放的 projection（restart 不会与写入进程分歧）
- Retrieval 不读 ledger：promoted 候选 materialize 成 view 文件（hot path），
  view 是 cache，可随时原子重建

**对应我们 ACP**：
```text
Evidence (Ledger, append-only, 真相)
  → Candidate (行为层, inert proposal)
  → Promotion (policy gate, 授予行为权威)
  → Few-shot pool (materialized view, hot path)
```

## 3. Promotion Policy（默认阈值，全部有 floor）

| 参数 | 默认 | Floor | 含义 |
|---|---|---|---|
| min_events | 2 | **2**（不可降到 1） | 两个独立兼容事件——最小的"不可能由一次误读产生"的数量 |
| min_strong | 1 | **1** | 至少一个 strong（directed correction 或 accepted retry） |
| min_speakers | 1 | 1 | 至少 N 个不同人（owner 豁免；默认 1 因为 solo clarification 是合法路径） |
| max_evidence_age_days | 30 | 0 | 30 天前的证据不再计数（四个月前是历史，不是授权） |
| require_same_conversation | true | — | 同一会话内组合（防 cross-room 放大：一个 loud teacher 不会到处达标） |
| auto_promote | true | — | master switch；false = 全部留人工 |

**关键**：PROMOTE_MIN_EVENTS=1 会被 floor 强制升回 2——"floors, not suggestions"。
弱证据（weak）任何数量都不 promotion（笑声不能增长 example pool）。

## 4. classify_strength：单事件可授予的权威量

```text
STRONG        明确 directed correction（针对回复目标的人 + 具体 replacement）
              / retry 被同一人接受
NEGATIVE_ONLY 无具体内容的 rejection / 旁观者 correction
              （owner 身份 ≠ 受影响接收者，第三方纠正即使可信也落在这里）
WEAK          笑声 / 同意 / 闲聊 / agent 自己的评分（永不 promotion）
```

**对应我们 ACP 的 authority 层级**：
```text
ACP authority: user_correction ≈ STRONG
               user_explicit   ≈ STRONG（directed）
               single_observation ≈ NEGATIVE_ONLY
               agent_self_evaluation ≈ WEAK（永不单独 promotion）
               external_information = not eligible
```

## 5. 方向性：supports / opposes（比强度更重要）

```text
对 preference_pair（改写对）：correction/rejection/retry_acceptance 支持，positive 反对
对 positive_example（模仿对）：positive 支持，correction/rejection 反对

"把一堆混合事件按多数投票"是错误做法——方向不对的多数会让反馈回路自我强化矛盾。
```

## 6. supports_candidate：三重对齐（容易错的一步）

一个事件支持某个候选，必须同时满足：
1. **同 reply 文本**（事件讨论的回复必须与候选目标一致）
2. **兼容 scope**（persona/lang/platform/conv_id/version 一致；空标签不主张兼容一切）
3. **同 better**（"replace X with C" ≠ 支持 "replace X with B"——一个纠正只能授权它要求的改写）

## 7. decide()：拒绝路径全部可审计

```text
auto_promote=false        → "automatic promotion disabled"
非 proposed 状态          → "state is X, not proposed"
存在反对证据 (against)    → "compatible evidence disagrees — left for review"
存在冲突候选 (conflicting)→ "a conflicting candidate exists — left for review"
strong 不足               → "N/M strong events (K supporting)"
事件数不足                → "N/M compatible events"
speaker 不足              → "N/M distinct speakers"（缺失 speaker 数据不 veto，回退事件数）
```

每个拒绝都有明确 reason——这是可审计性，不是装饰。

## 8. 对我们 ACP 的落地建议

1. **MVP 不做 Expression**（报告红线）——本设计是 v0.1 的规格输入
2. v0.1 起：manual promotion 优先（human-approved 才能进 few-shot），
   自动 promotion 作为可配置开关（默认关或保守）
3. BehaviorCandidate 状态机直接采用 personagent 的 5 态（proposed/promoted/
   rejected/superseded/rolled_back），生命状态存 append-only ledger
4. Few-shot 注入：promoted 候选 materialize 成 view（不读 ledger），
   DSH pre-step 时按 scenario/task 检索 1–2 条
5. **与 ACP Evidence 的关系**：candidate 的证据支撑来自 Evidence Ledger
   （evidenceIds），但 Evidence 本身永不因 promotion 而改变状态——
   authority 是 candidate 层的属性，不是 Evidence 的属性
