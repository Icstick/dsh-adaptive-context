// src/constants.mjs — ACP 枚举、阈值与固定值。零依赖。
// 语义来自 CONTRACTS.md：confidence/authority/durability/relevance 四维分离。

import { createHash } from 'node:crypto'

// v5（2026-09-07，PLAN-S2 P3）：observation 表新增 authority 列——蒸馏产物的溯源权威
// （写行时按 evidenceIds 聚合：user_correction > user_explicit > … > single_observation）。
// 存量库 ALTER TABLE，旧行 authority=NULL（读侧回退 single_observation）。
// v6（2026-09-07，T4 M4.1）：新增 rule 表（反馈通道规则——独立一等对象，
// evidence_ids 互链；draft/active/rejected/superseded 状态机）。
export const SCHEMA_VERSION = 7
export const DEFAULT_DB_NAME = 'acp-ledger.db'

/** Evidence 状态机 */
export const EVIDENCE_STATES = Object.freeze([
  'active',      // 正常可用
  'quarantined', // 可疑，不注入
  'superseded',  // 被新证据替代（不物理删除）
  'redacted',    // 内容被脱敏
])

/** Observation 状态机（派生认知，可版本化；冲突 supersede 只翻转 state） */
export const OBSERVATION_STATES = Object.freeze([
  'active',      // 当前生效版本
  'superseded',  // 被同键新 Observation 替代（不物理删除）
  // 2026-09-22（P1-4.1 S2）：**跨机导入的暂存态**。
  //   - 读侧只取 state='active'（store.listObservations / readActive），所以 quarantined
  //     天然不注入 —— 导入这个动作不需要「回滚」就能撤销效果；
  //   - 放行 = 翻回 active：scripts/ledger-import.mjs --release <manifest> --apply；
  //   - 与 evidence 的 quarantined 同义：记录但不可注入。
  'quarantined',
])

/** Observation 正文（浓缩认知）上限（字符）；原始大内容留在 Evidence（8000） */
export const MAX_OBSERVATION_TEXT_CHARS = 500

/** 规则兜底 Observation.subject 截断长度（内容前 N 字符） */
export const MAX_OBSERVATION_SUBJECT_CHARS = 40

/** 来源分类：决定写入时的权威约束 */
export const SOURCE_CLASSES = Object.freeze([
  'system',
  'user_input',
  'user_correction',
  'external_tool',
  'agent_authored',
])

/** 权威层级：从高到低（写入时确定性声明 7 值，2026-08-25 决策）。
 *  user_repeated_behavior 已移除——"多次观察累积"由 Observation 层表达。 */
export const AUTHORITY_ORDER = Object.freeze([
  'system_policy',
  'user_explicit',
  'user_correction',
  'single_observation',
  'agent_inference',
  'agent_self_evaluation',
  'external_information',
])
export const AUTHORITIES = Object.freeze([...AUTHORITY_ORDER])

/** 声明域：一条证据属于什么知识 */
export const CLAIM_DOMAINS = Object.freeze([
  'user_fact',
  'user_preference',
  'work',
  'experience',
  'style',
  'external_fact',
])

/** 敏感度 */
export const SENSITIVITIES = Object.freeze([
  'public',
  'private',
  'sensitive',
  'secret',
])

/** 会话类型：防 subagent 污染（OpenViking issue 教训） */
export const SESSION_TYPES = Object.freeze([
  'root',
  'subagent',
  'fork',
])

/** 作用域（对齐 dsh-memento 语义） */
export const SCOPES = Object.freeze([
  'user-global',
  'workspace',
])

/** Background consolidation 节流（决策 2B：未消化 ≥10 条 或 距上次 ≥5 turn） */
export const CONSOLIDATION_MIN_EVIDENCE = 10
export const CONSOLIDATION_MIN_TURNS = 5
export const CONSOLIDATION_META_WATERMARK_TS = 'consolidation_watermark_ts'
export const CONSOLIDATION_META_TURN_COUNT = 'consolidation_turn_count'

