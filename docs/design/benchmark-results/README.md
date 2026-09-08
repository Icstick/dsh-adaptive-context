> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/design/。
> 内容截至 2026-09-03；与当前实现不一致处以本仓库 README.md / AGENTS.md / src 为准（acp-docs 仓库已归档）。
# Benchmark 结果归档

> 每 case 一次结果文件（git 提交），固定条件 + 指标 + 结论。

## 固定实验条件（复现基线）

```text
DSH commit/version: （实现时记录 exact pin）
LLM:                （实现时记录）
embedding:          （MemOS Provider 或本地降级）
context budget:     900 tokens
seed conversation:  （固定对话种子）
temperature:        （固定）
provider namespace: （独立）
```

## MVP 核心 4 case（feature/memos-provider 验收）

| Case | 场景 | 结果文件 | 结论 |
|---|---|---|---|
| A | 跨 session 显式事实 | case-A-2026-08-26.md | ✅ 通过 |
| B | 偏好及明确纠正 | case-B-2026-08-26.md | ✅ 通过（纠正语义） |
| F | 网页/tool poisoning | case-F-2026-08-26.md | ✅ 通过（含修复） |
| G | 写后立即读取 | case-G-2026-08-26.md | ✅ 通过（含修复） |

> 2026-08-26 首跑发现并修复 2 个缺陷：F 注入模式漏 preferences 变体、G 的 CJK 召回整串 LIKE 不命中。
> 详见各 case 文件"修复记录"。

## 模板

```markdown
# Case X — <场景名>

**日期**：YYYY-MM-DD
**固定条件**：（DSH pin / LLM / budget / seed / temperature）

## 过程
（注入序列）

## 指标
| 指标 | 值 |
|---|---|
| Recall@K | |
| Stale Truth Rate | |
| ... | |

## 结论
（通过/不通过 + 备注）
```
