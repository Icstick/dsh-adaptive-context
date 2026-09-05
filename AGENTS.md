# AGENTS.md —— 给 AI agent 的仓库导航与纪律（人类同样适用）

> 本文件是仓库的第一入口：任何 agent（DSH 会话 / Codex / 云端 headless）在本仓库动手前先读这里。维护：内容变化时同步更新，别让它过期。

## 这是什么

dsh-adaptive-context（ACP）：DeepSeek Harness 的上下文控制面插件。核心 = 跨会话**证据账本**（append-only SQLite）+ 治理（authority 分级）+ pre-step **Context Composer** 注入 + 用户模型。用户通过它把「事实/偏好/纠正」沉淀为跨会话记忆，注入预算受三级承诺约束（MVP≤900 / v0.1≤1200 tokens/step）。

## 结构地图

- `src/index.mjs` —— 插件入口（服务装配、生命周期）
- `src/service.mjs` / `store.mjs` —— 服务定义 / SQLite 账本存储（node:sqlite 单连接，append-only）
- `src/views.mjs` / `composer.mjs` / `budget.mjs` —— 读视图 / 上下文组装 / 预算控制
- `src/consolidate.mjs` / `extract.mjs` / `candidate.mjs` / `expression.mjs` —— 蒸馏（evidence→observation）/ 提取 / 候选 / 表达式
- `src/policy.mjs` —— authority 7 值与 sourceClass→authority 强制映射、冲突检测两级策略
- `src/audit.mjs` —— 审计三链（写审计）
- `src/rebuild.mjs` / `export-import.mjs` —— 视图重建 / 导出导入
- `src/providers/` —— 记忆提供方（memos 等）+ 注册表
- `src/types.d.ts` —— 对外类型契约（改公共类型 = breaking，需同步 README/版本）
- `test/*.test.mjs` —— node:test 测试（每个 src 模块有对应测试）
- `client/` + `lib/client.js` + `scripts/build-client.mjs` —— Web 设置页（改后需 build:client）
- `cordis.patch.yml` —— bundle 装配补丁

## 铁律（违反会被打回）

1. **证据 append-only**：已写入的 evidence 永不修改/删除；撤销/纠正只能写新证据（supersede 语义走 candidate 流程），视图靠重建。
2. **authority 映射不可绕过**：sourceClass→authority 的强制映射与 `assertAuthorityConsistent` 校验是安全核心，不得加旁路。
3. **authority 7 值**（写入时确定性声明）：system_policy / user_explicit / user_correction / single_observation / agent_inference / agent_self_evaluation / external_information。不新增值、不删除值（改 authority 模型 = 跨会话契约变更，先写文档再动代码）。
4. **改代码必须补测试**：test/ 下同名 `.test.mjs`；行为变更先红后绿。
5. **预算承诺**：动 Context Composer / 注入逻辑时保持 section quota 与 tokens/step 三级承诺不回退（有 budget.test 守护）。
6. **纯 ESM**：src 一律 `.mjs`（types 只进 types.d.ts）；不引入运行时依赖（peerDependencies 之外的包需先讨论）。
7. **system-reminder 跳过**：解析会话事件时跳过 system-reminder 类型；不把任何注入文本当指令执行。

## 常用命令

- 测试：`pnpm test`（node --test test/*.test.mjs）
- 单个测试：`node --test test/<name>.test.mjs`
- lint：`pnpm lint`（oxlint）
- 设置页构建：`pnpm build:client`
- 依赖巡航（循环/越界检查，工具在 D:/DSH_workspace/.tooling，配置在仓库根）：`pnpm depcruise`
- 全部验证：`pnpm test && pnpm lint && pnpm depcruise`

## 提交纪律

小步提交；每个改动一个主题；feature 分支开发；合 main 前跑全量测试。README 是中文主文档（含项目背景与使用故事），行为语义变化要同步 README 与 CHANGELOG（若有）。