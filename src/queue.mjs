// src/queue.mjs — per-scope serial background queue。
// 规划：turn/end → enqueue；下一轮不等待（eventual consistency）；Cordis dispose 时 bounded drain。
// 详见 docs/CONSOLIDATION.md。
// TODO(feature/context-composer / v0.1): 实现
