# ACP 摄入面加固（草案）· 2026-09-22 · W 机

> **状态：只读调研产物，未改任何代码。** 分支 
> `fix/acp-query-observation-order` @ `4c43b66`（本轮另有两个已完成的独立改进，见 §0.2）。
> 所有数字来自 `node scripts/ledger-audit.mjs`（只读）+ 代码行号，可当场复跑。

## 0. 前提

### 0.1 为什么动"摄入面"而不是"清账本"

- 账本 append-only：`docs/adr/0001-sqlite-append-only-ledger.md` + `AGENTS.md` 铁律 1。已写入的 evidence 永不修改/删除。
- 更硬的一条：evidence 是 observation 的**溯源权威链**。`src/store.mjs` `resolveObservationAuthority()` 按 observation 的 `evidenceIds` 反查 evidence.authority 再聚合（取最弱），删 evidence = 断链 + 权威退化到 `single_observation` 兜底。
- 反证在先：2026-08-30 A 机那次修整是 **255 条 → quarantined**，不是删除（weaver `project/wv-20260830-004`，验证态 active 134 / quarantined 258 / superseded 3）。
- 但只清存量不堵入口等于白做：本机账本是 2026-09-16 前后重建的（audit 表首行 `rebuild: startup verify mismatch auto rebuild`），此后从未清过；而下面三条口子至今仍在往里写。

### 0.2 本轮已完成的独立改进（不在本草案范围）

| 提交 | 内容 |
|---|---|
| `ab95bed` | `fix(tools)`：acp_query 的 observation 面按 `observedAt` 倒序（原为固定返回最老 N 条） |
| `4c43b66` | `feat(scripts)`：新增只读账本体检 `scripts/ledger-audit.mjs`（+5 例测试） |

验证：`node --test "test/*.test.mjs"` 452/452 · `oxlint` 0/0 · `depcruise` clean · 已重启实证工具面生效。

## 1. 实测基线（复跑命令）

```
node scripts/ledger-audit.mjs --dir C:\Users\NeoVox\.dsh\acp
```

```
evidence 2378 条（全部 active）· 重复 16 组 / 89 条冗余
域   experience 2146 · user_fact 216 · user_preference 16
蒸馏 水位 2026-09-22T03:10:25Z · 队列 1 条 · 永久跳过 2146 = 90.2%
召回窗（20+20）  跨会话 20 条中 agent 自述 20 条
注入分档  memory 22 条 2279 tok / 290（786%）· user_model 5 条 191 tok / 800（24%）
```

## 2. 三条口子

### 口子 A —— `assistant/` `tool/` 前缀分支不看来源（最大的一条）

**代码**：`src/extract.mjs:107`

```js
if (type === "agent/inbox/spliced") { ...白名单... }   // L95-106，只有 kind=user 放行
return WORTHY_PREFIXES.some((p) => type.startsWith(p)) && !!text   // L107 兜底分支
```

`WORTHY_PREFIXES`（L18）= `user/ assistant/ tool/ turn/ agent/inbox/spliced`。**兜底分支只看事件类型前缀，不看 `data.source.kind`，也不看会话来源。**

对比 `src/extract.mjs:167-170`：那里有一段"防插件/系统以 user 角色 append 消息冒充真实用户"的防御——但它只影响 `eventKindOf()` 的归类（进而影响 sourceClass），**不影响 `isEvidenceWorthy` 的放行**。

**这条口子与代码自己的原则直接冲突**：`src/extract.mjs:96-98` 写着

> 模型输出不是"证据"——agent 自产内容全量入账曾致 5200+/6062 条（85.8%）账本噪声。

但那句话只兑现了一半：`agent/inbox/spliced` 里 `kind=assistant` 的确实被 7f12557 挡住了，**以 `assistant/message` 事件形态到来的模型输出仍然全量入账**。

**实测（2026-09-21T14:47:56Z = 本机 pull 到 7f12557 的时刻，按 observed_at 分界）**：

| 区间 | agent 自产 | 用户消息 | agent 占比 |
|---|---|---|---|
| pull 之前 | 1914 + 63 | 191 + 14 | 90.6% |
| **pull 之后** | **169 + 4** | **27 + 2** | **85.6%** |

修完之后新进来的，仍然是 **85.6% 的模型自产**——和注释里那次"85.8%"几乎同一个数。白名单挡住的只是入口之一。

**按会话形态拆分**：

| 会话 | 条数 | 构成 |
|---|---|---|
| 主会话（`session-<uuid>`，1986 条） | 1756 条 agent_authored = **88.2%** | 我的每轮回复与工具输出 |
| 子代理会话（裸 uuid，76 个会话，325 条） | 258 条 `single_observation/experience`（**过读矩阵，可注入**） | 子代理的 assistant 独白（"已发给父代理。以下是完整报告…"） |
| 同上 | 67 条 `agent_inference/experience`（读矩阵全 ✗，不可注入） | 父任务书派发（2026-08-30 决策 D2-A：记录但隔离） |

