# ADR-0001：证据账本 = 自建 append-only SQLite

- 状态：采纳（2026-08）
- 详情：acp-docs（ARCHITECTURE.md / CONTRACTS.md）

## 背景
跨会话记忆需要「事实」与「派生视图」分离：事实必须可审计、可回溯、防篡改；观察/注入视图应该可随时重建。曾评估扩展 dsh-memento 或共享 memory 存储，但跨会话事实的权威性与治理模型（authority 分级）要求自有事实源。

## 决策
证据账本使用自建 SQLite（node:sqlite 单连接，WAL），**append-only**：
- evidence 表只插入；「删除」以状态表达（superseded / quarantined），绝不物理删除已写证据；
- observation / 视图（user_model、style、experience 等）全部可重建（rebuild.mjs），不入库为不可变事实；
- 审计三链（写/读/consolidation）独立落账；
- 事实源与 dsh-memento 并存互不迁移（各管各的）。

## 后果
- 备份 = 文件复制；重建工具保证视图可信；
- 多写者风险被单连接 + append-only 约束最小化（见 ADR-0001 配套体检）；
- 任何「修改历史」需求都必须走 supersede 语义（ADR-0003），不得直接 UPDATE。
