# dsh-adaptive-context

DeepSeek Harness (dsh) 的 **AdaptiveContextPlane (ACP)** 上下文控制面插件——带治理的长期记忆系统。

> **设计铁律**
>
> Evidence is truth; views are rebuildable.
> Confidence is not authority. Retrieval does not imply disclosure.
> Learning does not imply promotion. Memory does not own work continuity.

## 这是什么

ACP 把"该记住什么、以什么权威记住、何时注入、以多少预算注入"变成**可审计、可回溯的系统行为**，而不是模型随机的记忆冲动。

- **记住什么**：append-only 证据账本，每条写入带 7 值 authority（权威）× 6 值 claimDomain（领域）的确定性声明；Write Guard 在写入时拦截 secret / PII / prompt-injection
- **何时注入**：每 turn 的 `agent/pre-step` 按 section quota 预算（MVP 承诺 ≤900 tokens/step）注入最相关的证据，带来源标签，标记为 untrusted historical data
- **怎么演化**：后台 consolidation 从证据派生 Observation（浓缩认知）；表达风格候选经**人工审批门**或**策略护栏自动提升**后才能进入行为层

## 核心能力

| 能力 | 说明 |
|---|---|
| **Evidence Ledger** | append-only SQLite 证据账本；幂等（同一事件重放只落一条）；7 authority × 6 claimDomain 资格矩阵 |
| **Governance** | Write Guard（secret/PII/prompt-injection 确定性扫描）+ Read Guard（scope/state/资格矩阵过滤）+ 用户权利（inspect/export/correct/release/redact/delete/rollback） |
| **Context Composer** | pre-step 注入；lexical + semantic 双通道排序（MemOS 等 recall provider 提供语义分）；self-echo 过滤 + 内容级 dedup；section quota 预算 |
| **User Model** | user_fact / user_preference / work / style / experience / external_fact 六域显式建模，explicit-only（不做 LLM 推断的隐式画像） |
| **Background consolidation** | turn/end 后台队列（不阻塞热路径）；节流（≥10 条未消化证据或 ≥5 turn）；LLM 派生 Observation（失败自动规则兜底）；同键冲突 supersede + lineage |
| **Temporal truth** | 证据带 valid_from/valid_until；`recall(validAt=过去)` 双视图；superseded 证据在旧时点仍可召回（完整旅程） |
| **Expression promotion** | style 候选 → 人工审批门（approval 面板）或 policy 护栏自动提升（floors 不可降）；五态状态机（proposed/promoted/rejected/superseded/rolled_back）+ materialized view |
| **Provider routing** | recall provider 注册表（多源并行召回 + 独立超时 + fail-open）；LLM 任务路由（consolidation 等任务可配 provider/model + fallback 链） |
| **Audit & export** | 全操作审计（op/actor/reason/payload 可查询）；JSONL 全量导出/导入（evidence/observation/candidate/audit）；视图可重建（checksum 校验） |

## 工作原理（数据流）

```text
DSH session 事件
  │  session/event（agent / inbox / spliced）
  ├─→ extract → Write Guard → evidence 表（append-only，幂等）
  │
  │  agent/pre-step（每 turn，≤3s 预算）
  │    ├─ ledger 候选（Read Guard 过滤 + 资格矩阵）
  │    ├─ recall providers 候选（并行召回，fail-open）
  │    └─ Composer：排序 → self-echo 过滤 → 内容去重 → 预算打包 → 注入
  │
  └─ turn/end → consolidation 队列（fire-and-forget，不阻塞下一 turn）
        ├─ 节流达标 → LLM 派生 Observation（失败规则兜底）
        ├─ 同键冲突 → supersede + lineage
        └─ style 候选 → policy 评估 → 自动提升（护栏内）或人工审批门
              └─ candidate 状态机 → materialized view（pre-step 注入时读取）
```

## 安装

在你的 dsh profile（如 `~/.dsh/profiles/web/`）中做三步：

**1. `package.json` 加依赖**（link 指向本仓库）：

```json
{
  "dependencies": {
    "dsh-adaptive-context": "link:D:/path/to/dsh-adaptive-context"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-adaptive-context"]
    }
  }
}
```

**2. `cordis.patch.yml`（profile 根目录）挂载并配置**：

```yaml
- id: adaptive-context
  name: dsh-adaptive-context
  config:
    ledgerDir: C:\path\to\acp-data    # 必须显式（不依赖 DSH_HOME 环境变量）
    consolidationProvider: your-provider # 可选：启用 LLM 派生
    consolidationModel: your-model
```

**3. 安装并重启**：

```bash
cd <profile 目录>
pnpm install
# 重启 dsh
```

> ⚠️ 注意：`cordis.patch.yml` 中**同 id 的多个 entry 后者整体覆盖前者**（不是合并）——adaptive-context 只写一块。

