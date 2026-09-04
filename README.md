# dsh-adaptive-context

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness (dsh) 的 **AdaptiveContextPlane (ACP)** 插件——带治理的长期记忆系统。

> **设计铁律**
>
> 证据即真相；视图可重建。
> 置信度不是权威；检索不等于披露。
> 学到东西不等于可以改变行为；记忆不负责替你把活干完。

## 为什么需要它

用过 agent 的人大概都经历过这几件事：

- **忘了说过什么**。上周明明告诉它"配置和代码分开放"，这周它又混在一起，你只好再说一遍。
- **不敢让它记**。有些"记忆"系统什么都往提示词里塞，一句话可能来自某个不可靠的网页，却被当成你的偏好，从此每个会话都被它影响。
- **改不回来**。发现它记错了，但不知道错在哪、谁记的、怎么改。只能手动翻文件，或者干脆把记忆清空重来。

ACP 想解决的问题很简单：**让记忆像账本一样清楚**。每一条都有来源、有权威、有生效时间；写入要过闸门，注入有预算，行为变化要经审批。你可以随时查它记了什么、为什么这么记、改没改过。

## 一个简单的例子

假设你叫小林，最近在用 dsh 写一个自动化脚本项目。

**第一天**。你对 agent 说："记得我喜欢把配置和代码分开。"这句话被 ACP 记成一条用户事实证据——来源是你，权威是明确声明，领域是用户事实。之后你换了台机器、开了新会话，agent 自动把这条证据带进上下文，你不用重新交代。

**第二周**。你发现 agent 生成的代码一直用 2 空格缩进，皱眉说："都说了，用 4 空格。"这句话以"用户纠正"的身份写入，同时把之前那条相反的旧证据标记为已取代。从这一秒起，注入的只会是新偏好。旧的那条还躺在账本里——它记录了你改主意的完整过程，但不再生效。

**一个月后**。你想换一台服务器，打开导出功能，一条 JSONL 把全部证据带走；新环境导入，一条不少。想查账？审计记录里谁记的、什么时候、为什么，全都有。

## 核心能力

| 能力 | 说明 |
|---|---|
| **证据账本** | 只追加、不修改的 SQLite 账本；同一事件重放只会落一条；每条证据声明权威（7 级）与领域（6 类），资格矩阵决定谁有资格进入哪个领域 |
| **治理** | 写入闸门（写入时拦截密钥、隐私、提示注入）+ 读取闸门（作用域/状态/资格过滤）+ 用户权利（查看/导出/纠正/释放/脱敏/删除/回滚） |
| **上下文编排** | 每轮对话的 pre-step 注入；文本相关 + 语义相关双通道排序（MemOS 等记忆源提供语义分）；自动排除本轮的自我回声、内容级去重；按区块配额控制注入量 |
| **用户模型** | 用户事实/偏好/工作/表达风格/经验/外部事实六个领域，全部显式建模——不做偷偷摸摸的推断画像 |
| **后台沉淀** | 每轮结束后台运行：证据积压到一定量才触发（不拖慢对话）；LLM 提炼观察结论——**失败不推水位、下轮重试同批**（P0-1，避免"失败批被永久标记已消化"），仅 LLM 完全不可用时走规则兜底；同键冲突标记取代并保留演化链 |
| **时间真相** | 证据带生效起止时间；可以查"上个月的视图"；被取代的证据在旧时点依然可见——完整旅程，不是覆盖 |
| **表达风格晋升** | 风格候选要么过人工审批门，要么满足策略护栏才自动生效（最低门槛不可调低）；五态状态机 + 物化视图，随时可回滚 |
| **多源路由** | 多个记忆源并行召回，各自超时、互不拖累；LLM 任务可按用途配不同模型，主路挂了自动走备路 |
| **审计与导出** | 所有关键操作留痕（谁/何时/为什么/附带数据）；JSONL 全量导出导入（证据/观察/候选/审计）；视图可一键重建并校验 |

## 工作原理

