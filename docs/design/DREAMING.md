# dsh-adaptive-context — Dreaming（离线巩固）设计 v0.1

> 2026-09-22 起草。**设计稿，尚未实现。** 定位：ACP 的一部分（不是独立记忆库）。
> 前例与教训来源：weaver `project/wv-20260901-001`（四单元晋升管线）、`project/memory-architecture-20260606`
> （罗德岛三层记忆，已标记「被 ACP 取代」）、`work-skill/research-逐阶段记忆系统`。

## 0. 一句话

在线快环已经通了（pre-step 注入 + turn/end 蒸馏）。**dreaming 是慢环**：离线把证据与观察
整理成「可注入的稳定结论」，且**必须经过一道门**才允许晋升。

它**不是**又一个记忆仓库——`docs/design/ARCHITECTURE.md:10` 已定过这条：ACP 是 Context Control Plane，
外部记忆后端只是可替换 Provider。

## 1. 为什么现在做：四个实测缺口

| 缺口 | 现象（2026-09-22 实测） | 代码位置 |
|---|---|---|
| ① 无归并 | observation 冲突键是 `(scope, subject, predicate, claimDomain)`，**同键才 supersede**；同一件事换个说法就永久并存 | `src/store.mjs:492-495` |
| ② 无复现计数 | 一条偏好说一次和说十次，authority 完全相同 | —（没有这个概念） |
| ③ 无遗忘 | evidence 永不衰减（设计如此）；observation 只在**构图时**按半衰期降权、不淘汰，superseded 永久占库 | `src/composer.mjs:222` / `src/index.mjs:116` |
| ④ 无睡眠 | 所有整理都由 turn/end 触发的在线小批（batch ≤ 20）。**没有一次全量回看** | `src/consolidate.mjs:356-360` |

> 注：蒸馏 **37% 失败率**（42 ok / 25 failed）是运维问题，不在 dreaming 范围内——先单独查。

## 2. 边界：dreaming 不碰什么

| 模块 | 它管什么 | dreaming 的界线 |
|---|---|---|
| `consolidate.mjs` | 在线小批 evidence → observation | **不改它的触发与批次**；dreaming 在它之后跑 |
| `candidate.mjs` / `expression.mjs` | style 候选 → 审批 → 物化视图 | **复用机制（`approval.request`），不共用表** |
| `dsh-work-continuity` | WorkState | **明确不碰**——五条不可变原则之一：Memory does not own work continuity |
| `dsh-weaver` | 结构化知识库 | **不写 weaver**：跨插件写共享 SQLite 有并发与归属风险（已有先例结论） |
| `dsh-context-maid` | 压缩 + 先归档后压缩 | 不碰；它的归档走 `acp.append`，已受 B1 闸门约束 |

## 3. 四单元（对齐 wv-20260901-001，不另起炉灶）

```
事实提取器  →  候选池  →  共识引擎  →  长期沉淀器
(从账本读)   (7 天观察窗)  (去重/聚类/复现/矛盾)  (阈值内自动, 其余审批)
状态机：candidate → observed → consensus → approved
```

**物理分离是硬要求**：候选池必须是账本之外的独立表（甚至独立文件），绝不让未审批内容直接进
observation——这是「错误知识被自动晋升」唯一的硬防线（wv-20260901-001 §风险 1）。

## 4. 第一增量：三个确定性件（零 LLM、零新依赖）

按「先做不需要模型的部分」排序，三件都可单测、可回滚：

### ① 归并（确定性版）
- 判据：同 `claimDomain` 且 `subject` 相同 → 同簇；否则文本 **CJK bigram Jaccard ≥ 阈值** → 同簇。
  `jaccard()` 已在 `src/composer.mjs:450` 实现，直接复用。
- 产出：一条 `candidate_memory`（簇代表 + 成员 evidenceIds）。**不改动任何已有 observation**。
- 已知边界：词面判据抓不住「换个说法」，那部分留给 P2 的语义归并。

### ② 复现计数
- 判据：同簇成员**分布在 ≥N 个不同 session 或 ≥N 个不同自然日**。
- 语义：这正是 wv-20260901-001 说的「复现次数 ≥2 才升级」的确定性形式。
- **陷阱（前例已踩）**：它天然偏向「重复说的话」，对 `user_correction` 这类一次性高权威不适用——
  纠正走现有 direct supersede，**不进复现计数**。

### ③ 遗忘
- 只做**标记**不做删除（append-only）：
  - `superseded` 且超过 TTL 的 observation → 标 `archived`（读侧本来就不注入 superseded）
  - `quarantined` 且超过 TTL 的 evidence → 保持 quarantined，但纳入「冷存」统计
- 产出：一份可审计的冷存清单 + 体积统计。删不删永远是人决定。