/** Consolidation 批次与频率上限（P0-4，2026-09-02）。
 *  背景：批次原为「全部未消化 active 证据」且 prompt 全文 JSON 化，无上限 →
 *  多子代理高频 turn/end 时是唯一的成本放大面（denial-of-wallet）。 */
export const CONSOLIDATION_MAX_BATCH = 40
// P3 修复（2026-09-06）：单条证据正文截断 800→400——输入越短，模型越不容易逐条复制展开
// （55 连败实测：8 条 × 800 字输入 → ~12K token 机械输出撞 maxTokens）
export const CONSOLIDATION_MAX_CONTENT_CHARS = 400
export const CONSOLIDATION_MAX_RUNS_PER_DAY = 24

/** P0 源头过滤（2026-09-09）：agent 自产的 experience 动作流水不进蒸馏队列。
 *  实测（.dsh/acp 账本）：pending 2791 条中 2582 条（92.5%）是 agent_authored/experience
 *  的过程日志（"111/111 全绿"、"合并树全绿"）。prompt 契约（T2.5）本就要求这类批
 *  输出 {"observations":[]}——送进 LLM 只是白烧配额：4 条/run × 24 run/天 = 96 条/天，
 *  清完 2791 条需 ~29 天（实际受 turn/end 触发限制更慢）。过滤后 pending 降到 ~209 条。
 *  语义：仍在账本内（append-only 不删），只是不参与蒸馏。 */
export const CONSOLIDATION_SKIP_AGENT_EXPERIENCE = true
/** 工具输出转写（sourceClass === 'external_tool'）不进蒸馏队列（2026-10-04 审计 P0-1）。
 *  **2026-10-04 已打开（妹妹的决定：先 shadow 看过，再开）。**
 *
 *  背景（实测）：蒸馏队列积压 7,773 条里 **7,156 条（92%）是 external_tool** ——
 *  命令输出、文件内容、检索结果的**转写**。它们不是「关于用户的事实」，
 *  送进 LLM 只消耗配额；而队列头原本没有这道过滤，进水 1,068/天 vs 出水 480/天，
 *  **永不收敛**（水位停在 2026-09-27，落后 7 天）。
 *
 *  **打开前的 shadow 期做了什么**：这道过滤比前两道狠得多（一次性剔除九成队列），
 *  所以先做成「可开、可观测、可回滚」的开关跑了一段时间 —— 期间 `false`，
 *  行为与改动前完全一致（有测试守护：`test/consolidate-skip-external-tool.test.mjs`）。
 *
 *  **打开后的观察点（验收判据）**：
 *  · 水位 lag（`.tooling/scripts/dsh-doctor.mjs` 的「记忆水位」项）应从「落后 7 天」往当天收；
 *  · 若收敛，说明积压主体确实是工具转写；若不收敛，说明还有别的进水侧，**回来重看分布**。
 *
 *  **回滚**：把这里改回 `false`（或装配处传 `skipExternalTool:false`）。
 *  语义不变：仍在账本内（append-only 不删），只是不参与蒸馏。 */
export const CONSOLIDATION_SKIP_EXTERNAL_TOOL = true
/** 工具输出转写（sourceClass === 'external_tool'）不进**注入面**（2026-10-04 审计，妹妹拍板）。
 *  姊妹项：上面那条是**蒸馏侧**（不进队列），这条是**注入侧**（不进模型上下文）。
 *
 *  背景（实测，evidence/lead-verify/）：
 *   · memory 段候选 **99.7% 是 external_tool 转写**（394/395）；
 *   · 全库 external_tool **13,598** 条 vs 真人来源（user_input/user_correction）**1,023** 条 = **13.3 : 1**；
 *   · 396 条候选抢 memory 段 290 token 配额 → 只进 8-10 条，全是这种：
 *       {"kind":"background","jobId":"pwsh-38"}
 *       [SELFDEV-LOG 56 written] SELFDEV-LOG=1605 行
 *       === job pwsh-144 status: running ===
 *   ⇒ **记忆段里装的不是「记忆」，是工具的过程记录。**
 *
 *  ⚠️ 已知代价：memory 段会**大幅变空**（候选里 99.7% 被挡）。**那是有意的** ——
 *  空着比装满工具回执好；真正该进这段的是工具输出里「有内容的部分」（检索结果、文件正文），
 *  而那个边界**这一版没有划**（留给后续；划错了会把有用材料一起挡掉）。
 *
 *  验收判据：新会话的 memory 段注入项里不再出现 external_tool；
 *           `.tooling/scripts/dsh-doctor.mjs` 的上下文水位应下降（少了这些碎片）。
 *  回滚：把这里改回 `false`（行为与改动前一致）。
 *  语义不变：仍在账本内（append-only 不删），只是不参与注入。 */
