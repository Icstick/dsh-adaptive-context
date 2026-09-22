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
| `dsh-weaver` | 结构化知识库 | **画像域永不入 weaver**；只有 `work` / `external_fact` 两域可走人工审的单向通道（见 §10）。**理由已修正**：不是「weaver 没写入 API」（那条先例已过期），是语义分域 |
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
- **不把画像域写进 weaver**：`user_preference` / `user_fact` / `style` 恒不出 ACP。可导出的只有 `work` / `external_fact`，且必须人工审（§10）。

## 9. 第一步落地清单（待批准后实施）

1. `src/dream.mjs`：纯函数三件套 —— `clusterEvidence()` / `countOccurrences()` / `planArchival()`
2. `src/store.mjs` schema v7：两张表 + 幂等写入 + audit
3. `scripts/dream.mjs`：离线运行器（`--dir` / `--dry-run` / `--apply` / `--window-days`）
4. `test/dream.test.mjs`：纯函数 + dry-run 零写入 + 幂等重跑
5. `scripts/ledger-audit.mjs` 增加一节：候选池与冷存统计

**语义归并（embedding）留到 P2**，走 Provider 插槽，不在本增量里。

## 10. 与 weaver 的通道（2026-09-22 评估结论）

> 来源：子代理只读评估（同一轮完成）。**它推翻了一条本文档先前复述的先例**，故单列。

### 10.1 先例订正：「weaver 未提供写入 API」已过期

- 该说法出自 `dsh-knowledge-recall/src/index.mjs:56-57` 与 `docs/research/PEER-SURVEY-20260909.md:122`，写于 2026-09-09/09-10。
- **工具面早就有写入口**：`D:/DSH_workspace/.tooling/lib/wv.mjs` 的 `putOne()`（:348）被 `put`（:396）与 `import`（:420）调用；子命令表含 `put / import / patch / rm`。带当日 VACUUM INTO 备份、`BEGIN IMMEDIATE`、经 `meta.db.id_sequence` 原子取号、以及 `notePending()` 触发跨机推送。
- 换句话说：**插件面没有写 API，工具面有**。把两者混为一谈，会把一个已解决的问题当成阻塞项。
- 归属风险那一半**仍然成立**（weaver 是三机共享库，ACP 账本是每机本地 SQLite）——但它是**语义**问题，不是并发问题。

### 10.2 真正的风险是语义，不是 SQLite 并发

实测（W 机）：`observation` 46 条 active 的域分布 —— `user_preference 22 / work 16 / external_fact 4 / user_fact 3 / style 1`。
**画像域占多数**，写进「整理好的知识卡片」定位的 weaver 会：
1. 与 3,961 条真知识争同一批命中位（非 verbatim 8 库中 85.9% 的条目 `access_count = 0`，再灌短画像只会推高死重）；
2. 在召回注入面造成**同一内容二次注入**——weaver 那路是 `[knowledge-recall]` 行、无 authority/claimDomain/supersede 语义，ACP 那路带完整标签，两条共享 900 tokens/step 预算；
3. 回音室：observation 来自用户自己的话，recall 查询词也来自用户消息 → 画像条目会系统性高命中当轮提问。

### 10.3 采纳方案：分域白名单的单向通道

**默认拒绝**，判据（纯确定性，可单测）：

```
claimDomain ∈ { work, external_fact }        // 画像三域永不出 ACP
  AND authority ∈ { user_correction, user_explicit }
  AND durability = permanent
  AND 至少 1 条 evidence 回链
```

流向：ACP 导出候选 JSONL（形态可复用 `src/export-import.mjs` 的 observation 流）→ **人工审** → `wv import` 写入。
**weaver 侧零改动**，ACP 侧只加一个导出器 + 一组判据 + 单测（铁律 4）。

验收：`wv check` 无新问题；这批条目两周后 `access_count > 0` 的比例应显著高于当前均值（14.1%）；召回 golden 无回退。

量级：实测蒸馏 **13.2 条 observation/天**（本文档早先按 2–3 条/天估算是错的，低约 5 倍）。
限制到两域后上界约 **6.7 条/天 ≈ 2,400 条/年**。

### 10.4 附带发现：weaver 库不是 WAL

W 机实测 11 个库（8 个知识库 + meta + verbatim + weaver）**`journal_mode` 全部是 `delete`（回滚日志），db 目录 0 个 `-wal` 文件**。
这与 weaver 条目 `workflow/wv-20260911-12481` 记载的「全库转 WAL 后连续写入 2.4 万条」**不符**。
回滚模式下写者提交期独占锁、读者会挡住写者，读写并发弱于 WAL。
→ 归属 weaver 侧核查（A/B 机状态本轮未取到），**不建议在核查前让 ACP 直写**。