## 5. 云端放置：三阶段（回答「能不能放云端」）

**能。而且「算」的那一半现在就在云端。** 分三层看：

| 层 | 放哪 | 依据 |
|---|---|---|
| **算**（LLM 推理） | 云端 | consolidation 现在就调云端 `deepseek-v4-flash`；不需要本地模型 |
| **调度**（睡眠触发） | 本机计划任务 **或** 云端 cron | 本机计划任务零新基建（`consolidate-backlog.mjs` 就是「独立进程 + 云端 LLM + 直读账本」的现成模板） |
| **权威点**（合并/去重） | 云端 flock 串行化 | `wv-sync.ps1` 已经跑通这套：inbound 上报 → 云端 flock 确定性合并 → outbound 下发 |

### 三阶段路线

1. **P1 本地调度 + 云端 LLM**（零新增基础设施）
   `scripts/dream.mjs` 照 `consolidate-backlog.mjs` 的形态：独立进程、`--dir` 参数化、host allowlist、
   `--dry-run`、失败留痕。可用 Task Scheduler 定时拉起。**代价**：要本机开机。

2. **P2 云端 cron + 单向上报**（只读 dreamer）
   本地把**候选与摘要素材**推上去（不推整库），云端定期跑 dreaming，产出**候选提案**，本地拉回来人工批准。
   **零回写风险**——云端永远不直接改本地账本。

3. **P3 双向同步 + 云端权威合并**（真·关机也能做梦）
   复用 `wv-sync.ps1` 的 inbound/outbound + flock 形态。
   **前置条件**：账本要统一。ACP 账本现在是**每机一份本地 SQLite**、没有同步机制——
   这条与 work_state 里悬着的「只 W 机还是三机统一账本」是**同一个决定**，必须先答。

### 隐私边界（必须写在前头）
dreaming 要把 evidence/observation 送上去。**注意边界其实已经存在**：consolidation 现在就在把
evidence 内容发往云端 LLM。P2/P3 的量级更大（是整批而不是每批 20 条），需要显式决定送什么、不送什么。

## 6. schema 提案（v7，待评审）

```sql
CREATE TABLE candidate_memory (
  id            TEXT PRIMARY KEY,   -- hash(scope, clusterKey, memberIds)
  scope_id      TEXT NOT NULL,
  state         TEXT NOT NULL,      -- candidate | observed | consensus | approved | rejected
  claim_domain  TEXT NOT NULL,
  subject       TEXT NOT NULL,
  text          TEXT NOT NULL,      -- 簇代表文本（不新造语义，取成员原文）
  evidence_ids  TEXT NOT NULL,      -- JSON：簇成员
  sessions      TEXT NOT NULL,      -- JSON：出现过的 session 集合（复现计数用）
  days          INTEGER NOT NULL,   -- 出现的不同自然日数
  occurrences   INTEGER NOT NULL,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE dream_run (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  window_from TEXT, window_to TEXT,
  scanned    INTEGER, clustered INTEGER, promoted INTEGER, archived INTEGER,
  note       TEXT
);
```

沿用 `evidence` / `observation` 的既有约定：id 由内容派生（幂等）、`created_at/updated_at` 毫秒整数、
写操作同事务记 audit。

## 7. 验收指标（借 wv-20260901-001 的五项，本地化）

| 指标 | 目标 |
|---|---|
| 噪音占比 | 进候选池的条目中纯应答/一次性指令 < 20% |
| 聚类正确率 | 人工抽查 20 簇，错并 < 1 |
| 误晋升率 | 一期靠人工审批压到近 0 |
| 可回溯 | 每条候选可回到 session / 时间 / evidenceIds |
| 离线可跑 | `--dry-run` 不写任何行（单测钉死） |

## 8. 明确不做

- **不自动晋升到 observation**（一期）：`approved` 之后由人决定，或走现有 style 那套 approval 门。
- **不做跨 Profile / 跨机共享**（等 P3 与账本统一决定）。
- **不引运行时依赖**：AGENTS.md 铁律 6；语义归并（P2）也必须走 Provider 插槽而不是内嵌模型。
- **不写 weaver**：跨插件写共享库有归属风险，只读。

## 9. 第一步落地清单（待批准后实施）

1. `src/dream.mjs`：纯函数三件套 —— `clusterEvidence()` / `countOccurrences()` / `planArchival()`
2. `src/store.mjs` schema v7：两张表 + 幂等写入 + audit
3. `scripts/dream.mjs`：离线运行器（`--dir` / `--dry-run` / `--apply` / `--window-days`）
4. `test/dream.test.mjs`：纯函数 + dry-run 零写入 + 幂等重跑
5. `scripts/ledger-audit.mjs` 增加一节：候选池与冷存统计

**语义归并（embedding）留到 P2**，走 Provider 插槽，不在本增量里。
