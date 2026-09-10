# dsh-adaptive-context — 开发计划与问题登记（Backlog）

> 仓库级 backlog：进行中/待办/已收口的工作条目与已知问题。与 docs/PLAN-S2-MIGRATION.md
> （S2 迁移专项）并行；架构决策见 docs/adr/。设计长文见 docs/design/（2026-09-08 自 acp-docs 并入）。
> 维护规则：条目完成即更新状态并注明提交/日期；新发现先登记再动手（规划先行）。
> 本文件初版登记来源：D:\DSH_workspace\docs\audits\plugin-code-review-2026-09-07.md（2026-09-07 全面审查）

## 版本线

| 版本 | 收口提交 | 内容 |
|---|---|---|
| 0.2.0 | 3025ad9 | S1/S2 memory-seam：acp_query+读审计、observation 轨 schema v5、memento 迁移管道、设置顶层 section、golden regression |
| 0.3.0 | 2639d85 | T4 反馈通道（rule schema v6 / 草拟 G1-G2 / /acp rule 审批 / composer rules 段）+ T1-T3 修复集 |
| 0.4.0 | — | 待办合流（下表），版本决议：修复集不单独 bump，随特性里程碑收口 |

## 待办（Backlog）

| ID | 级别 | 问题 | 解决方式 | 状态 |
|---|---|---|---|---|
| ACP-B1 | P2 | README 配置表 sectionQuota 默认值过时（写 memory 350，实际 T4 M4.4 后 memory 290 + rules 60） | README.md:173 默认值改 `user_model 180 / work_state 250 / memory 290 / expression 120 / rules 60，合计 900` | ✅ 2026-09-10（README.md:173 已改，含 rules 让渡说明） |
| ACP-B2 | P2 | 生产 profile（C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml）sectionQuota 无 rules 键 → composer fallback 300 token（默认语义 60）；memory 350 未让渡；块内注释停在 T2 前（"矩阵兜底"应改"权威白名单"） | profile sectionQuota 补 `rules: 60`、memory 350→290，注释同步 T2/T4 语义；随下次重启窗口执行（部署侧，不在仓库） | planned |
| ACP-B3 | P2 | acp-docs 配套设计文档停在 09-03（0.3.0 反馈通道/rule v6/rules 段未入 COMPOSER/CONSOLIDATION） | ✅ 2026-09-08 合并执行（用户拍板：少一个维护位置）——acp-docs 内容并入 docs/design/（现役 9 篇 + benchmark-results/）+ docs/history/（保档 14 篇），引用链已改指，原仓库 GitHub 归档 | ✅ 完成 |
| ACP-B4 | P3 | README API（ctx.acp）表漏 queryObservations（maid PIN 契约依赖的公开方法）与 startupVerify | README API 表补两行（queryObservations：查蒸馏 Observation 轨，authorities IN 过滤；startupVerify：启动校验） | ✅ 2026-09-10（README.md:220/222 两行已补） |
| ACP-B5 | P3 | lint warnings 45 个（0 error）——src 侧真未用：service.mjs import SCOPES 未用、:347 参数；index.mjs:724 参数；lifecycle.mjs:88 参数；consolidate.mjs:210 auditStore 参数（接口残留）、:424 flowSkipped 只计数不落地（改日志或删）；governance.mjs:10 / feedback.mjs:153 无必要转义；test 侧 24 个 mock 未用参数 | 一次 lint-clean 提交（`pnpm lint` 归零）；flowSkipped 改 logger 输出保留观测；test 未用参数改 `_t`/删 | open |
| ACP-B6 | P3 | git 残留分支 ×5（已并入 master）：feat/consolidation-thinking-guard、feat/memory-seam-s1、feat/memory-seam-s1-pre-cleanup、feat/settings-section-ui、feature/injection-isolation | git-guardrails 流程：本地 branch -D + push origin --delete | ✅ 2026-09-08（本地 5 + 远程 3 已删） |
| ACP-B7 | P1-4 记录 | maid 折叠归档（single_observation）回流注入风险：T2 权威闸门（observationAuthorities 默认 [user_explicit,user_correction]）当前客观挡下，archiver 无 kind=maid-checkpoint 标记；audit 报告 P1-4 未落刀也未记录豁免 | 本行即豁免记录：放宽 observationAuthorities 白名单前必须重开 P1-4（maid 归档侧加 metadata kind + composer 排除/降权）——maid 仓库交叉引用 | 已记录（条件触发） |
| ACP-B8 | 计划 | C7 注入集稳定性观测（turnover）：相邻 step 注入集去重率/Jaccard | composer.mjs telemetry 补集上报（对齐 WC registerWorkStateInjection 先例）；injectScheduler 已可记账 | planned |
| ACP-B9 | 计划 | S2 memento 迁移/退役（观察期后）：摘 memento bundle、归档 .dsh/dsh-memento、删 .dsh-meow、memory 工具消失语义 | 见 docs/PLAN-S2-MIGRATION.md（§5 退役步骤 1-4）；D1 已拍板并执行（2026-09-08 步5 清空完成，观察期 2 周自重启起算） | open（观察期满后退役） |
| ACP-B10 | 计划 | T4 重启实测后续：当前 active 规则为空 → rules 注入段无样本；待有规则后复查注入/草拟管线//acp rule 命令 | 有 active 规则后验证（S1-S6 种子场景已由测试覆盖，需 live 复查） | planned |
| ACP-B11 | 计划 | 反馈通道 V1.1：新 user_correction 与 active 规则 lexical 重叠 ≥0.6 → 提示"规则 X 似乎没生效"（与 C5 共用种子） | t4 计划 M7 扩展；V1.0 稳定后排期 | 未排期 |
| ACP-B12 | 保留 | types.d.ts 空壳（package.json 声明 types）：等 harness 收录 acp/* 事件词汇后启用 | 保持现状；harness 支持后做 declaration merging | 保留 |
| ACP-B13 | P3 | acp-controllability-fix-plan-2026-09-07.md（工作区 docs）§三清单 checkbox 未勾选但执行记录已 ✅ | 勾选或加"见执行记录"注（工作区文档，随报告收尾做） | ✅ 2026-09-10（该文档 §三 已勾选 + 回填注；工作区非 git 仓库，无提交） |

## 已收口（近期）

- T1（C9 清污染 + isCorrection 收紧）✅ 2026-09-07 —— 存量 quarantine_noise ×3、收紧已在代码
- T2（observation 权威闸门）✅ 0759eb8 —— observationAuthorities 默认白名单
- T2.5（蒸馏语义虚高治理）✅ ca2ad57
- T3（E2 助理消息过滤/摄入链路）✅ 并入 0759eb8
- T4（反馈通道 M4.1a-4.6）✅ a048f6b→2639d85 —— 见 docs/t4-feedback-channel-impl（工作区）
- E1（audit ops 补录）/ E3（设置 UI 字段三层漂移）✅ 2026-09-07
