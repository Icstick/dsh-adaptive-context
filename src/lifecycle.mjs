// src/lifecycle.mjs — Evidence state 迁移（supersede/quarantine/redact/rollback）。
// 规划：append lifecycle event → 更新 state → materialized view 重建；getLineage(id) 回溯演进历史。
// TODO(feature/evidence-ledger): 状态机 + getLineage
