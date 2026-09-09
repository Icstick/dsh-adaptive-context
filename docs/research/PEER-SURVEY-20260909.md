---
id: DOC-RESEARCH-PEER-SURVEY-20260909
status: draft
surveyed_on: 2026-09-09
scope: dsh-adaptive-context（ACP）同类插件与相邻项目同行调研
---

# dsh-adaptive-context 同行调研与可吸纳方法（2026-09-09）

## 0. 调研方法与范围

- **取证方式**：`gh api repos/<owner>/<repo>` 取元数据与实测星数；`gh api repos/<owner>/<repo>/readme -H "Accept: application/vnd.github.raw"` 取 README 原文落盘后逐行读（不用一行描述下结论）；架构/协议细节以 README 正文与仓库内文档路径为准。
- **实测时间**：2026-09-09（星数、pushed_at 均为该次 API 返回）。gh 版本 2.98.0，账号 Icstick，token 具 repo 读权限。
- **学术来源**：arXiv 摘要原文（`arxiv.org/abs/<id>`）抓取，非二手转述。
- **我们现状的引用口径**：本仓库 `AGENTS.md` / `README.md` / `docs/design/*.md` / `docs/DEVELOPMENT-PLAN.md` / `docs/adr/*.md` 与 `src/*.mjs`（只读 grep，未改任何代码）。
- **没做什么**：没有 clone 任何同行仓库、没有读它们的源码实现（只读 README 与其指向的文档路径）；没有跑任何基准复现；没有做撞车/曝光判定（本次目标就是方法吸收）；`letta-ai/letta` 已归档为 landing page，仅作历史参照不计入活跃对标。

## 1. 我们的定位（一句话）

ACP 不是"记得更多"，而是**在每一步模型调用前，决定哪条记忆有资格进入上下文，并留下可审计的理由**——append-only 证据账本 + authority 7 值强制映射 + 有界注入（≤900/1200 tokens/step）。同行多数在做"存储与检索"，我们做的是**记忆的使用许可与披露边界**。

## 2. 同行地图

