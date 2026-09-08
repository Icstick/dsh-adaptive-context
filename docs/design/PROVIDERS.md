> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — Provider 源码研究（PROVIDERS）

> 研究方式：拉取仓库源码（D:\DSH_workspace\research\）做源码级分析。
> 许可核实时间：2026-08-25。**许可可能随时间变化，实现前重新核实。**

## 1. 许可核实结果（重要更新）

| 仓库 | 报告（08-24）声明 | **实际核实（08-25）** | 结论 |
|---|---|---|---|
| MemOS | Apache-2.0 | **Apache-2.0**（LICENSE 确认） | ✅ 可直接参考 |
| Hindsight | MIT | **MIT**（LICENSE 确认） | ✅ 可直接参考 |
| personagent | PolyForm Noncommercial | **MIT**（LICENSE 确认，2026 copyright） | ✅ **许可已变更**，原"必须 clean-room"结论过时，可参考实现 |
| OpenViking | AGPLv3 | 未拉取（谨慎） | ⚠️ 维持文档层研究 |

**personagent 许可变更的意义**：报告中"personagent 必须 clean-room（PolyForm NC）"的结论已不成立。
其 Evidence→Candidate→Promotion 状态机现在可以直接研究实现细节，无需隔离。

## 2. MemOS DSH adapter（apps/memos-local-plugin/adapters/deepseek-harness/）

这是与 DSH 集成的**参考模板**，热路径设计与 ACP 高度一致：

### 2.1 热路径（已验证实现）
```text
每个 accepted non-empty direct-user turn：
  → agent/pre-step 前执行一次有界 recall
  → deadline = min(recallTimeoutMs, 3000ms)（产品级前台 SLA）
  → 同一逻辑 turn 重入 pre-step 去重
  → recall 结果作为 plugin user message 注入（source=plugin/memos-local-memory/recall）
  → 注入块用 <memos_context> 包裹，明确标记 untrusted historical data
  → query 在前、context 在后（pre-step 前等待 recall 完成保证顺序）
```

### 2.2 后台（已验证实现）
```text
session/event → 聚合事件
turn/end → per-session serial background queue（route/classify/capture/
           summary/embedding/relation/intent/episode routing）
下一轮不等待上一轮 queue 提交（eventual consistency）
session/flush 不作为 capture barrier
Cordis dispose → bounded best-effort drain（DSH 5s 插件窗口）
```

### 2.3 失败语义（已验证实现）
```text
bootstrap 失败 → 仅警告，DSH 继续运行（failOnStartupError=false 默认）
retrieval 失败 → safeCutoff（有排名候选时）；无候选则注入空
deadline abort → 自动 recall 返回原 pre-step decision；memos_search 返回 timedOut
malformed JSON → 不重试，立即用机械 safeCutoff
插件生成消息 → 不触发 recall（防递归）
```

### 2.4 配置（默认值）
```yaml
recallTimeoutMs: 3000      # 前台 recall 上限，DSH 上限 3000ms
contextMaxChars: 6000      # 注入 <memos_context> 上限
toolResultMaxChars: 1200
failOnStartupError: false
viewerPort: 18801          # in-process viewer，绑定 127.0.0.1
```

### 2.5 对 ACP 的启示

| MemOS 已验证 | ACP 对应 | 动作 |
|---|---|---|
| pre-step 前 bounded recall，3s 上限 | Context Composer | **直接采用同一预算模型** |
| plugin user message + untrusted 标记 | 注入语义 | **与 ACP 设计一致** |
| per-session serial queue + eventual | queue.mjs | **采用同一模式** |
| fail-open + safeCutoff | 热路径纪律 | **采用** |
| **无 Evidence 四维分离** | Evidence Ledger | **ACP 差异化价值** |
| **无 Write Guard / source-class 治理** | Governance | **ACP 差异化价值** |

**关键结论**：MemOS 把内容全部当 untrusted historical data，但没有 authority/
source-class/conflict-resolution 治理。这正是 ACP 存在的意义——MemOS 可作
recall/capture Provider，但**不能**作为真相源或治理层。

## 3. Hindsight（MIT，结构成熟但重）

- Python FastAPI + PostgreSQL 架构，嵌入式 (hindsight-all) 与 server 两种形态
- Observations / Mental Models（材料化视图）/ Reflections 三级认知模型
- Memory Defense：retain 带 receipt_uri，违规 422，batch 部分阻断，security_events
- 大量 alembic migrations = schema 演进成熟
- **但对 DSH MVP 太重**（需要服务部署/Postgres），适合作为 ReflectProvider 参考，
  不适合本地轻量接入

## 4. personagent（MIT，许可已变更）

- 模块结构：evidence.py / candidates.py / promotion.py / evolution.py / pools.py /
  reactions.py / ingestion.py / storage.py
- Evidence→Candidate→Promotion 状态机 + data/ 下 en/zh 双语 few-shot 语料
- 与报告描述一致，现在可直读源码
- **对 ACP 的价值**：Expression Evolution（v0.1 manual promotion）的参考实现

## 5. 研究建议

1. **MVP Provider = MemOS**（轻量实验接入）：复用其 DSH adapter 的
   bounded recall / per-session queue / fail-open 模式，但接入时**关闭其自动注入**，
   只作为 ACP 的 RecallProvider（避免双注入——唯一注入 authority 属于 Composer）
2. **Hindsight**：v0.1 作为 ReflectProvider 参考（observations/mental models 模型），
   不本地部署
3. **personagent**：直接参考其 promotion 状态机实现（许可已允许）
4. **OpenViking**：维持文档层研究，不 clone 源码（AGPL）
