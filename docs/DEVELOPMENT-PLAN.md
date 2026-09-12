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
| 0.4.0 | fd91ed2 | 注入/蒸馏质量治理：蒸馏非放大（observation 权威取支撑证据最弱值）、RRF 秩融合（fusion=rrf，默认仍 weighted）、高权威条目不截断、一次性任务指令不进画像（阶段 2.3，默认 shadow 已切 on）；安全审计修复 H-4/H-5；backlog 收口 B1/B4/B5/B9/B13；同行调研 PEER-SURVEY-20260909 |

| 0.5.0 | f9a6055 | 规则层治理：B10 容量校准（生产 rules 60→140、规则精编 8→7 条）+ B14 短标签记账（20→4 token/条）、全量候选去时间序切片、pinBoost 常驻分层、可注入性提示（⚠超40字）+ B15 `/acp rule pin\|unpin` 常驻机制 + B11 规则失效观测（bigram≥0.6 判定已覆盖）+ B8 注入集 turnover（admittedIds+jaccard）；附带 consolidate 审计区间留痕/空批次水位线修复、llm-router source.form 修复 |

## 待办（Backlog）

| ID | 级别 | 问题 | 解决方式 | 状态 |
|---|---|---|---|---|
| ACP-B1 | P2 | README 配置表 sectionQuota 默认值过时（写 memory 350，实际 T4 M4.4 后 memory 290 + rules 60） | README.md:173 默认值改 `user_model 180 / work_state 250 / memory 290 / expression 120 / rules 60，合计 900` | ✅ 2026-09-10（README.md:173 已改，含 rules 让渡说明） |
| ACP-B2 | P2 | 生产 profile（C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml）sectionQuota 无 rules 键 → composer fallback 300 token（默认语义 60）；memory 350 未让渡；块内注释停在 T2 前（"矩阵兜底"应改"权威白名单"） | profile sectionQuota 补 `rules: 60`、memory 350→290，注释同步 T2/T4 语义；随下次重启窗口执行（部署侧，不在仓库） | ✅ 2026-09-10（profiles/web/cordis.patch.yml:115-125 已改：rules 60 + memory 290 + 注释同步；待下次重启生效） |
| ACP-B3 | P2 | acp-docs 配套设计文档停在 09-03（0.3.0 反馈通道/rule v6/rules 段未入 COMPOSER/CONSOLIDATION） | ✅ 2026-09-08 合并执行（用户拍板：少一个维护位置）——acp-docs 内容并入 docs/design/（现役 9 篇 + benchmark-results/）+ docs/history/（保档 14 篇），引用链已改指，原仓库 GitHub 归档 | ✅ 完成 |
| ACP-B4 | P3 | README API（ctx.acp）表漏 queryObservations（maid PIN 契约依赖的公开方法）与 startupVerify | README API 表补两行（queryObservations：查蒸馏 Observation 轨，authorities IN 过滤；startupVerify：启动校验） | ✅ 2026-09-10（README.md:220/222 两行已补） |
| ACP-B5 | P3 | lint warnings 45 个（0 error）——src 侧真未用：service.mjs import SCOPES 未用、:347 参数；index.mjs:724 参数；lifecycle.mjs:88 参数；consolidate.mjs:210 auditStore 参数（接口残留）、:424 flowSkipped 只计数不落地（改日志或删）；governance.mjs:10 / feedback.mjs:153 无必要转义；test 侧 24 个 mock 未用参数 | 一次 lint-clean 提交（`pnpm lint` 归零）；flowSkipped 改 logger 输出保留观测；test 未用参数改 `_t`/删 | ✅ 2026-09-10（0 warning / 0 error；实际 51 条——审计前后新增 6 条；flowSkipped 已改 logger.debug 留痕） |
| ACP-B6 | P3 | git 残留分支 ×5（已并入 master）：feat/consolidation-thinking-guard、feat/memory-seam-s1、feat/memory-seam-s1-pre-cleanup、feat/settings-section-ui、feature/injection-isolation | git-guardrails 流程：本地 branch -D + push origin --delete | ✅ 2026-09-08（本地 5 + 远程 3 已删） |
| ACP-B7 | P1-4 记录 | maid 折叠归档（single_observation）回流注入风险：T2 权威闸门（observationAuthorities 默认 [user_explicit,user_correction]）当前客观挡下，archiver 无 kind=maid-checkpoint 标记；audit 报告 P1-4 未落刀也未记录豁免 | 本行即豁免记录：放宽 observationAuthorities 白名单前必须重开 P1-4（maid 归档侧加 metadata kind + composer 排除/降权）——maid 仓库交叉引用 | 已记录（条件触发） |
| ACP-B8 | ✅ 2026-09-12 | C7 注入集稳定性观测（turnover）：相邻 step 注入集去重率/Jaccard | ✅ 完成：composer 输出 `admittedIds`（含 telemetry）+ 导出 `jaccard()`；pre-step 按会话记上一步注入集并写 `[acp] injection turnover jaccard=… admitted=… prev=…` 日志（fail-open，Map 上限 50 会话防累积）。后续可选：把 jaccard 上报 scheduler（现仅日志） | ✅ 完成 |
| ACP-B9 | ✅ 完成 | S2 memento 迁移/退役：L1 memento bundle + 数据归档、L2 shared-memory bundle + USER.md 归档、patch 清理、memory 工具消失语义 | ✅ 2026-09-08 提前执行完成（用户批准缩短观察窗，PLAN-S2 §5 修订版 8 步）：USER.md→archive/memories-shared-layer-20260908、memory.db→archive/dsh-memento-20260908、pnpm -52 包；重启验证 memory 工具消失 + 11 画像 observation 注入就绪；回滚 = package.json.bak-memento-exit-20260908 + archive | ✅ 2026-09-08 |
| ACP-B10 | ✅ 2026-09-11 | T4 规则 live 复查：**发现 rules 段容量与规则库规模脱节**——每条成本 20 token（source 标签）+ CJK 1.0/字，60 token 只装 1 条 40 字规则（8 条库实际注入 1 条）；候选 `slice(0,3)` 按 created_at 取最新 3 条 | 本轮修复：① 生产 rules 配额 60→140（吃 hotTokens 余量，合计 1600）② 规则精编 8→7 条（22-32 字/条，supersede 链 + 审计）③ rules/ 视图陈旧根因=外部写入不刷新 → 新增 `/acp rule rebuild` | ✅ 完成 |
| ACP-B14 | ✅ 2026-09-12 | 规则层容量治理（B10 复查剩余项）：① 候选时间序切片 ② 标签固定开销 20 token/条 ③ 长度无提示 | ✅ 完成：① 全量 active 进候选（去 `slice(0,3)`），utility = 词面相关度 + explicitRef(+0.2) + pinBoost（gates 含 'always'，+0.5）② 短标签 `[rule]` + SHORT_LABEL_TOKENS=4 记账（rules 段实装 1→3-4 条）③ `/acp rule list` 标字数与 `⚠超40字安全线`。测试 422/422、lint 0/0、depcruise 0 违规 | ✅ 完成 |
| ACP-B15 | 待名单 | 规则常驻分层：**机制已全部就位**（store `updateRuleGates` + `/acp rule pin/unpin <n>` + audit `rule_gates_updated` + list 序号与 📌 标记 + 测试），生产尚未 pin 任何规则 | 用户定常驻名单（建议：安全类「不可逆操作前先备份」+ 工作方式类「规划先行」）→ `/acp rule list` 看序号 → `/acp rule pin <n>` | 待用户定名单 |
| ACP-B11 | ✅ 2026-09-12 | 反馈通道 V1.1：新 user_correction 与 active 规则 lexical 重叠 ≥0.6 → 提示"规则 X 似乎没生效"（与 C5 共用种子） | ✅ 完成 v1：`lexicalOverlap`（CJK bigram、min 归一化）+ `findCoveringRule`（阈值 0.6 / 仅 active / <10 字不判定）；maybeDraft 命中即不重复草拟 + audit `rule_ineffective_suspect`（evidenceId/overlap/ruleTitle）+ info 日志；返回加 `covered`。v2 候选（未做）：把嫌疑上报注入面提示模型自查 | ✅ 完成 |
| ACP-B12 | 保留 | types.d.ts 空壳（package.json 声明 types）：等 harness 收录 acp/* 事件词汇后启用 | 保持现状；harness 支持后做 declaration merging | 保留 |
| ACP-B13 | P3 | acp-controllability-fix-plan-2026-09-07.md（工作区 docs）§三清单 checkbox 未勾选但执行记录已 ✅ | 勾选或加"见执行记录"注（工作区文档，随报告收尾做） | ✅ 2026-09-10（该文档 §三 已勾选 + 回填注；工作区非 git 仓库，无提交） |

## 已收口（近期）

- T1（C9 清污染 + isCorrection 收紧）✅ 2026-09-07 —— 存量 quarantine_noise ×3、收紧已在代码
- T2（observation 权威闸门）✅ 0759eb8 —— observationAuthorities 默认白名单
- T2.5（蒸馏语义虚高治理）✅ ca2ad57
- T3（E2 助理消息过滤/摄入链路）✅ 并入 0759eb8
- T4（反馈通道 M4.1a-4.6）✅ a048f6b→2639d85 —— 见 docs/t4-feedback-channel-impl（工作区）
- E1（audit ops 补录）/ E3（设置 UI 字段三层漂移）✅ 2026-09-07