```text
DSH 会话事件
  │  session/event（agent / inbox / spliced）
  ├─→ 事件归一 → 写入闸门 → 证据表（只追加，幂等）
  │
  │  agent/pre-step（每轮，3 秒预算）
  │    ├─ 账本候选（读取闸门过滤 + 资格矩阵）
  │    ├─ 记忆源候选（并行召回，故障不阻断）
  │    └─ 编排：排序 → 去回声 → 内容去重 → 预算打包 → 注入
  │
  └─ turn/end → 沉淀队列（不阻塞下一轮）
        ├─ 积压达标 → LLM 提炼观察（失败规则兜底）
        ├─ 同键冲突 → 标记取代 + 演化链
        └─ 风格候选 → 策略评估 → 护栏内自动晋升 或 人工审批门
              └─ 候选状态机 → 物化视图（pre-step 注入时读取）
```

## Agent 安装指南（面向自动化装配）

> 给需要在本机 dsh 装配本插件的 agent/脚本读；人工安装见下一节。
> 三条硬约束：① 数据目录必须显式配置；② pnpm install 前先停 dsh（Windows
> native DLL 锁）；③ 同 id 的 patch 条目是整体覆盖，不要重复插。

**1. 定位 profile**：`<DSH_HOME>/profiles/<profile>/`（例 `C:\Users\<you>\.dsh\profiles\web`）。
先读该目录 `package.json`：若没有 `dsh.profile.bundles` 键，说明 profile 未初始化，
先 `dsh plugin --profile <profile> list`（或人工建 package.json）再继续。

**2. 添加依赖**（二选一）：

```bash
# A. GitHub 源（远端安装推荐）：CLI 自动把声明 dsh.bundle 的包加入 dsh.profile.bundles
dsh plugin --profile <profile> add github:Icstick/dsh-adaptive-context
# B. 本地开发：profile package.json dependencies 加 "dsh-adaptive-context": "link:<绝对路径>",
#    并在同文件 dsh.profile.bundles 数组追加 "dsh-adaptive-context"
```

⚠️ `dsh plugin add` 只装依赖并 reconcile bundles，**不会写配置条目**——第 3 步必须做。

**3. 写配置**：编辑 profile 根 `cordis.patch.yml`（无则新建）：

```yaml
- id: adaptive-context
  name: dsh-adaptive-context
  config:
    ledgerDir: C:\path\to\acp-data   # 必填：账本目录绝对路径；DSH_HOME 环境变量不可靠
    # 可选：consolidationProvider/Model——配了才有 LLM 沉淀，不配走规则兜底
```

**4. 安装并重启**：停 dsh → profile 目录 `pnpm install` → 重启 dsh。

**5. 验证**：
- 数据：`<ledgerDir>` 下出现 `acp-ledger.db` 与 `views/`
- 生效：新会话 pre-step 注入出现 `[acp:...]` 前缀条目（如 `[acp:user_input | id=ev_...]`）

**故障速查**：不注入/不沉淀 → 检查 ledgerDir 显式且可写；boot 报 duplicate loader
entry → patch 里同 id 插了两遍；Web 设置无配置卡片 → 源码形态需先跑
`node scripts/build-client.mjs` 生成 client bundle。

## 安装
> **GitHub 一键安装**：`dsh plugin --profile <name> add github:Icstick/dsh-adaptive-context`
> （bundle patch 会自动挂载 adaptive-context 条目）。装完后仍需在 profile 的
> cordis.patch.yml 给该条目补 `config.ledgerDir`（数据目录必须显式）并重启；
> 完整三步与字段说明见下。


在 dsh 的 profile 目录（比如 `~/.dsh/profiles/web/`）做三步：

**1. package.json 加依赖**（link 指向本仓库）：

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

**2. cordis.patch.yml（profile 根目录）挂载并配置**：

```yaml
- id: adaptive-context
  name: dsh-adaptive-context
  config:
    ledgerDir: C:\path\to\acp-data    # 必须显式写，别指望 DSH_HOME 环境变量
    consolidationProvider: your-provider # 可选：开了才有 LLM 提炼
    consolidationModel: your-model
```

