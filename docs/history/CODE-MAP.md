> 本文档迁移自 Icstick/acp-docs（commit 34e2840），2026-09-08 并入本仓库 docs/history/（开发史保档）。
> 内容截至 2026-09-03，仅作追溯；当前状态以 docs/DEVELOPMENT-PLAN.md 与 docs/PLAN-S2-MIGRATION.md 为准（acp-docs 仓库已归档）。
# dsh-adaptive-context — 代码地图（Code Map）

> 2026-08-27。仓库导航：结构、模块职责、数据流。M2 六任务合入后的最新状态。

## 1. 仓库结构（2026-08-27 拆分后）

```text
D:\DSH_workspace\my-plugins\
├── dsh-adaptive-context\        ← 核心插件（独立 git 库，master）
│   ├── package.json             ← dsh.bundle.patch → cordis.patch.yml
│   ├── cordis.patch.yml         ← 挂载 row: adaptive-context
│   ├── src\                     ← 见 §2
│   ├── test\                    ← 13 个测试文件（119 测试）
│   └── README.md                ← github 门面
├── dsh-work-continuity\         ← 行为层插件（独立 git 库，/checkpoint）
│   ├── src\store.mjs + index.mjs
│   └── test\work.test.mjs（8 测试）
└── acp-docs\                    ← 全部设计文档（14 份 + benchmark-results）
    ├── ARCHITECTURE / CONTRACTS / COMPOSER / GOVERNANCE / PROVIDERS
    ├── EXPRESSION / CONSOLIDATION / SCHEMA-REVIEW / BENCHMARK
    ├── DEVELOPMENT-PLAN / DEVELOPMENT / CODE-MAP / M2-PLAN
    └── HANDOFF-2026-08-25 / HANDOFF-2026-08-26 / README
```

> 旧 monorepo 位置 D:\DSH_workspace\dsh-adaptive-context 仅剩墓碑（历史归档）。

## 2. 核心插件模块图（src/，全部已实现）

```text
src/
├── index.mjs           入口：function plugin（export name/inject=['llm']/Config/apply）
│                      └ hooks：session/event→摄入+turn/end入队、agent/pre-step→注入、
│                        internal/service→llm 重挂载、dispose→ledger.close
│                        T3：pre-step 内 MemOS provider recall（hasProvider=true）
│                        T4：consolidation 装配（createConsolidator + buildLlmCall）
│                        T6：acp.requestPromotion 桥（expression）
├── service.mjs         Service Definition：ctx.acp
│                      └ append/get/setState/recall(allowSuperseded)/stats/export/
│                        correct/release/redact/delete/history(lineage)  [T5]
├── store.mjs           SQLite Provider：evidence + observation 双表（schema v2）
│                      └ evidence：append/query/byContentHash/listActive/stats
│                        observation：upsertObservation/queryObservation/
│                        getObservationLineage/listObservations  [T4]
│                        meta：getMeta/setMeta（consolidation 水位）  [T4]
├── constants.mjs       authority 7 值 / claimDomain 6 值 / state / 阈值
│                      └ SCHEMA_VERSION=2、CONSOLIDATION_MIN_*、observation 常量  [T4]
├── governance.mjs      writeGuard / readGuard / AUTHORITY_DOMAIN_MATRIX /
│                      assertAuthorityConsistent
├── extract.mjs         SessionEvent→Evidence 规范化（agent/inbox/spliced 等真实事件）
├── lifecycle.mjs       supersede/quarantine/redact/rollback/getLineage
├── composer.mjs        Context Composer：readGuard→rank→dedup→pack
│                      └ T1 self-echo 过滤（content 与 query 全等/包含排除）
│                        T2 contentHash 内容级 dedup  [T1/T2]
├── budget.mjs          section quota + ComposeTelemetry
├── consolidate.mjs     Background consolidation  [T4]
│                      └ createConsolidator：串行队列/背压/节流（≥10证据或≥5turn）/
│                        LLM 派生（重试1次后丢弃）+ 规则兜底 / 水位 meta
├── expression.mjs      Expression manual promotion  [T6]
│                      └ applyPromotionDecision / requestPromotion（approval 审批门）/
│                        buildPromotionRequest / REVIEW_STATUSES
└── providers/
    ├── recall-contract.mjs  RecallProvider 契约 + 校验
    └── memos.mjs            MemOS HTTP adapter（3s 超时 fail-open）  [T3]
```

## 3. 数据流（M2 后完整闭环）

```text
DSH session events
  │  session/event（(session, event) 签名）
  ├─ agent/inbox/spliced 等 → extract → writeGuard → evidence 表（append-only 幂等）
  │                                                              │
  │   agent/pre-step（step=1，await next() 后）                  │
  │     ├─ ledger.query(active) ──────────────┐                  │
  │     ├─ MemOS provider.recall（3s fail-open）┤ 合并候选          │
  │     └─ compose：readGuard → rank（hasProvider 语义分）→       │
  │        self-echo 过滤 → contentHash dedup → pack → 注入        │
  │                                                              │
  └─ turn/end → consolidate.enqueue()（fire-and-forget）          │
        └─ 节流达标 → LLM 派生（或规则兜底）→ observation 表      │
             ├─ 同键冲突 → 旧 superseded + lineage                 │
             └─ style 候选 → acp.requestPromotion → approval 审批门 │
                  └─ 通过/驳回 → evidence.metadata.reviewStatus     │
```

## 4. 测试地图（node test/<file>.test.mjs 单文件直跑）

| 文件 | 覆盖 | 测试数 |
|---|---|---|
| ledger.test.mjs | writeGuard/readGuard/幂等 | 11 |
| extract.test.mjs | 事件规范化（含真实事件形状） | 9 |
| lifecycle.test.mjs | state 迁移/lineage | 9 |
| read-guard.test.mjs | 资格矩阵/scope/temporal | 15 |
| composer.test.mjs | 排序/预算/self-echo/dedup/validAt | 18 |
| user-rights.test.mjs | 用户权利/写后即读 | 10 |
| providers.test.mjs | MemOS adapter/集成排序 | 7 |
| config.test.mjs | Schemastery Config | 2 |
| expression.test.mjs | promotion 审批门/桥 | 14 |
| consolidate.test.mjs | 节流/背压/LLM/兜底/冲突 | 15 |
| conformance/idempotency | 重放幂等 | 2 |
| conformance/authority | 权威一致性 | 4 |
| conformance/failopen | 故障不阻断 | 3 |

合计 119 测试。