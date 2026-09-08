> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — M4 发布准备（临时里程碑）

> 2026-08-28 起草。用户需求原话："把这两个插件变成可以真的即插即用，拔除也不会产生污染，
> 具有清晰可回溯路径的好插件。全部开发完成的话，可以上传到 github 去。"
> 范围：dsh-adaptive-context + dsh-work-continuity 两插件。

## 1. 目标

| 维度 | 含义 | 验收 |
|---|---|---|
| **即插即用** | 安装三步可用（link + bundles + install + 重启）；零配置有合理默认 | 新 profile 装上即用，不报错 |
| **拔除无污染** | dispose 干净（DB/队列/定时器/hook 全清）；不写隐式路径；数据集中可携带 | 拔除后重启 DSH 无任何残留报错 |
| **清晰可回溯** | 日志统一前缀可 grep；数据文件结构文档化；关键操作可审计（M3 C1 audit） | 一份文档讲清"数据在哪、怎么查、怎么备份" |
| **GitHub 发布** | LICENSE/README/.gitignore/打包验证/remote + tag | clone 即装即测 |

## 2. 现状审计（2026-08-28 源码核对）

| 项 | 现状 | 差距 |
|---|---|---|
| package.json 元数据 | name/version 0.1.0/license/files/engines 齐全 | ✅ 无 |
| types.d.ts | dsh-adaptive-context 有（types 字段指向存在） | ✅ 无 |
| LICENSE 文件 | **三个仓库都没有**（package.json 字段有 Apache-2.0） | ❌ 需补全文 |
| README | 有（能力/安装/配置/开发） | 缺卸载/数据位置/故障排查/发布 |
| .gitignore | adaptive-context 有（node_modules/*.db/*.log）；**work-continuity 无** | work-continuity 补 |
| dispose 完整性 | adaptive-context 仅 ledger.close()；consolidation 在途任务靠 enqueue catch 兜底 | 缺 bounded best-effort drain（MemOS 5s 窗口同款） |
| 隐式路径 | adaptive-context 已 config 显式路径；**work-continuity store.mjs 默认 DSH_HOME||''（踩坑同款）** | work-continuity 需强制 config workDir + 清晰警告 |
| git remote | 三仓库均无 | 需建 GitHub 仓库 + push |

## 3. 任务分解

### R1 dispose 完整性（P0）
- 现状：dispose → ledger.close()；consolidation 在途任务无 drain
- 方案：dispose 时 bounded best-effort drain（5s 窗口，对齐 MemOS DSH adapter）；队列排空或超时放弃；再关 DB；日志记录在途任务数
- 验收：dispose 后无定时器/无在途写入；拔插件重启无报错；测试可断言
- 测试：dispose 单测（队列 drain/DB 关闭/幂等 dispose）

### R2 无隐式路径（P0）
- 现状：work-continuity store.mjs L47 `opts.dir ?? path.join(process.env.DSH_HOME || '', 'dsh-work-continuity')`
- 方案：workDir 必须显式（README 已要求）；未配置时启动 warning 明确说明 + 默认落 DSH_HOME（不阻断）；adaptive-context 同理已达标
- 验收：两插件均不静默落 cwd；warning 文案清晰
- 测试：config/启动单测（未配置路径 → warning 存在）

### R3 卸载与数据资产（P0）
- 方案：README "卸载"章节——移除 bundle+link → 重启；数据在 ledgerDir/workDir（SQLite 单文件），卸载不删，重装即恢复（可回溯）；备份/迁移 = M3 C2 export→import
- 验收：文档完整；实测拔除一个插件重启 dev 无报错
- 测试：无（文档 + dev 实测）

### R4 日志规范（P1）
- 方案：统一前缀 `[acp]` / `[work-continuity]`；关键操作一行日志（append/promote/dismiss/consolidate/export：id/op/reason）；debug 级细节
- 验收：grep '[acp]' 可还原关键操作时间线
- 测试：日志格式单测（关键操作 emit 一行）

### R5 发布卫生（P1）
- 方案：①Apache-2.0 LICENSE 全文补三仓库；②work-continuity .gitignore（node_modules/*.db/*.log）；③`npm pack --dry-run` 验证 files 清单（src/cordis.patch.yml/README/LICENSE 齐）
- 验收：pack 产物清单正确；无 db/日志误入
- 测试：pack 检查（CI 前手工验证）

### R6 GitHub 上传（P1）
- 方案：创建 3 仓库（名称=包名）→ remote add → push master + tag v0.1.0 → clone 验证（pnpm install + node test 通过）
- 依赖：github-auth（HTTPS token 或 SSH key）
- 验收：全新 clone 可安装可测

## 4. 待拍板决策点

| # | 决策点 | 选项 | 推荐 |
|---|---|---|---|
| 1 | GitHub 可见性 | A=公开（开源 Apache-2.0）；B=先私有验证后公开 | A（license 已 Apache-2.0，插件本来就是要共享的） |
| 2 | acp-docs 上传 | A=上传（设计文档公开）；B=留本地 | A（README 引用 acp-docs，文档是插件门面） |
| 3 | 卸载数据归属 | A=保留（重装恢复）；B=保留 + 提供 purge 清理命令 | A（安全默认；purge 后置可选项） |
| 4 | README 语言 | A=中文；B=中英双语 | A（先中文，发布后按需补英文） |

## 5. 节奏

- M4 不阻塞 M3：R4（日志规范）可在 M3 代码中顺带做；R1/R2 是独立小改
- M4 主体（R3/R5/R6）工作量小，预计半天——M3 合流后集中做，或并行小分队
- M3 + M4 全部完成后：正式实例升级 → 全量验证 → tag v0.1.0 → push GitHub

---


## 6. 许可分析（2026-08-28，决策点 1 依据）

| 候选 | 兼容性分析 |
|---|---|
| **MIT** ✅ 推荐 | 宿主 dsh 为 MIT（生态对齐，插件惯例）；Hindsight/personagent（MIT）直接兼容；MemOS 为 clean-room 模式借鉴（注释引用设计模式，非代码复制，不触发 Apache-2.0 传染），致谢文件注明即可。最宽松、门槛最低 |
| Apache-2.0 | 若存在 MemOS 代码片段沿用则更稳（含专利授权），但我们的实现为 ACP 化重写（PROVIDERS.md 记录 clean-room 过程），无此必要；且与 MIT 宿主不同步 |
| GPL 系 | ❌ 与 dsh MIT 生态冲突，排除 |

**结论：MIT + ACKNOWLEDGMENTS 致谢文件**（MemOS/Hindsight/personagent/dsh），
正好满足用户"考虑合适许可 + 专门致谢参考文件"的要求。

## 7. ACKNOWLEDGMENTS 内容规划（R5 扩展）

文件：各仓库根 `ACKNOWLEDGMENTS.md`（或 README 引用）

| 致谢对象 | 许可 | 致谢内容 |
|---|---|---|
| DeepSeek Harness (dsh) | MIT | 宿主平台；插件运行于 dsh 插件树 |
| MemOS | Apache-2.0 | DSH adapter 设计模式参考：bounded recall / per-session serial queue / fail-open（PROVIDERS.md §2） |
| Hindsight | MIT | observations / consolidation 模型参考（CONSOLIDATION.md） |
| personagent | MIT | Evidence→Candidate→Promotion 状态机参考（EXPRESSION.md，2026 许可变更后核实） |

---

## 决策记录（2026-08-28 拍板）

| 决策点 | 拍板 | 备注 |
|---|---|---|
| 1 可见性/许可 | **公开 + MIT** | 用户："考虑合适的公开许可"→ §6 分析：MIT（宿主 dsh 同为 MIT） |
| 2 acp-docs | **上传** + **ACKNOWLEDGMENTS 致谢文件** | 用户："acp-doc可以上传，另外需要一个专门的用于致谢参考的文件" |
| 3 数据归属 | **保留**（用户自行决定删留） | 用户："可以做数据保留，这样用户想留着还是自己删除都可以" |
| 4 README 语言 | **中文** | 用户："readme就用中文吧" |