export const INJECTION_SKIP_EXTERNAL_TOOL = true
/** 纯应答短消息（「继续」「重启好了」）不进蒸馏队列（2026-09-22）。
 *  背景：A1 收掉模型自产之后，蒸馏队列里只剩用户消息，而其中一大半是零信息的
 *  续跑/确认。送进 LLM 只会产出「用户 确认」类垃圾 observation（weaver wv-20260911-151
 *  记的 47% 丢弃率就是这批）。仍在账本内（append-only 不删），只是不参与蒸馏。
 *  判据见 consolidate.mjs 的 isAckText：**保守**，只认剥离应答词后剩不下实义字符的短句——
 *  「可以push」「B+C吧」「行，那就2吧」这类必须留住。 */
export const CONSOLIDATION_SKIP_ACK_ONLY = true
/** 纯应答判定的长度上限（归一化后字符数）；超长一律不判应答 */
export const ACK_ONLY_MAX_CHARS = 20
/** 失败留痕与日频计数（P0-1/P0-4） */
export const CONSOLIDATION_META_FAIL_COUNT = 'consolidation_fail_count'
export const CONSOLIDATION_META_LAST_FAILURE = 'consolidation_last_failure'
export const CONSOLIDATION_META_RUN_DAY = 'consolidation_run_day'
export const CONSOLIDATION_META_RUN_COUNT = 'consolidation_run_count'

/** 错误码 */
export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  DENIED: 'DENIED',
  QUARANTINED: 'QUARANTINED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
})

/** 写入最大内容长度（字符） */
export const MAX_EVIDENCE_CONTENT_CHARS = 8000

/** 确定性 content hash（sha256 hex） */
export function hashHex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 幂等键 = hash(sourceRef 规范化 JSON + contentHash)，重放同一事件必然得到同一 id */
export function evidenceIdOf({ sourceRef, contentHash }) {
  const src = sourceRef ? JSON.stringify(sourceRef) : ''
  return 'ev_' + hashHex(src + '|' + contentHash).slice(0, 24)
}

// ── Dreaming（离线巩固，2026-09-22）────────────────────────────────────────
// 设计见 docs/design/DREAMING.md。第一增量只做三件确定性的事：归并 / 复现计数 / 遗忘（全零 LLM）。

/** 候选记忆状态机（对齐 wv-20260901-001 的 candidate→observed→consensus→approved，加 rejected） */
export const CANDIDATE_MEMORY_STATES = Object.freeze([
  'candidate', 'observed', 'consensus', 'approved', 'rejected',
])
/** 归并判据：同 claimDomain 内 CJK bigram Jaccard ≥ 此值 → 同簇（1 = 只有完全相同才合并） */
export const DREAM_CLUSTER_JACCARD = 0.55
/** 簇内成员数 ≥ 此值才算「复现」 */
export const DREAM_OCCURRENCE_MIN = 2
/** 复现门槛：跨 ≥N 个不同 session 或 ≥N 个不同自然日 → consensus */
export const DREAM_SESSION_MIN = 2
export const DREAM_DAY_MIN = 2
/** 遗忘（只做标记，不删）：superseded observation / quarantined evidence 超过此天数进冷存清单 */
export const DREAM_ARCHIVE_DAYS = 90
/** 簇代表正文上限（与 observation text 上限一致，防止代表行超长） */
export const DREAM_REPRESENTATIVE_MAX_CHARS = 500