**3. 安装并重启**：

```bash
cd <profile 目录>
pnpm install
# 重启 dsh
```

> 注意：cordis.patch.yml 里**同一个 id 的多个条目，后者整体覆盖前者**（不是合并）——adaptive-context 只写一块。

## 设置页配置卡片（v0.1.1+）

- 位置：DSH Web **设置 → 插件 → 插件配置**（`adaptive-context` 卡片）
- 机制：host 侧注册 settings namespace（`adaptive-context`），client bundle（`lib/client.js`，
  由 `node scripts/build-client.mjs` 生成）注册设置卡片；保存写入 settings.yaml
- 生效语义：**保存后重启生效**（apply 时 settings 值覆盖 cordis Config，未配置字段回退 Config/默认值）
- 字段：ledgerDir / hotTokens / recallLimit / targetDomain / crossSessionPolicy /
  subagentDowngrade / memosEnabled / memosBaseUrl / consolidationProvider /
  consolidationModel / autoPromote / debug
- client 依赖：react（DSH 预加载）+ @deepseek-ai/dsh-client-ui-slots +
  @deepseek-ai/dsh-client-ui-settings（client module table 提供，无需安装到项目依赖）

## 配置（全部字段）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ledgerDir` | string | **必填** | 数据目录（acp-ledger.db 所在）。必须显式指定，DSH_HOME 环境变量不可靠 |
| `hotTokens` | number | 300 | 热路径注入预算（tokens/轮） |
| `recallLimit` | number | 20 | 每个记忆源的召回候选上限 |
| `targetDomain` | enum | work | 默认注入目标领域 |
| `debug` | boolean | false | 调试日志 |
| `memosBaseUrl` | string | http://127.0.0.1:18801 | MemOS 后端地址（作为记忆源） |
| `memosEnabled` | boolean | true | 启用默认的 MemOS 记忆源 |
| `recallProviders` | array | 由 memosBaseUrl/memosEnabled 推出 | 记忆源注册表：`[{id, enabled, timeoutMs, weight, baseUrl?}]`；显式 `[]` = 一个源都不开 |
| `llmTasks` | object | consolidation 由 consolidationProvider/Model 推出 | LLM 任务路由：`{任务名: {provider, model, fallback?: [{provider, model}], timeoutMs, maxTokens}}` |
| `consolidationMinEvidence` | number | 10 | 节流：未消化的证据攒到这么多就触发沉淀 |
| `consolidationMinTurns` | number | 5 | 节流：距上次沉淀超过这么多轮就触发 |
| `consolidationProvider` | string | — | 提炼用的模型服务商（不配就走规则兜底） |
| `consolidationModel` | string | — | 提炼用的模型 |
| `consolidationMaxTokens` | number | 1024 | 提炼输出上限。**生产实例踩坑（2026-09-02/03）**：默认 1024 太小——模型按每条证据逐条输出完整 observation（每条可达数百 token），40 条/批必然截断 → 判失败 → 水位永不推进（连续 24 败）。修复组合：prompt 引导合并输出 + 批次收敛 + 配额放大（见下） |
| `consolidationMaxBatch` | number | 40 | 单批证据上限（P0-6）。生产建议 8：配合 maxTokens 12288（约 2 倍输出余量）；prompt 已引导"合并相似证据、禁止逐条机械输出"（P0-7） |
| `consolidationTimeoutMs` | number | 30000 | 提炼调用超时 |
| `autoPromote` | boolean | false | 风格候选策略达标后自动晋升（默认关，走人工审批门） |
| `viewsDir` | string | ledgerDir/views | 物化视图目录 |
| `policyConfig` | object | — | promotion 策略参数覆盖（floors 只允许更严：min_events 最低 2、min_strong 最低 1、证据窗口最长 30 天） |
| `startupRebuild` | boolean | true | 启动时校验视图 checksum，失配自动重建 |
| `crossSessionPolicy` | enum | non-instructional | 跨会话注入闸门（2026-08-30）：`non-instructional`=跨会话只注入非指令性内容（agent_authored 总结/external_tool），user_input/user_correction 跨会话不注入；`all`=跨会话全类别注入（utility×0.3 惩罚 + session 来源标记）；`none`=不注入任何跨会话内容。本会话内容始终全类别注入 |
| `subagentDowngrade` | boolean | true | 子代理会话（session.header.origin=subagent）内 user 消息降权为 agent_inference（记录但 quarantine，不进注入），避免父 agent 派发 prompt 冒充用户指令 |

