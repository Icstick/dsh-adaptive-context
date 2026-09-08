# docs/design — ACP 设计长文（2026-09-08 自 acp-docs 并入）

> 本目录为原配套设计仓库 Icstick/acp-docs（commit 34e2840）的现役设计文档，
> 2026-09-08 并入主仓库（B3 合并决策：收敛维护位置，用户拍板）。每篇顶部含来源头注。
> 内容截至 2026-09-03；此后变更以本仓库 README.md / AGENTS.md / docs/DEVELOPMENT-PLAN.md /
> docs/PLAN-S2-MIGRATION.md / docs/adr/ 与 src 为准。原 acp-docs 仓库已归档（GitHub）。
> 开发过程文档（HANDOFF / 里程碑计划 / LESSONS / PROJECT-RETROSPECTIVE 等）在 docs/history/。

## 索引

| 文档 | 内容 |
|---|---|
| ARCHITECTURE.md | 总体架构与五条铁律 |
| CONTRACTS.md | 数据契约（authority/claimDomain/supersedes） |
| COMPOSER.md | Context Composer 设计（预算/排序/注入） |
| GOVERNANCE.md | 读写边界治理（资格矩阵/用户权利） |
| PROVIDERS.md | RecallProvider 契约与 MemOS 接入 |
| EXPRESSION.md | Expression 域设计（promotion 状态机规格） |
| CONSOLIDATION.md | Background consolidation 设计 |
| SCHEMA-REVIEW.md | Schema 评审记录 |
| BENCHMARK.md | 验收 KPI 与实验矩阵 |
| benchmark-results/ | A/B/F/G 实测结果归档 |
