> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 开发指南（Development Guide）

> 2026-08-25。环境、命令、规范、测试、验证。给人类开发者与 coding Agent 的
> 操作手册——对齐 DSH goldmine 的 Task Packet 思路：一次任务一个明确包。

## 1. 环境要求

```text
Node.js  ^22.19.0 || >=24.0.0   （DSH 要求，engines 已声明）
pnpm     workspace 管理（根 package.json 声明）
git      Windows 下已配 safe.directory；身份 Icstick <85265575+Icstick@users.noreply.github.com>（gh CLI keyring 认证，SSH 协议）
```

## 2. 常用命令

```bash
# 安装依赖（workspace 根）
pnpm install

# 测试（注意：DSH 沙箱下 node --test 的 runner spawn 被 EPERM 拦，
# 必须直接 node 单文件执行——node:test 同进程运行）
node test/ledger.test.mjs

# 类型检查（未来 types.d.ts 齐全后）
pnpm -r run typecheck

# Lint
pnpm -r run lint
```

## 3. 分支与提交规范

### 分支策略

```text
main                          ← 稳定基线：设计文档 + 定稿契约（本阶段所有提交）
feature/evidence-ledger       ← Evidence Ledger 正式实现（第一个）
feature/context-composer      ← Context Composer
feature/governance            ← 治理强化
feature/memos-provider        ← MemOS 实验后端
feature/work-continuity       ← Work Continuity

> 注：以上为 M1 时代的历史分支；M2/M3 采用 git worktree + feature 分支并行模式（见 LESSONS §4）。
```

**规则**：规划文档定稿 → 提交 main；功能实现 → 对应 feature 分支 → 合回 main。

### 提交规范（Conventional Commits）

```text
docs:   设计文档变更（规划阶段主力）
schema: 数据契约变更
feat:   新功能实现
fix:    修复
test:   测试
chore:  杂项（脚手架、配置）
```

示例：`schema: authority 7 值 — 写入时确定性声明`

## 4. 编码规范（对齐 DSH 插件核心）

1. **function plugin 形态**：`export const name / inject / Config / apply`，
   不导出默认 class（除非是 Service package）
2. **先 validate/execute/persist 成功后再 emit**；不维护可从 ledger 重建的第二份真相
3. **模型可见事实必须是 Session event**；waterfall listener 必须调 `next()`
4. **注册/监听/后台寿命属于 fiber/effect**，可 dispose；ctx.effect 返回 disposer
5. **不为测试扩大 public export**；不同时挂载同一 service key 的 provider
6. **node: 内置优先**：核心 bundle 零 npm 运行时依赖（node:sqlite/crypto/fs）
7. **错误码结构化**：INVALID_INPUT / DENIED / QUARANTINED / BUDGET_EXCEEDED 等，
   模型按 code 分支处理
8. **幂等优先**：Evidence id = hash(sourceRef + contentHash)，重放无副作用

## 5. 测试策略

| 层 | 方式 | 覆盖 |
|---|---|---|
| 单元 | `node test/*.test.mjs`（单进程） | store/governance/service 纯逻辑 |
| 契约 | `node test/conformance/*.mjs` | 幂等、authority 校验、budget ceiling、fail-open |
| 集成 | 真实 DSH profile + MemOS（手工/脚本） | pre-step 注入、跨 session 恢复 |

**验收 KPI 映射**（详见 BENCHMARK.md）：provenance 100% / 重放 0 / p95 ≤900 / fail-open / leakage 0 / rollback 100%。

## 6. 已知环境陷阱（Windows + DSH 沙箱）

```text
1. node --test runner spawn → EPERM；改用 node 单文件执行
2. git 管道组合命令（git status | Select）→ ResourceUnavailable；单命令执行
3. git dubious ownership → 已配 safe.directory（若新克隆仓库需重配）
4. ~/.gitconfig 写入（global config）→ 需 danger-full-access 升级
5. pwsh 可能非管理员（IsAdmin=False）——系统级操作（wsl/服务）需用户手动授权
```

## 7. 任务 Packet 模板（每个 feature 任务）

```text
Goal:     明确的完成目标
Baseline: DSH commit pin + 当前分支
Allowed:  允许改动的文件/目录
Invariant: 不可破坏的契约（如 Evidence idempotency）
Non-goals: 明确不做的事
Oracle:   如何验证（测试命令 + 预期输出）
```
