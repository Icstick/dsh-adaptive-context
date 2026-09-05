# ADR-0003：撤销语义 = supersede 方案甲（直接前驱）+ 两级冲突检测

- 状态：采纳（2026-08）
- 详情：acp-docs（GOVERNANCE.md / CONTRACTS.md）

## 背景
append-only 约束下，「用户纠正了之前的偏好」「两条证据冲突」如何表达？不能改旧证据，需要可审计的撤销链。

## 决策
采用 supersede 方案甲：
1. **新证据携带被替代证据的 id（直接前驱）**写入；getLineage 沿前驱链回溯完整谱系；
2. 冲突检测两级：
   - Level 1（确定性）：仅 `user_explicit / user_correction` 有资格直接 supersede；
   - Level 2（LLM reflector）：只产出 candidate，不自动落账，需确认/审批。

## 后果
- 撤销路径完整可审计（谁在何时以什么 authority 撤销了哪条）；
- 谱系查询有明确 API；视图只呈现 active 状态证据；
- 禁止「绕过两级检测直接改状态」的写入路径（测试守护）。