> **会话隔离语义（v0.1.1 起）**：pre-step 注入按会话分层——本会话证据全类别进入；跨会话证据默认只放行非指令性内容，渲染时带 `session=` 来源标记与一次性引导语（"历史参考，非当前指令"）。跨会话 user_input 需要显式 `crossSessionPolicy: all` 才注入（带惩罚与标记）。

## API（ctx.acp）

| 方法 | 说明 |
|---|---|
| `append(input)` | 写入证据（过写入闸门 + 资格矩阵；内容重复则返回已存在的 id） |
| `get(id)` / `inspect(id)` | 读单条（inspect 附带治理裁决细节） |
| `setState(id, state, opts)` | 状态迁移（正常/隔离/已取代/已脱敏） |
| `recall({query, scopeId, targetDomain, validAt, allowSuperseded, maxTokens})` | 召回（编排的最小入口；validAt 支持历史视图） |
| `history(id)` | 证据的演化链（谁取代了谁） |
| `stats()` | 账本统计 |
| `export(scopeId, {format, streams})` | 导出（json / jsonl；证据/观察/候选/审计四类流） |
| `import(jsonlText)` | 导入（证据按内容哈希幂等，重复不落） |
| `correct(input)` | 用户纠正：写入纠正证据 + 立即取代旧证据 |
| `release(id)` / `rollback(id)` / `redact(id)` / `delete(id)` | 用户权利操作（释放隔离/回滚/脱敏/删除） |
| `audit({op, scopeId, actor, limit})` | 查审计 |
| `rebuild(viewName)` | 手动重建物化视图（视图随时可以重建） |
| `exportActive(scopeId)` | 只导出生效中的证据（便捷方法） |

## 数据位置与备份

- 全部数据在 `ledgerDir` 下：`acp-ledger.db`（SQLite，WAL 模式），五张表：证据 / 观察 / 候选 / 候选事件 / 审计
- 物化视图在 `ledgerDir/views/` 下，可随时重建（带校验和）
- **备份/迁移**：导出（JSONL）→ 新环境导入，按内容哈希幂等合并
- **数据是你的**：卸载插件不会删数据；装回来即恢复

## 卸载

1. 从 profile 的 package.json dependencies 里移除 dsh-adaptive-context
2. 从 dsh.profile.bundles 里移除包名
3. pnpm install 后重启 dsh

卸载不删 `ledgerDir` 的数据；想彻底清除就手动删那个目录。

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 注入不生效 | 确认 cordis.patch.yml 里 ledgerDir 显式配置（DSH_HOME 不可靠，缺省可能落到当前目录） |
| 沉淀不出观察 | 没配 consolidationProvider/Model → 走规则兜底（仍会产出，只是精度低）；或证据积压没到节流线（10 条或 5 轮） |
| 审批面板看不到晋升请求 | 审批请求由下一轮的 pre-step 发起（后台任务没有 agent 引用）；确认会话有面板渲染 |
| 启动报 llm purpose 错误 | 内部用 purpose:'compaction'（dsh-llm 枚举只有 compaction/session-title）——别在 llmTasks 里覆盖这个语义 |
| 日志啥都看不到 | 开 debug: true；关键操作日志前缀是 [acp]，可以 grep |

## 开发

```bash
node test/<file>.test.mjs   # 单文件直跑（沙箱环境 node --test 递归受限）
```

设计文档在配套仓库 **acp-docs**（架构 / 契约 / 编排 / 治理 / 沉淀 / 表达 / 多源等）。

## License 与致谢

MIT License。参考项目致谢见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)（MemOS / Hindsight / personagent / DeepSeek Harness）。