**影响面**：这是"永久跳过蒸馏"那 2146 条的主体（`isConsolidationSkippable` = agent_authored + experience，`src/consolidate.mjs:41-44`）。它们不进蒸馏、但**进 20+20 召回窗**，把真正的记忆挤出去——实测跨会话 20 条里 20 条是 agent 自述。

### 口子 B —— `acp.append` 是公开服务面，没有摄入闸门

**代码**：`src/service.mjs:49-60`

```js
append(input) {
  const verdict = writeGuard(input)        // 只查 5 件事：sourceClass↔claimDomain 白名单、
  ...                                      // ≤8000 字、secret 正则、injection 正则、sensitivity
}
```

`isEvidenceWorthy()` 只在 `src/index.mjs:544` 的 session/event 路径上被调用。**任何插件只要拿得到 `ctx.acp`，就能直写账本，绕过全部摄入判据。**

**实例**：`dsh-context-maid/src/archiver.mjs:208`

```js
appendArchive(acp, "【maid 压缩归档】" + summary, { sessionEventId, maidCompactionId })
```

声明 `agent_authored / single_observation / experience`（同文件 L85-91），**恰好落在 writeGuard 的放行白名单里**（`src/governance.mjs:36`）→ `decision=allow` → `state=active`。

**实测**：69 条；长度**全部恰好 1811 字**（`summary.slice(0, 1800)` + 11 字前缀），整齐到可以当指纹；`observed_at` 从 2026-09-17T05:19 一直到 2026-09-22T03:07。`source_ref` 里带 `maidCompactionId` 的只有这一家——**目前唯一的第三方直写方**。

另有 26 条 `Background subagent … finished` 横幅同样是 `single_observation/experience`（可注入）。

**旁注（设计/实现不一致，供上游参考）**：`archiver.mjs:4-5` 的设计注释写"摘要即证据：每次 FOLD 的 checkpoint 摘要成为 ledger 一条 **observation**"，但 L83-93 实际调的是 `acp.append`（写 **evidence** 表）。observation 只能由 `src/store.mjs:457` `upsertObservation` 写入。若按设计意图落 observation，它天然进不了 20+20 的 evidence 召回窗。

### 口子 C —— `session_type` 恒为 `root`，子代理身份没落库

**代码**：`src/index.mjs:545-552`，同一个 `toEvidenceCandidate` 调用里：

```js
sessionType: event.sessionType ?? "root",                                  // L549  <- 读事件上不存在的字段
subagent: config.subagentDowngrade === true && session?.header?.origin === "subagent",  // L551  <- 读对了
```

`sessionType` 读的是**事件**上的 `sessionType`；真正的子代理标记在 `session.header.origin`。同一个 handler、同一次调用，一个判断对、一个判断空转。

**实测**：`SELECT session_type, COUNT(*) FROM evidence GROUP BY 1` → **2400 条全部 `root`，`subagent` 零条**。而 `SESSION_TYPES`（`src/constants.mjs:75-79`）明确定义了 `root / subagent / fork`。

**取值域已核实**：`D:/deepseek-harness/docs/persistence-catalog.md:4607` 与 `:5629` 都把 session header 的 `origin` 标为 `optional`、**唯一取值 `"subagent"`**。所以映射是确定的：`origin === "subagent" ? "subagent" : "root"`；`fork` 在这条链路上不可达（UI 侧的 fork 子会话同样带 `origin: "subagent"`，见 `packages/client/ui-workspace/tests/tree.client.spec.ts:237`）。

**影响面**：现在任何"按会话类型过滤"的想法都无效——读侧拿不到这个信息，只能退回 authority 矩阵，而口子 A 那 258 条恰恰是 `single_observation`，与真实观察无法区分。**这是 A 的前置条件。**

## 3. 候选修法（按"先能区分、再谈过滤"排序）

### C（先做）—— 把子代理身份正确落库

- **改哪**：`src/index.mjs:549` → `sessionType: session?.header?.origin === "subagent" ? "subagent" : "root",`
- **性质**：纯元数据修正。**不改任何已经写入的行**（append-only 不受影响），只让新行带上真实来源。不新增 authority 值（`AGENTS.md` 铁律 3 不动）。
- **影响面**：只有新行；`ledger-audit` 的 `[规模]` 段可立刻看到变化。
- **回滚**：单行 `git revert`。
- **测试**（可行性已核实）：`test/` 下**没有**直接驱动 `session/event` handler 的用例——grep `session/event` 只命中 `src/index.mjs:534`，`test/` 里 20+ 处 `createConsolidator` 都不走插件装配。所以不要搭插件 harness：把判定抽成**纯函数**，与既有的 `sourceClassOf` / `eventKindOf` 同款——在 `src/extract.mjs` 加 `sessionTypeOf(session)`（`session?.header?.origin === "subagent" ? "subagent" : "root"`），`index.mjs:549` 改调它，测试直接断言该函数。改动面两处，测试零 harness 成本。

### A —— 兜底分支按来源收口

仓库既有原则已经把方向定死了（`extract.mjs:96-98`「模型输出不是证据」+ 7f12557 的 commit message「取 fail-closed：账本 append-only，误入的噪声删不掉；漏掉的真内容在会话日志里仍有原文，可由 turn/end consolidation 事后补捞」）。所以：