## 配置（全部字段）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ledgerDir` | string | **必填** | 数据目录（`acp-ledger.db` 所在）。必须显式指定，不要依赖 DSH_HOME 环境变量 |
| `hotTokens` | number | 300 | 热路径注入预算（tokens/step 承诺上限的一部分） |
| `recallLimit` | number | 20 | 每 provider 召回候选上限 |
| `targetDomain` | enum | work | 默认注入目标领域 |
| `debug` | boolean | false | 调试日志 |
| `memosBaseUrl` | string | http://127.0.0.1:18801 | MemOS 后端地址（recall provider） |
| `memosEnabled` | boolean | true | 启用默认 MemOS provider |
| `recallProviders` | array | 由 memosBaseUrl/memosEnabled 派生 | recall provider 注册表：`[{id, enabled, timeoutMs, weight, baseUrl?}]`；显式 `[]` = 不启用任何 provider |
| `llmTasks` | object | consolidation 由 consolidationProvider/Model 派生 | LLM 任务路由：`{task: {provider, model, fallback?: [{provider, model}], timeoutMs, maxTokens}}` |
| `consolidationMinEvidence` | number | 10 | 节流：未消化证据达到该数量触发 consolidation |
| `consolidationMinTurns` | number | 5 | 节流：距上次 consolidation ≥ 该 turn 数触发 |
| `consolidationProvider` | string | — | LLM 派生的 provider（缺省走规则兜底） |
| `consolidationModel` | string | — | LLM 派生的 model |
| `consolidationMaxTokens` | number | 1024 | 派生输出上限 |
| `consolidationTimeoutMs` | number | 30000 | 派生调用超时 |

## API（`ctx.acp`）

| 方法 | 说明 |
|---|---|
| `append(input)` | 写入证据（过 Write Guard + 资格矩阵；重复内容幂等返回已存在 id） |
| `get(id)` / `inspect(id)` | 读取单条（inspect 含治理裁决细节） |
| `setState(id, state, opts)` | 状态迁移（active/quarantined/superseded/redacted） |
| `recall({query, scopeId, targetDomain, validAt, allowSuperseded, maxTokens})` | 召回（Composer 最小入口；validAt 支持历史视图） |
| `history(id)` | 证据演进 lineage（supersede 链） |
| `stats()` | 账本统计 |
| `export(scopeId, {format, streams})` | 导出（json / jsonl；evidence/observation/candidate/audit 流） |
| `import(jsonlText)` | 导入（evidence 按 contentHash 幂等） |
| `correct(input)` | 用户纠正：写入 user_correction 证据 + 确定性 supersede 旧证据 |
| `release(id)` / `rollback(id)` / `redact(id)` / `delete(id)` | 用户权利操作（quarantine 释放 / 回滚 / 脱敏 / 删除） |
| `audit({op, scopeId, actor, limit})` | 审计查询 |
| `rebuild(viewName)` | 手动重建 materialized view（views are rebuildable） |
| `exportActive(scopeId)` | 只导出 active 证据（便捷方法） |

## 数据位置与备份

- 全部数据在 `ledgerDir` 下：`acp-ledger.db`（SQLite，WAL 模式）——evidence / observation / candidate / candidate_events / audit 五张表
- materialized view 在 `ledgerDir/views/` 下（可随时重建，checksum 校验）
- **备份/迁移**：`export`（JSONL）→ 新环境 `import`，evidence 按 contentHash 幂等合并
- **数据是你的资产**：卸载插件不会删除数据；重装即恢复

## 卸载

1. 从 profile 的 `package.json` dependencies 移除 `dsh-adaptive-context`
2. 从 `dsh.profile.bundles` 移除包名
3. `pnpm install` 后重启 dsh

卸载不删除 `ledgerDir` 数据；如需彻底清除，手动删除该目录。

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 注入不生效 | 确认 `cordis.patch.yml` 的 `ledgerDir` 显式配置（DSH_HOME 环境变量不可靠，缺省可能落 cwd） |
| consolidation 不产出 Observation | 未配 `consolidationProvider/consolidationModel` → 走规则兜底（仍会产出，但精度低）；或证据积压未达节流阈值（≥10 条或 ≥5 turn） |
| 审批面板看不到 promotion 请求 | approval 请求由下一个 turn 的 pre-step 发起（后台任务无 agent 引用）；确认会话有 GUI 面板渲染 |
| 启动报 llm purpose 错误 | 内部使用 `purpose:'compaction'`（dsh-llm 枚举仅 compaction/session-title）——如果自行扩展了 llmTasks，确认不覆盖此语义 |
| 日志看不到任何输出 | 设 `debug: true`；关键操作日志前缀 `[acp]`，可 grep |

## 开发

```bash
node test/<file>.test.mjs   # 单文件直跑（沙箱环境 node --test 递归受限）
```

设计文档见配套仓库 **acp-docs**（ARCHITECTURE / CONTRACTS / COMPOSER / GOVERNANCE / CONSOLIDATION / EXPRESSION / PROVIDERS 等）。

## License & 致谢

MIT License。参考项目致谢见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)（MemOS / Hindsight / personagent / DeepSeek Harness）。
