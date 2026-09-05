## 变更摘要

（做了什么、为什么——一两段即可）

## 验证

- [ ] `pnpm test` 通过（列出新增/受影响测试）
- [ ] `pnpm lint` 通过
- [ ] `pnpm depcruise` 通过（改动触及 src 依赖关系时）

## 架构影响（每 PR 必答）

- [ ] 触及模块边界或新增跨模块依赖（描述：）
- [ ] 新增/变更依赖（peerDependencies 之外需说明理由）
- [ ] 状态所有权 / 存储 schema 变更（账本类改动须说明迁移与重建路径）
- [ ] 公共 API / 类型契约变更（types.d.ts = breaking，需版本号与 README 同步）

## 文档同步

- [ ] README（中文主文档，行为语义变化必更）
- [ ] AGENTS.md（结构/纪律变化时）
- [ ] docs/adr/（涉及架构决策时新增 ADR）

## 关联

- 相关 issue / ADR 编号（若有）
