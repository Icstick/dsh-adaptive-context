# ADR-0002：authority 模型 = 7 值确定性声明 + sourceClass 强制映射

- 状态：采纳（2026-08）
- 详情：acp-docs（GOVERNANCE.md）

## 背景
跨会话注入会携带不同可信度的信息（用户明说 vs 单次观察 vs agent 推断）。若无确定性分级，注入内容无法被下游判断信任权重，也存在把 agent 自述当用户事实的污染风险（实践中发生过）。

## 决策
authority 固定为 7 值（写入时确定性声明，实现锚点 src/policy.mjs）：
`system_policy / user_explicit / user_correction / single_observation / agent_inference / agent_self_evaluation / external_information`

- 来源类别（sourceClass）→ authority 为**强制映射**，`assertAuthorityConsistent` 校验不可绕过；
- authority → claimDomain 资格矩阵约束证据可进入的领域（external_information 可进 experience 等）；
- 审计记录每次写入的来源类别与 authority 声明。

## 后果
- 新增来源类型必须显式映射，否则写入被拒——安全核心，无旁路；
- 该 7 值为跨会话契约：增删值需先文档评审（改 authority 模型 = 影响全部下游消费方）。
