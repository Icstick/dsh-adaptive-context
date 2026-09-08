> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 项目回顾（Project Retrospective）

> 2026-08-28。M0 → M4 全历程回顾：目标、里程碑、成果、经验。ACP 调研报告落地的完整记录。

## 1. 项目目标

把 AdaptiveContextPlane（ACP）调研报告变成 DeepSeek Harness 里**带治理的长期记忆插件**：
记住什么、以什么权威记住、何时注入、以多少预算注入——全部可审计、可回溯。

五条铁律贯穿始终：

> Evidence is truth; views are rebuildable. Confidence is not authority.
> Retrieval does not imply disclosure. Learning does not imply promotion.
> Memory does not own work continuity.

## 2. 里程碑历程

| 里程碑 | 内容 | 完成 | 关键数据 |
|---|---|---|---|
| M0 脚手架 | 仓库结构 + 规划文档 + 代码骨架 | 08-25 | 三库拆分（adaptive-context / work-continuity / acp-docs） |
| M1 MVP | Evidence Ledger + Governance + Composer + /checkpoint + MemOS 实验接入 | 08-26 | 84 测试，正式 web profile 集成实测 |
| M2 v0.1 | self-echo/dedup + memos-provider + background consolidation + temporal + expression 审批门 | 08-27 | 122 测试，5 worktree 并行，dev 全链路验证 |
| M3 v1 | provider routing + guarded auto promotion + audit/export/rebuild | 08-28 | 253 测试，两波五组并行，dev 验证 + 迁移实战 |
| M4 发布 | 即插即用/无污染/可回溯 + GitHub 公开 | 08-28 | 三仓库 + v0.1.0 + clone 冒烟通过 |

**三天半，从图纸到公开插件**（Agent 主导开发，人类规划拍板）。

## 3. 交付成果

- **代码**：dsh-adaptive-context（253 测试全绿，18 个源模块）+ dsh-work-continuity（8 测试）
- **文档**：acp-docs 18 份设计文档（架构/契约/治理/编排/沉淀/表达/多源/规划/回顾）+ benchmark 结果
- **发布**：github.com/Icstick/{dsh-adaptive-context, dsh-work-continuity, acp-docs} 公开 + MIT + tag v0.1.0
- **数据**：正式实例证据账本 90 条（两库迁移合并，幂等去重验证）

## 4. 关键决策回顾

| 决策 | 选择 | 效果 |
|---|---|---|
| 规划先行 | 先文档 + 交叉讨论，零遗留才写码 | 三次规划批次，M1-M3 开发零返工 |
| 并行模式 | git worktree + flash 子代理 + junction node_modules | M2 五组 / M3 五组，冲突仅 2-3 处手工解决 |
| 契约冻结 | 跨组接口先定稿（M3-PLAN §6） | 组C/组D 消费 B1/B2 API 零返工 |
| 审批门（5B） | promotion 走 approval 而非命令式 | 可审计、可回滚，失败不阻塞 |
| 数据自持 | 自带 SQLite ledger，不动 dsh-memento | 互不干扰，可导出迁移 |
| MIT + 公开 | 宿主 dsh 同为 MIT；致谢 clean-room 参考 | 无许可冲突，三仓库公开 |

## 5. 经验总结

### 流程经验
1. **规划先行真的省时间**：M1-M3 三个规划批次把决策点全部前置，开发期几乎没有"方案推倒重来"
2. **并行要按文件冲突图分组**：同文件同波 = 冲突，跨波 = 顺序合并；契约冻结让并行组互不踩脚
3. **文档与代码同步提交**：每个里程碑完成即更新 DEVELOPMENT-PLAN/CODE-MAP/LESSONS，交接零成本
4. **dev 环境验证不可省**：M2/M3 都在 dev 实例实测后才宣布完成；单测通过 ≠ 集成通过（purpose 枚举、ledgerDir 兜底都是集成才暴露）

### 技术经验
5. **DSH 生态契约以实测为准**：session/event 签名、approval outcome、GenerateOptions.purpose——文档/直觉都不如真实实例实测
6. **fail-open 是插件生命线**：ACP 任何故障不阻断 turn；consolidation/recall/approval 全部 try/catch + 合法默认
7. **测试隔离是红线**：openEvidenceLedger({dir2}) 笔误污染正式库的教训——测试临时库必须显式路径 + 校验实际打开位置
8. **Windows 细节会咬人**：CRLF 字符串匹配、bat 编码、DSH_HOME 环境变量、schtasks——每一条都真实卡过

### 协作经验（用户视角）
9. 用户"冷静思考"原则（越是这个时候越要冷静思考呀）让规划质量远超赶工
10. README/文档的用户视角要求（背景/故事/中文/去 AI 味）说明：**对外文档的目标读者是"第一次见到这个项目的人"**

## 6. 遗留与展望

| 项 | 状态 |
|---|---|
| 正式实例 observation 恢复积累 | ~~consolidation 节流未触发~~ → **2026-09-03 修复**（maxTokens/batch/prompt 收敛，见 HANDOFF-2026-09-03.md），5/5 run 成功、8→22 条；observationInjection 注入开关仍冻结待消费场景 |
| 真实 benchmark | 等正式实例运行数据积累后做（BENCHMARK.md 已有框架） |
| types.d.ts 完整化 | 类型检查增强（DEVELOPMENT.md 标注"未来"） |
| 长期预算上探 | 三级承诺 6000-8000 tokens/step 是长期目标 |
| LLM style 分类噪声 | v0.1 已优化 prompt 判别引导，继续观察 |
| MemOS 语义分 | 依赖 MemOS 后端数据质量 |

## 7. 结语

ACP 从一份调研报告变成了三份公开仓库。最值得留住的不是代码量，而是这套流程：

**规划先行 → 契约冻结 → 并行开发 → 合流回归 → dev 实测 → 文档同步 → 发布验收**

每一步都有文档留痕，每一步的坑都进了 LESSONS。下一个插件项目可以直接复用这条流水线。
