# 契约测试（conformance）

> 验证 ACP 数据契约的不变量（对齐 BENCHMARK.md 验收 KPI）。

| 测试 | 验证点 |
|---|---|
| idempotency | 同 sourceRef+content 重放 3 次 = 1 条 Evidence |
| authority-consistency | external_tool+user_explicit 矛盾组合拒绝 |
| read-guard-matrix | quarantine 永不注入；external_information 无偏好权威 |
| budget-ceiling | Composer p95 ≤ 900 tokens/step |
| fail-open | Provider 宕机不阻断 DSH turn |
| rollback | supersede 后 rebuild view 一致 |

运行：`node test/conformance/<name>.test.mjs`（沙箱友好，同进程）