| 项目 | ★ | 做什么 | 与我们的关系 |
|---|---:|---|---|
| [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) | 105 | typed `ctx.memory` seam + 写审批门（门在 service 内非工具层）+ 冻结快照注入 + memory-protocol v1 适配器注册表 | 最接近的架构对手：它也把"闸门"放在服务层；它的冻结快照正好对上我们的 ACP-B8 |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | 350 | Source + Strategy → Core 校验 → 不可变 View；三层默认（Runtime/Documents/Memory Spaces） | 组合式架构：它的 View 与我们 Composer 是同一位置，但它把 Source/Strategy 做成可替换插件 |
| [Ikalus1988/MisakaNet](https://github.com/Ikalus1988/MisakaNet) | 473 | Git 支撑的失败记忆库，E0–E4 证据分级 + BM25 检索 + 实测增益 | 证据分级的另一维度（验证强度 vs 我们的来源权威）；它是外部知识源，可作 ACP 的 external_information 供给方 |
| [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) | 58 | 主动召回（宿主侧监视）+ 四层记忆 + 四段式 handoff + 水位感知 + 召回审计五级评分 | 与 ACP 最像的"注入治理"路线：它做 A/P/S/H/E 五级召回评审，我们做 use/verify/ignore 三态 |
| [Qinling-Melon-Farmers/dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir) | 25 | BM25 排序召回 + 有界 Hot Memory（900/1200）+ 会话冻结快照 + 生命周期治理 | 预算承诺与冻结快照的同路人；它的"自动蒸馏提醒"是"可观察 vs 静默"的正面案例 |
| [chenzheshushi-commits/dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) | 9 | 零 token 确定性召回（bigram-Jaccard + FTS5 BM25 + RRF）+ 分层审批 + 反膨胀收敛 | 方法密度最高：它的审批分层、两段式处置、per-session 去重都直接可移植 |
| [Asher-2000/dsh-memory-connect](https://github.com/Asher-2000/dsh-memory-connect) | 7 | 时态图谱（valid_from/valid_until + 软取代）+ 信任模型（召回历史按不可信参考注入）+ 可选本地 embedding | 时态真相与信任模型与我们同向；它的"embedding 可选 + 不可达即降级"是我们要守的边界 |
| [GIT121995/dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate) | 3 | CBDC 权威门控（Claim→Belief→Decision→Consumption），每条记忆注入前裁决 use/verify/ignore，≤3 条/1200 字符 | 与我们的 Composer eligibility 直接对标；它的"成本分级 + 健康自诊断自动降级"是我们缺的 |
| [SodaMem/dsh-plugin-sodamem](https://github.com/SodaMem/dsh-plugin-sodamem) | 2 | 每轮自动召回/回灌（非工具调用）+ 证据块带 source=turn 外键链 + 四时间轴 | 它的"来源必须是真实 turn 不是某次聊天"就是我们要的 evidence 指针语义 |
| [Frog755/dsh-hybrid-memory](https://github.com/Frog755/dsh-hybrid-memory) | 1 | L1 冻结快照（MEMORY.md/USER.md）+ L2 FTS5 知识库 + L3 多工具导入 | 冻结快照 + 字符上限的极简实现；中文 2 字滑窗预分词可直接借用 |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 64990 | v3 改成单次 ADD-only 抽取（一次 LLM 调用、无 UPDATE/DELETE）+ 实体链接 + 多信号融合 + 时间推理 | 它的算法转向是"append-only 是对的"的最强外部证据；实体链接是我们缺的一路召回 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 30725 | 双时态 context graph：事实有有效期、旧事实失效不删除、episodes 作为溯源底座 | 与我们"证据即真相、视图可重建"同构；它的 episode 概念可直接借来做溯源渲染 |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 30610 | remember/recall/improve/forget 四操作 + 会话蒸馏 + 图/向量/代码多路检索 | improve 的"会话蒸馏成永久记忆"与我们的 consolidation 同位置，但它把反馈显式建模 |
| [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | 11243 | 统一记忆 API + MemScheduler 异步写入 + 多 Cube 知识库 + L1/L2/L3 技能演化；已官方支持 DSH | 我们已接它作 recall provider；它的异步摄取与多 Cube 隔离值得作为预算外的扩展位 |

## 3. 可吸纳的方法（核心）

### 🔴 P0

#### 1. 蒸馏不得放大来源权威（non-amplification firewall）
- **出处**：arXiv [2607.29167](https://arxiv.org/abs/2607.29167)《Memory Provenance Laundering in LLM Agents: A Non-Amplification Firewall for Persistent Memory》（EMNLP2026 投稿）；配套 [2609.01836](https://arxiv.org/abs/2609.01836)《Agent Memory Is a Surface for Endogenous Authorization Laundering》（EAL-Bench）。
- **它怎么做**：论文把"LLM 在 consolidation 期间把外部观察重写成看似用户历史/工作流支持"命名为 memory provenance laundering——触发词还在，但限制其权威的低信任来源被抹掉；PPMF 的做法是**保留平台维护的 provenance，并让工具调用的动作风险与相关记忆的权威匹配**（高风险动作只接受高权威记忆授权）。EAL-Bench 进一步量化：增量写入下写手为最多 50.2% 的未授权请求伪造出"权威"，一旦伪造存在，执行方 98.6% 会照办；两种护栏（存储权限必须由有效源事件背书 + 有界事件溯源）显著降低泄漏，但都会多拒掉合法动作——存在安全-效用权衡。
- **我们现状**：`src/policy.mjs` 有 authority 7 值与 `assertAuthorityConsistent`（ADR-0002，写入侧）；`observationAuthorities` 默认 `[user_explicit,user_correction]` 是**注入侧**白名单（README 配置表，T2）。但**蒸馏侧没有断言**：`docs/design/CONSOLIDATION.md` §2 只把"Observation 100% 可追溯到 Evidence（provenance coverage）"列为 v0.1 验收 KPI，§6 验收指标未实现为运行时校验；observation 落账时没有"其权威不得高于支持它的证据"的强制检查。
- **建议**：在 `src/consolidate.mjs` 落账前加一条断言——`observation.authority = min(authority of supporting evidenceIds)`，并在 `startupVerify` 里加 provenance coverage 校验（低于 100% 报警不阻断）。

#### 2. 注入集冻结与 per-session 去重（防 prefix 抖动）
- **出处**：[chenzheshushi-commits/dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) README "What's new in v0.5.1"；[PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) README "the snapshot is frozen once per session at first prompt assembly and never changes mid-session"；[dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir) README "Session Snapshot 在会话内冻结注入文本"（`sessionSnapshotMax` 默认 128）。
- **它怎么做**：dsh-evolve 的常驻偏好快照曾用**进程全局** last-key 去重，导致第一段会话注入后，之后每段会话的首轮都被静默抑制；v0.5.1 改成按 session 的 `WeakMap` 键，每段会话首轮都拿到快照，会话内未变化仍跳过（保住 prompt-cache 收益），并补了一个驱动真实 `apply(ctx)` 的双会话回归测试。memoir 与 memento 则直接把快照在会话首轮冻结，`sessionSnapshotMax` 做 LRU。
- **我们现状**：`docs/DEVELOPMENT-PLAN.md` ACP-B8 已登记"C7 注入集稳定性观测（turnover）：相邻 step 注入集去重率/Jaccard"但状态是 planned；`src/composer.mjs` 每 step 重算候选，去重只在**单次调用内**按 id 与 contentHash 做（composer.mjs:307-331），跨 step 没有稳定性约束。
- **建议**：先落地 ACP-B8 的 turnover 上报（`ComposeTelemetry` 已有 admitted/dropped/totalTokens，加一个相邻 step 的 Jaccard 字段），用真实数据决定是否引入会话级冻结。

#### 3. 零 token 确定性召回：RRF 融合而非权重硬加
- **出处**：[dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) README "bigram-Jaccard similarity fused with SQLite FTS5 BM25 through Reciprocal Rank Fusion. No embedding API, no per-turn model call"；[dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir) "中文 2/3-gram + 英文单词 + 代码/路径标识符分词；BM25 文档侧保留真实词频，标题 2.5× 加权"；[dsh-hybrid-memory](https://github.com/Frog755/dsh-hybrid-memory) "FTS5 的 unicode61 不切中文，插件在写入索引前用 2 字滑窗预分词"。
- **它怎么做**：两路异构分数不直接加权求和，而是各自排序后用 Reciprocal Rank Fusion 合并——避免了"归一化尺度不同导致某一路压制另一路"；dsh-evolve 还做了查询长度自适应的阈值，并在 FTS5 不可用时降级为纯 bigram。
- **我们现状**：`src/service.mjs:14` 用 CJK 连续 2 字符窗口做 OR 召回，`src/composer.mjs:60` 的 `lexicalScore` 也是 bigram 重叠比例；**没有 FTS5、没有 RRF**。provider 离线时把 semantic 权重并入 lexical（composer.mjs:41 `LEXICAL_WITHOUT_SEMANTIC`）——这是权重相加，不是秩融合。
- **建议**：ledger-only 路径引入 RRF：对 bigram 重叠分与（若引入）FTS5 BM25 分各出一路排序再融合；保留现有加权公式作为有 provider 时的路径，两路用同一份测试夹具对照。

#### 4. 高权威条目的超配额处理：结构化拒绝而非截断
- **出处**：[PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) README "Bounded and honest. Hard per-track/per-layer character budgets (default user 2000 / agent 4000). A full store fails with a structured error (usage + limit) — never truncated, never auto-compacted."
- **它怎么做**：预算满了返回结构化错误（含 usage 与 limit），**不截断、不自动压缩**——写入方必须自己决定淘汰谁；条目语义因此永不被静默改写。
- **我们现状**：`src/composer.mjs:269-272` 明确"单条最多占本 section 配额的 60%，超出则截断 + 标注可回溯 id"；`src/budget.mjs` 的 `truncateToTokens` 是注入侧最后手段。截断对偏好类文本是危险的：`truncateToTokens` 按 token 数切，条件从句会被切掉——"我不用 tabs，除了这个项目"截断后剩下"我不用 tabs"，语义反转。
- **建议**：对 `user_explicit` / `user_correction` 两条高权威证据改为"整条保留 + 让渡其他 section 配额；仍装不下则整条 drop 并记 audit"，把截断限制在 `single_observation` 及以下。

### 🟠 P1

#### 5. 使用前裁决三态 + 成本分级注入
- **出处**：[GIT121995/dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate) README "成本分级：`use`（放心用）拿全宽，`verify`（待核验）单条最多 `verifyMaxChars` 字符——敢用才配多花"；三种运行模式 `shadow`/`assist`/`enforce`。
- **它怎么做**：每条记忆注入前过 CBDC 门控，输出 use/verify/ignore；verify 级条目按更短字符上限注入（默认 160），滚动窗口（`budgetWindowTurns` 20 轮）内超 `sessionBudgetChars` 就自动跳过 verify；`shadow` 模式只审计零注入，用于灰度。
- **我们现状**：`src/budget.mjs` 只有 section quota 与总预算，`src/composer.mjs` 没有 per-item 决策等级；`observationInjection` 是布尔闸门（README 配置表）。`shadow` 语义我们完全没有。
- **建议**：给 observation 轨加 `verify` 级（渲染加"待核验"标记 + 更短 section 配额），并把 `observationInjection` 扩展为 `off|shadow|on` 三态，shadow 走全量 composer 只记 telemetry 不注入。

#### 6. 健康自诊断 → 自动降级（fail-safe）
- **出处**：[dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate) README "自我诊断：最近反馈里负反馈（harmful/stale/conflict）占比达到 `healthNegativeRateThreshold`（且样本 ≥ `healthMinSamples`）时，自动降级为 `shadow`（零注入）并在 `/memory status` 里红标警示"。
- **它怎么做**：把"使用后反馈"变成注入策略的自愈信号——质量下降时主动闭嘴，而不是继续污染上下文；降级可手动恢复。
- **我们现状**：`src/audit.mjs` 有审计三链，但没有把审计信号接回注入策略；`src/feedback.mjs` 的 T4 是"纠正 → 规则草拟"，不是"使用后反馈 → 健康度"。所以 ACP 目前没有"发现自己最近记错了就自动收手"的机制。
- **建议**：用审计里的 reject/conflict/supersede 计数做一个健康门，超阈值自动把 observation 轨降为 shadow 并写 audit（与建议 5 的三态共用开关）。

#### 7. Citation lock：只许引用真正打开过的证据
- **出处**：arXiv [2608.29606](https://arxiv.org/abs/2608.29606)《Agent Zero Memory: Provenance-Aware Long-Term Memory for LLM Agents》——"every learned item is a provenanced item carrying its origin, timestamp, and evidence pointer, and every answer is read under a citation lock, so it may cite only evidence its reader actually opened; fabrication is structurally excluded and the system abstains rather than guesses"。
- **它怎么做**：三条并行记忆（事件时间线 / 实体-事件图 / 引用锁定的分层文档记忆），检索回合先过 intent gate，再走 source router 与三路并发 agentic 搜索，答案只允许引用真正打开过的证据，宁可不答也不编。
- **我们现状**：`docs/design/CONSOLIDATION.md` §2 已把 ACP 的 `evidenceIds` 映射到 Hindsight 的 "supporting facts + quotes"；`src/service.mjs` 的 `acp_query` 是只读查询面（含读审计）。但注入渲染不强制带 evidence id，模型引用观察结论时没有"必须能指到 id"的结构约束。
- **建议**：observation 注入行尾固定渲染 `evidence=<id>`，并在跨会话引导语里声明"引用即视为已打开该证据"；`acp_query` 返回体已含 id，链路已通，只差渲染侧一行。

#### 8. Intent gate：自足回合不召回
- **出处**：arXiv [2608.29606](https://arxiv.org/abs/2608.29606) "A retrieval turn runs an intent gate (so self-contained turns add no latency)"；[dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir) 的 `autoDistillEvery`/`autoDistillCooldownMin`/`autoDistillMinTools` 三条件 AND 判定；[dsh-hybrid-memory](https://github.com/Frog755/dsh-hybrid-memory) 的触发词表。
- **它怎么做**：用确定性判据先判断"这一轮是否需要外部记忆"，自足回合直接跳过召回——省延迟也省 token；触发词/回合计数/工具调用数都作为判据而非 LLM 判断。
- **我们现状**：`src/composer.mjs` 每 step 全量走四源（ledger / expression / observation / recall provider），3 秒预算（README "agent/pre-step（每轮，3 秒预算）"），没有"这轮不需要"的短路。
- **建议**：先只对 observation 轨加确定性 intent gate（无代词引用、无偏好问句、无 `acp` 触发词 → 跳过），ledger 轨保持每 step 参与，避免误伤显式纠正。

#### 9. 分层自治必须放在冲突扫描之后（结构性保证）
- **出处**：[dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) README v0.5.0 "`autonomous` still forces conflicts and high-importance (imp 3) memories to pending — the tier split sits *after* the conflict/importance scan, so it's a structural guarantee, not a fragile `if`"。
- **它怎么做**：自治等级不是"最后再检查一遍要不要拦"，而是先做冲突/重要度扫描，再把可自治的那部分放行；因此换配置也不会绕过冲突拦截。它还明确"the gate deliberately ignores the model-supplied `kind` field"。
- **我们现状**：`autoPromote` 默认 false、`policyConfig` floors 只允许更严（README 配置表）——方向一致，但风格候选的"高权威/冲突项必须人工"是靠策略参数表达，不是结构位置。`src/candidate.mjs` 的闸门顺序值得复核。
- **建议**：把"冲突项与 user_correction 来源项永不自动晋升"写成候选生成阶段的分流（先于任何策略判定），策略只调节"剩下的那部分"。

#### 10. 实体链接作为第三路召回信号
- **出处**：[mem0ai/mem0](https://github.com/mem0ai/mem0) README "New Memory Algorithm (April 2026)"——`Entity linking`：实体被抽取、嵌入、跨记忆链接以提升召回；`Multi-signal retrieval`：semantic / BM25 / entity 三路并行打分融合。
- **它怎么做**：v3 用一次 LLM 调用做 ADD-only 抽取（无 UPDATE/DELETE），同时抽实体并建链接，检索时三路信号并行打分再融合；报告 LoCoMo 71.4→92.5、LongMemEval 67.8→94.4。
- **我们现状**：`src/consolidate.mjs` 产出的 observation 已有 subject/predicate 键，`src/policy.mjs` 有 claimDomain；但没有实体表，召回只有 lexical（+provider semantic）两路。
- **建议**：用 observation 的 subject 建一张轻量实体表（同 subject 归一化），召回时加一路 entity 匹配分，零新依赖、可单测。

### 🟡 P2

#### 11. 两段式 preview → execute + 原子领取 + 逐目标陈旧检测
- **出处**：[dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) README v0.4.2：`POST /prune/preview` 产出内存计划并返回 `planDigest`，`POST /prune/execute` 消费它；计划注册表用**原子领取**（先同步翻转 consumed 标志再 `await` applyPlan）防双击重放；每个目标带 preview 时的 ETag，execute 时被改动则该目标跳过（其余仍生效）。
- **我们现状**：`/acp rule list|accept <n>|reject <n>` 是单段执行（README T4 节）；`rebuild.mjs` 幂等。批量处置目前只有逐条命令。
- **建议**：未来任何批量动作（quarantine 清理、规则迁移、视图重建批）都走 preview/execute 两段 + digest + 逐目标版本检查。

#### 12. 审计保留期
- **出处**：[dsh-memento](https://github.com/PerryLink/dsh-memento) 配置 `auditRetentionDays`（0 = 永久）；[dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) `.evolve-audit.jsonl` 500 行环形裁剪且写入 fail-open。
- **我们现状**：审计三链 append-only 落 SQLite，**无保留期**（`src/audit.mjs`）；读审计随 `acp_query` 增长（查询全走读审计）。
- **建议**：加 `auditRetentionDays` 配置（默认 0 保持现状），让长期实例可裁剪读审计而不动写审计。

## 4. 印证我们判断的地方

同行独立走到同一条路，说明这些不是我们的偏好而是结构性的：

- **append-only 是主流结论**：mem0 v3 把算法改成"单次 ADD-only 抽取，一次 LLM 调用，无 UPDATE/DELETE；记忆只累积，不被覆盖"（[mem0 README](https://github.com/mem0ai/mem0)）。我们 ADR-0001 在证据层做同一件事，粒度更细（evidence 不可变 + supersede 链）。
- **事实与派生视图分离**：graphiti 把 episodes（原始数据流）作为 ground truth，所有实体/关系都回指 episode（[graphiti README](https://github.com/getzep/graphiti) "Episodes (provenance) ... Every derived fact traces back here"）。我们 `evidence → observation` 的 id 引用是同一形状。
- **闸门必须在服务层，不能在工具层**：dsh-memento 明确记录这条来自 Hermes 的教训——"a gate enforced only in the tool layer is bypassable by late tool injection"，因此它的门放在 `ctx.memory` 的写方法内（[memento README](https://github.com/PerryLink/dsh-memento)）。我们 ADR-0002 的 `assertAuthorityConsistent` 不可绕过是同一防线。
- **不采信模型自报**：dsh-evolve 的审批门"deliberately ignores the model-supplied `kind` field — letting a self-reported label decide its own exemption would be no gate at all"。我们的 authority 由 sourceClass 强制推导（ADR-0002），模型不能自报。
- **历史记忆永不高于当前指令**：memento 的注入快照是"untrusted historical context"；dsh-memory-connect 的信任模型同样"recalled history is injected as an untrusted reference (explicit warning; current instruction always wins)"；dsh-mnemon 写"Historical memory never outranks current instructions"。我们 `crossSessionPolicy: non-instructional` + `session=` 标记 + 一次性引导语是同一决策。
- **检索 ≠ 注入**：dsh-memory-gate 把这一点当第一句立场（"Retrieved ≠ injected"），并在注入前做裁决；我们 COMPOSER.md §3 的 eligibility 前置判定同向。
- **可观察优于静默**：dsh-memoir 明确拒绝静默抓取——"不会静默抓取所有对话。插件在符合条件的回合结束时提醒当前 Agent 归纳"；dsh-memento 拒绝"hidden auto-summarization into model-private state"，compaction 摘要变成待人工批准的 pending proposals。我们的 T4 走"草拟 → 人工审批 → active"是同一条路。
- **预算有界是共识**：memento 每 track×layer 硬字符预算、memoir 900/1200 token、memory-gate ≤3 条/1200 字符、decision-log 2000 字符恒定注入——我们 ≤900/1200 tokens/step 的承诺不是孤例。
- **证据分级的方向一致但维度不同**：MisakaNet 用 E0–E4（社区报告→CI→PR→维护者→生产验证）分级（[MisakaNet README](https://github.com/Ikalus1988/MisakaNet)），衡量的是**验证强度**；我们的 authority 7 值衡量的是**来源权威**。两者互补——external_information 类证据可以借用它的 E 级做二级标注。

## 5. 我们不该学的

- **不要学"全量归档 + 定期蒸馏"的仓库化路线**：dsh-auto-memory 把每日日志、反思、归档全文都留在本地并注入最后一天（[auto-memory README](https://github.com/Aik358/dsh-auto-memory)），dsh-mnemon 更是三层 + 多 Provider。ACP 的 KPI 是"注入得更少但更相关"（COMPOSER.md §1），把存储与检索成本外部化会稀释这一点；我们只做证据账本，不做文档库。
- **不要把 embedding 变成默认依赖**：dsh-memory-connect 需要另起 `embed_server.py`（bge-small-zh-v1.5）、dsh-auto-memory 内置约 130MB 语义层。我们的设计原则是"semantic 是 provider 可选能力，不是 Composer 的硬依赖"（COMPOSER.md §4），默认零模型依赖这条不能松。
- **不要让"使用后反馈"自动改写召回权重**：dsh-memory-gate 的 `helped` 会把当次查询的区分性词项学进触发词。这与我们铁律 2（authority 映射不可绕过）冲突——自动学习触发词等于给某条记忆加了一条不受 authority 约束的旁路。要采纳"健康降级"（建议 6），但不采纳"自动学词"。
- **不要把 `letta-ai/letta` 当活跃对标**：该仓库已归档为 landing page，源码迁往 `letta-ai/letta-code`（[letta README](https://github.com/letta-ai/letta)）。引用它做架构参照会引入过期信息。
- **不要学"压缩成一行摘要"**：dsh-auto-memory 对上下文压缩的批评（"burning a whole book and keeping one line of book report"）我们认同，但它给出的解是"handoff + 全量归档"；ACP 的解是"证据不动、视图可重建"，不要顺手把归档也接进来。

## 6. 落地建议（最多 3 条）

1. **P0-A｜蒸馏非放大断言 + provenance coverage 启动校验**（对应 §3.1）。改动集中在 `src/consolidate.mjs` 落账前一处断言 + `startupVerify` 一处校验，收益是直接封掉论文实测可达 1.000 ASR 的那条路径。
2. **P0-B｜落地 ACP-B8 turnover 上报，用数据决定是否会话级冻结**（对应 §3.2）。`ComposeTelemetry` 已就位，只加一个相邻 step Jaccard 字段与上报；这是"要不要学 memento/memoir 的冻结快照"的前置证据。
3. **P1-C｜ledger-only 路径引入 RRF 融合**（对应 §3.3）。零新依赖、可用现有 test 夹具对照现有加权公式，顺带把 provider 离线时的降级语义从"权重相加"改成"秩融合"。

## 7. 来源清单

抓取日期均为 **2026-09-09**；标注 [原文] = 直接读取 README/摘要原文，[元数据] = 仅 gh API 元数据。

| 来源 | 类型 | 用法 |
|---|---|---|
| https://github.com/GIT121995/dsh-memory-gate （★3） | [原文] README 201 行 | CBDC 门控、成本分级、健康降级 |
| https://github.com/chenzheshushi-commits/dsh-evolve （★9） | [原文] README 259 行 | RRF 召回、分层审批、两段式处置、per-session 去重 |
| https://github.com/Asher-2000/dsh-memory-connect （★7） | [原文] README 390 行 | 时态图谱、信任模型、可选 embedding |
| https://github.com/PerryLink/dsh-memento （★105） | [原文] README 292 行 | 服务层闸门、冻结快照、结构化预算错误、protocol v1 |
| https://github.com/omdsh-dev/dsh-mnemon （★350） | [原文] README 122 行 | Source/Strategy/View 组合架构 |
| https://github.com/Ikalus1988/MisakaNet （★473） | [原文] README 623 行 | E0–E4 证据分级、失败记忆、实测增益 |
| https://github.com/Aik358/dsh-auto-memory （★58） | [原文] README 481 行 | 主动召回、五级召回评审、水位感知、四段 handoff |
| https://github.com/Qinling-Melon-Farmers/dsh-memoir （★25） | [原文] README 243 行 | BM25 + 冻结快照 + 自动蒸馏提醒 |
| https://github.com/SodaMem/dsh-plugin-sodamem （★2） | [原文] README 185 行 | 证据块 source=turn 外键链、四时间轴 |
| https://github.com/Frog755/dsh-hybrid-memory （★1） | [原文] README 114 行 | L1 冻结快照、中文 2 字滑窗 |
| https://github.com/mem0ai/mem0 （★64990） | [原文] README 270 行 | ADD-only 抽取、实体链接、多信号融合 |
| https://github.com/getzep/graphiti （★30725） | [原文] README 712 行 | 双时态事实、episodes 溯源 |
| https://github.com/topoteretes/cognee （★30610） | [原文] README 290 行 | remember/recall/improve/forget、会话蒸馏 |
| https://github.com/MemTensor/MemOS （★11243） | [原文] README 345 行 | 统一记忆 API、异步摄取、L1/L2/L3 演化 |
| https://github.com/letta-ai/letta （★24675） | [原文] README 43 行 | **已归档为 landing page**，仅作历史参照 |
| https://arxiv.org/abs/2607.29167 | [原文] 摘要 | provenance laundering / PPMF 非放大防火墙 |
| https://arxiv.org/abs/2609.01836 | [原文] 摘要 | endogenous authorization laundering / EAL-Bench |
| https://arxiv.org/abs/2608.29606 | [原文] 摘要 | Agent Zero Memory / citation lock / intent gate |
| 本仓库 `AGENTS.md` / `README.md` / `docs/design/{COMPOSER,GOVERNANCE,CONSOLIDATION}.md` / `docs/adr/000{1,2,3}-*.md` / `docs/DEVELOPMENT-PLAN.md` | 一手 | 我们现状引用 |