- **A1（推荐）**：`assistant/` 与 `tool/` 前缀**不摄入模型正文**——只保留 `user/` 与 `turn/`（turn 事件本身无正文）。判据点放在 §2 口子 A 的 L107，做法与 7f12557 同构：把"按前缀放行"换成"按可摄入来源放行"。
  - 影响面（实测）：主会话 1756 条 + 子代理 258 条，即**新流量的 85.6%**；存量不动。
  - 代价：`tool/result` 的内容也不再入账——但 `external_information` 那一档本来就是"外部文档/工具输出补充工作经验"的设计意图，收掉要单独论证。**建议 A1 先只收 `assistant/`，`tool/` 单列一条待议。**
- **A2**：不动摄入，改读侧——候选池查询（`src/index.mjs:583-584`）排除子代理会话。依赖 C。只挡子代理那 258 条，主会话的 1756 条照旧。覆盖面小，但零摄入语义变更、风险最低。
- **A3**：给子代理会话的 evidence 落 `quarantined`（`state` 层）。可行但语义别扭——quarantine 是"可疑"，子代理独白不是可疑，是无关。

### B —— 给 `acp.append` 补闸门

- **B1**：在 `src/service.mjs:49` 的 `append` 里补一道摄入判据（`isEvidenceWorthy` 或同构的最小判据）。**这会改公共契约**：`agreements` 里 `append` 的说明是"写入证据（过写入闸门 + 资格矩阵）"，一切现有调用方都受影响。需要先想清楚"服务面该不该承担摄入判据"。
- **B2**：在 maid 侧关掉归档（`archiver.mjs:190` 已有 `opts.enabled !== false`）。**动的是另一个仓库**，不是本仓。
- **B3**：在 `writeGuard` 里加"已知模板前缀 → quarantine"。启发式、脆、会在上游模板变化时静默失效。**不建议。**

## 4. 不建议的做法

- **删 evidence**：断 observation 溯源链（§0.1），且违反 append-only 铁律。
- **直接跑 `scripts/t25-cleanup-action-flow.mjs`**：该脚本 L2 写死 `C:\Users\Administrator\.dsh\acp\acp-ledger.db`（A 机），`KEEP` 集是 A 机那 13 个 observation id，且没有 `--dir`。在本机跑要么报错、要么指错库。要用得先参数化。
- **现在动 `sectionQuota`**：实测 user_model 24% / memory 786%，但样本是**单会话的 29 条池**。先攒长会话样本。

## 5. 验收口径

任何一条改动落地后，跑同一套命令对照：

1. `node scripts/ledger-audit.mjs --dir <ledgerDir>`——看 `[摄入面]` 与 `[注入分档]` 两段；
2. `node --test "test/*.test.mjs"` + `npx oxlint` + `pnpm depcruise`（`AGENTS.md` 全部验证）；
3. 新流量的 agent 自产占比（当前 85.6%）应显著下降；
4. 跨会话 20 条召回窗里 agent 自述的占比（当前 20/20）。

## 6. 定案（2026-09-22，用户拍板）

| 项 | 决定 | 落地 |
|---|---|---|
| C（session_type） | **直接做** | `extract.sessionTypeOf()` + `index.mjs` 接线 |
| A | **取 A1**（只收 `assistant/`） | `WORTHY_PREFIXES` 移除 `assistant/`；`tool/` 暂留待议 |
| B | **取 B1**（append 补闸门） | `service.mjs`：未声明 `ingest` 的直写一律 `quarantined` |

B1 的影响面已核实：全机 16 个已安装插件里，只有 `dsh-context-maid` 调用 `ctx.acp`（`rg -l` 零其它命中），
所以第三方直写方目前仅一家。落地后 maid 的归档**仍然记录**（不丢审计），但缺省落 `quarantined`、不注入；
若确认要可召回，应改走 `upsertObservation`（与其 design.md 的原意一致），而不是放宽闸门。

## 7. 遗留待拍板

3. **`subagentDowngrade` 的默认值安全网**（2026-09-22 写 e2e 用例时暴露）：`src/index.mjs` 里
   `config.subagentDowngrade === true` 没有 `?? true` 兜底，而同文件其它配置读法都带了
   （`startupRebuild ?? true`、`recallLimit ?? 20`、`crossSessionPolicy ?? 'non-instructional'`）。
   生产环境由宿主套用 Config schema 默认值所以目前是 true；一旦某个宿主/直调路径没套默认值，
   子代理父任务书会被静默记成 `user_explicit`（本轮的 e2e 用例首次运行就是这么挂的，被断言抓住）。
   一行改动即可加安全网，但属于本轮授权范围外，登记待定。

1. **A1 的边界**：是否连 `tool/result` 一起收？（`assistant/` 建议直接收，`tool/` 建议单列。）
2. **B 的归属**：`acp.append` 要不要承担摄入判据——这是公共契约变更，且 maid 侧还有第二种解法（B2）。

（C 不需要拍板：它是纯元数据修正，唯一成本是补一个 handler 级测试。可以直接做。）
