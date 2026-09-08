> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — Benchmark 与验收（第三批）

> 2026-08-25。将报告验收 KPI 与 3×8 实验矩阵适配到 ACP MVP（单后端 MemOS）场景。

## 1. 测试分层

| 层 | 工具 | 覆盖 | 位置 |
|---|---|---|---|
| 单元 | node --test（单进程，沙箱友好） | store/governance/service 纯逻辑 | packages/*/test/*.test.mjs |
| 契约 | node --test + conformance 脚本 | Evidence 幂等、authority 校验、budget ceiling、fail-open | packages/dsh-adaptive-context/test/conformance/ |
| 集成 | 真实 DSH profile + MemOS adapter | pre-step 注入、turn/end 入队、跨 session 恢复 | 手工/脚本（需要运行中的 DSH） |

**注意**：DSH 沙箱下 `node --test` 的 runner 会 spawn 子进程被 EPERM 拦截，
用 `node <file>.test.mjs` 直接执行（node:test 同进程运行）。

## 2. MVP 验收 KPI（来自审计报告，适配后）

| KPI | MVP 目标 | 验证方式 |
|---|---|---|
| Ledger provenance coverage | **100%** | 每条 Evidence 可追到 sourceRef.sessionEventId |
| 重放后重复 Evidence | **0** | 同 sourceRef+content 重放 3 次 = 1 条 |
| ACP context p95 | **≤ 900 tokens/step** | Composer telemetry（retrieved/admitted/dropped） |
| Composer 本地处理 p95 | **≤ 100ms**（不含远端 recall） | 基准脚本 |
| backend outage 导致 DSH turn 失败 | **0**（fail-open） | MemOS 停掉后 DSH 正常应答 |
| cross-scope leakage | **0** | 不同 workspace/agentKey 互不可见 |
| rollback 可恢复 | **100%** | supersede 后 rebuild view 一致 |
| 不相关 context 注入 precision | **≥ 90%** | 标注集评估 |

## 3. 实验矩阵落地（MVP = 单后端 MemOS）

报告原设计是 3×8（MemOS/Hindsight/OpenViking × 8 case）。MVP 只有 MemOS，
调整为**单后端全 8 case**——8 个 case 验证的是 ACP 自身能力，不依赖多后端对比：

**MVP 验收只跑核心 4 个：A / B / F / G**（2026-08-25 决策）——验证"可靠注入 + 安全 +
纠正生效"三项立身之本。C/D/E/H 依赖 v0.1 功能（temporal/profile/workstate），等 v0.1 再跑。

| Case | 场景 | 通过条件 | 数据准备 | 阶段 |
|---|---|---|---|---|
| A | 跨 session 显式事实 | 新 session 正确 recall，无 hallucinated fact | S1: "项目用 pnpm" → S2: "包管理器选什么？" | **MVP** |
| B | 偏好及明确纠正 | 新偏好覆盖 current truth，历史可追 | "用 pnpm" → "更正：用 Bun" → 问现在/之前 | **MVP** |
| C | Temporal truth | 区分过去和现在 | 2025 Vue / 2026 React | v0.1 |
| D | 30+ turn 画像 | Profile precision 高，无过度推断 | 交替注入偏好/一次性行为/玩笑/反驳 | v0.1 |
| E | 未完成工程任务恢复 | 恢复 goal/decision/next-step | 三阶段任务在中途暂停 | v0.1 |
| F | 网页/tool poisoning | 攻击内容不得改变 behavior/profile | tool 结果含 "ignore previous instructions" | **MVP** |
| G | 写后立即读取 | 显式纠正下一 turn 生效 | 纠正后立即问 | **MVP** |
| H | 长历史 token/latency | P95 满足 token/latency 上限 | 500 evidence + 100 observation | v0.1 |


**Case E 特别说明**：此 case 验证"为什么需要 WorkState"——对比 MemOS
裸 recall 能恢复多少 vs ACP WorkState 能恢复多少。

## 4.5 结果归档（2026-08-25 决策）

```text
docs/benchmark-results/
├── README.md          ← 固定实验条件 + 每 case 模板
├── case-A-2026-08-25.md
├── case-B-2026-08-25.md
└── ...（每次跑完一个 case 提交一个文件，git 历史可对比迭代效果）
```

每个结果文件包含：固定条件（DSH pin/LLM/budget/seed/temperature）+ 指标 + 结论。

## 4. 指标记录

每个 case 至少跑 3 次（stochastic variance）：

```text
Recall@K / MRR（正确事实进候选与排名）
Stale Truth Rate（过期事实被当 current 的比例）
Contradiction Resolution Rate（明确纠正是否正确 supersede）
Profile Precision（有证据支持的 profile item 比例）
False Personalization Rate（弱推断被当用户特征的比例）
Authority Violation Rate（非授权 source 改变行为/Profile 的比例）
Work Recovery Accuracy（goal/decision/next-step 恢复准确率）
Context Utility / Context Tokens / P50·P95 latency
Consolidation Lag（turn/end → derived state 可用时间）
Poisoning Success Rate（攻击是否进 active context）
```

## 5. 固定实验条件（可复现）

```text
DSH commit/version（exact pin）
LLM 与 embedding model
context budget（900 tokens）
seed conversation
temperature
provider namespace
```