## 11. 云端 staging 精馏（用户提议，2026-09-22 评估）

> 提议：**在 weaver 里设一个缓存分支库，云端计划任务对整库做精馏的同时，接纳缓存库的内容。**
> 评估结论：**方向比 §10 的方案 4 更对，建议作为 P2 的目标形态**；但只能先设计——云端与 A/B 机本轮均不可达。

### 11.1 为什么它更好

1. **物理分离做在了 weaver 层**，不只是 ACP 层：staging 与生产库是两个 db，未经晋升的内容**根本没有机会**进入检索面。
2. **晋升门放在了权威点上**：云端本来就是唯一串行化点（wv-sync.ps1:286 的 `flock -n merge.lock`）。门开在权威点，才谈得上「唯一」。
3. **精馏与接纳共用一次全库扫描**——两者本来都要「读全库 + 判重复/归并」，分两次是浪费。
4. **消掉了人工门的积压问题**：实测蒸馏 13.2 条/天，逐条人工审不现实（§10.3 已把这个列为方案 4 的已知代价）。

### 11.2 三个必须先解决的点

#### ① 缓存库**不该**进 LIBS

§10 反对「新增第 10 个 weaver 库」的理由是硬编码散在 4 处以上（weaver-query.mjs:18、dsh-weaver/index.mjs:68、search.mjs:13 ALL_LIBS、wv.mjs:26 LIBS）+ sync-manifest/parity 清单。
**但那个成本的前提是「它要能被检索」。staging 不需要被检索**——它只是云端的暂存 db，由精馏任务读写。
→ 所以：**不要把它做成 weaver 库，做成 <weaver-kb>/staging.db 一个独立 db**。不进 LIBS、不进检索面、不进 parity 比对。成本从「4+ 处协调」降到 **0**。

#### ② 归属问题被白名单消掉了——但必须带来源标记

§10.1 说「归属风险仍然成立」，前提是画像域会入共享库。方案 4 的白名单只放 work / external_fact——**这两类是共享知识，不是画像**，三机共用 staging 在语义上是安全的。
但 staging 条目**必须带来源槽位**（复用 wv-sync 已有的 WEAVER_SLOT a/b/w 概念），理由见下。

#### ③ 「同时」要拆开：接纳是确定性的，精馏不是

| 步骤 | 性质 | 失败后果 |
|---|---|---|
| **接纳** | 格式校验 + content_hash 去重 + 幂等写 staging | 可重试，零风险 |
| **精馏** | 判该不该晋升 / 同义归并 / 改写标题（可能用 LLM） | 实测蒸馏失败率 **37%**，不该拖累接纳 |

→ 两个任务、两个退出码，别混成一个。

### 11.3 一个真正的增量：跨机复现

staging 带来了单机 ACP **根本不可能有**的判据：**同一件事被几台机器独立提到过。**

```
跨机复现 >= 2   →  最强晋升信号（三机独立提到，比一台机器重复十次可靠得多）
```

这与 dreaming 已有的确定性判据天然对齐（candidate_memory 的 occurrences / sessions / days 都已算好），**是加法而不是新机制**。

### 11.4 建议的目标形态

```
每机 W/A/B：
  ACP dreaming → candidate_memory → dream-export --state approved
      （白名单已挡画像三域；这一步现在就做好了）
  ↓ scp（复用 wv-sync 的 inbound/<slot>/ 形态）
云端 /mnt/datadisk/weaver/：
  inbound/<slot>/*.jsonl
  ↓ flock ── 接纳（确定性）：格式校验 + content_hash 去重 + 幂等写 staging.db
  ↓ flock ── 精馏（可与全库精馏同一次扫描）：产出晋升提案
      判据：跨机复现 >= 2  或  (本机复现 >= N 且 authority 高)
  ↓ 自动接纳（因为已是「白名单 × 阈值」两道过滤之后的产物）
  wv import → 生产库，source = acp-dreaming:<id>
  ↓ outbound
各机：wv sync-pull
```

**可回滚**：接纳时 source 带 acp-dreaming:<候选 id> 前缀，出问题按前缀批量 wv rm（wv.mjs:472-503 记墓碑并跨机传播）+ 云端每日备份（ensureDailyBackup wv.mjs:126-134）。

### 11.5 与 P1 的关系：不废弃，是上游

本地这条链（dream.mjs → candidate_memory → dream-review → dream-export）**原样是 P2 的上游**——
P2 只是把 dream-export 的输出目标从「本地 JSONL 交给人」换成「推云端 inbound」。
人工门退化为**兜底**（默认不参与），而不是主路径。

### 11.6 未决 / 未取到

- **云端与 A/B 机本轮不可达**：129.28.69.74:2222 timeout、ZeroTier 10.173.250.80/.92 timeout。所有跨机部分**只能设计，不能验**。
- **精馏那步用不用 LLM 没定**：若不用，纯确定性判据（11.3）够不够，需要拿真实 staging 数据试。若用，云端的 LLM 通道**未确认**（云端有门户站，但没查过它有没有模型通道）。
- **云端 wv-merge.mjs 的协议只见过调用点**（wv-sync.ps1:286），没读过实现。要接进去必须先读懂它，否则会撞上 wv-sync.ps1:117-135 那条「协议实现不一致 → 静默把每条都判成冲突」的坑。

### 11.7 结论

**采纳为 P2 目标形态。** 三个动作按依赖排序：

1. ~~本地 P1 闭环~~（已完成：src/dream.mjs + candidate_memory + dream-review + dream-export）
2. **等链路恢复**：读 wv-merge.mjs、确认云端 LLM 通道、在云端建 staging.db
3. **改 dream-export 的输出目标**为云端 inbound（复用 wv-sync 的 slot 形态）

**P1 不做废**：它现在是 P2 的上游，人工门退为兜底。

## 12. Profile 视图：approved 画像域候选的下游（2026-09-22，待确认）

> 缺口：§10 的导出器只服务 `work` / `external_fact`。**画像三域（user_preference / user_fact / style）被批准之后没有下游**——
> 状态变成 approved，然后什么也不发生。这与 §11.5 说的「人工门退为兜底」是同一问题的两面。

### 12.1 三个形态

| | 做法 | 代价 | 契约影响 |
|---|---|---|---|
| **A0（最小）** | **先把 Profile 视图实现出来**，由 observation 构建（`stableFacts` / `preferences`），`user_model` 段改从 Profile 取。**暂不引入「人工确认」概念** | 中：新视图 + composer 候选源改动 + 重建链路 | 无（CONTRACTS §4 原文就是 ObservationRef[]） |
| **A1（快）** | Profile 直接由 `candidate_memory`（approved 画像域）构建，跳过 observation 那一跳 | 小 | **要改契约**：数组类型从 `ObservationRef[]` 变成候选引用 |
| **A2（正）** | `observation` 加 `confirmed_at` / `confirmed_by`（schema v8）；人工批的候选 → 拿它的 evidenceIds upsert observation 并标 confirmed；Profile 仍从 observation 建，多一个 `confirmedOnly` 过滤 | 大：schema v8 + 迁移 | 无 |

**建议：先 A0。** 理由——「画像层不存在」是比「人工确认」更大的缺口：现在 `user_model` 段是 **228 条 evidence 直供**（真人短消息），
而 CONTRACTS §4 定义的 Profile（五数组、可追溯到 session event）**一行实现都没有**。人工确认是建在 Profile 之上的一层，不是它的替代。

### 12.2 A0 的具体形态（待确认后再动代码）

```
输入：observation 表（active）
输出：profile 视图行 —— stableFacts / preferences 两组（+ recentState 暂空，见 CONTRACTS §4「v0.1 启用」）
可追溯：profile item -> ObservationRef -> evidenceIds -> session event（三级回链必须能走通）
重建：rebuild('profile')，与现有 expression 视图同一套机制（src/rebuild.mjs）
注入：composer 的 user_model 候选源从「evidence 直供」改为「profile 行」
```

**风险点（动代码前必须先看的两处）**：
1. **注入预算受 `budget.test` 守护**（AGENTS.md 铁律 5）——改候选源要确认 800 token 配额与三级承诺不回退。
2. **`user_model` 段现在有 228 条 evidence 候选**，换成 profile 之后会骤降。这是**预期**（画像本来就该是几条稳定结论，不是 228 条消息），但要先量出降幅再决定是否接受。

### 12.3 与 §11 的关系

A0 不改变 §11 的云端方案：导出器仍只导 `work` / `external_fact`。
A0 解决的是**另一半**——画像域的 approved 终于有了消费者（进 Profile，再进 `user_model` 段）。

### 12.4 在此之前的一个临时判断

`approved` 这个状态**在 A0 落地前，对画像域是空转的**。两条可选：
- 接受空转，把它当作「人工已确认」的预留标记（数据不浪费，等 A0 来消费）；
- 或暂时不批画像域候选，避免状态语义与行为不符。
