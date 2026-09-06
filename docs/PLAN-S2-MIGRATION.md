# PLAN-S2 — P3 画像层补全 + memento→ACP 迁移管道（B9 v0.3 S2）

> dsh-adaptive-context · 2026-09-05 定稿。上级：D:\DSH_workspace\docs\unified-memory-seam-design-2026-09-04.md（B9 v0.3）。
> 动机（用户 2026-09-05 反馈）：①memento 分层硬预算太少（agent 两层已满 3952/3907 @ 4000，
> 写入持续 BUDGET_EXCEEDED）；②跨会话跟踪限制——举例：三个并行会话，会话 A 完成"视觉工具更新"，
> 会话 B（另一视觉工作流）不知道已更新。
> 执行策略（用户授权自定）：**S2 迁移 + P3 先行；P9 跨会话变更通知单独立项**。

## 1. 目标与验收（对照 B9 §5 S2 + 用户反馈）

- [ ] memento/shared 数据迁入 ACP，对账 100%（条数 + 内容哈希）
- [ ] memento 摘 bundle 后注入 = ACP 单轨；无重复注入（memento 冻结块消失）
- [ ] **用户画像跨会话稳定可见**（P3：user_model 段由 user_explicit/user_correction 填充，跨会话放行）
- [ ] 旧会话无回归（ACP 278 基线 + 现有功能）；观察期 2 周（退役前不摘除）

## 2. 现状侦察（2026-09-05 实证）

| 项 | 数据 |
|---|---|
| memento memory.db | C:\Users\Administrator\.dsh\dsh-memento\memory.db（7.4MB，WAL）；schema v4 |
| entries | 25 条 8834 字符：agent/user-global 7 条 3952 / agent/workspace 10 条 3907 / user/user-global 4 条 547 / user/workspace 4 条 428（agent 两层已满） |
| proposals | 8 条（compaction-summary，pending——历史会话压档，精华已在 ACP） |
| audit | 567 行（历史审计，归档不迁正文） |
| shared-memory | memories 目录已不存在（空）——只摘 bundle |
| S1 状态 | P1 acp_query ✅ / P2 配额 ✅ / **P3 画像层未做** / P7 调度器 ✅ / shared 工具停用：待确认 |

## 3. P3 画像层补全（S1 遗留，迁移前置语义）

### 3.1 现状问题
- composer 的 readGuard 经 targetDomain='work'（config 默认）走 authority→claimDomain 矩阵——
  注入面语义混杂历史包袱；user_model 段（user_fact/user_preference → section user_model）的
  候选能否注入取决于 authority 对 targetDomain 列的资格，不是按候选自身 claimDomain 分组；
- F7 跨会话闸门（crossSessionPolicy=non-instructional 默认）：跨会话 user_input/user_correction
  **全部 dropped**——防"任意会话内容污染"，但把"用户已确认的偏好/纠正"也一并挡了（B9 P3 要放行的对象）。

### 3.2 放行语义（与 F7 正交的关键设计）
F7 防的是**原始会话消息**（低权威、未确认）跨会话污染。P3 放行的应是**稳定画像**：
- **可跨会话注入**：claimDomain ∈ {user_fact, user_preference}（→ section user_model）
  且 authority ∈ {user_explicit, user_correction}（用户直接声明/纠正 = 确定性）；
- **维持 F7**：user_input 的 single_observation 类（单次观察、未确认）跨会话仍 dropped；
  会话噪声不得冒充画像；
- **实现**：composer 跨会话闸门按 (section, authority) 判——user_model 段放行
  user_explicit/user_correction；其余段维持现 policy；targetDomain 语义改为
  "候选按 claimDomain 自然分组"（不再单域过滤）或明确移除 targetDomain 对读侧的约束
  （写入侧矩阵保留）。详细改法在实现时以 composer 现有 readGuard/utility 流程为准，
  保持 278 测试基线。
- 迁移数据同样遵守：memento user track（user_explicit 级）→ user_fact/style ✓ 跨会话可见；
  memento agent track 的 auto 写入条目按内容判 authority（多为 agent_self_evaluation，
  跨会话走 experience 段现 policy——受闸门管，符合"agent 自评不冒充用户画像"）。

### 3.3 配额（已就位 S1 P2）：user_model 800 / memory 350 / hotTokens 1600（正式 profile 已配）

## 4. P5 迁移管道（ACP repo scripts/migrate-memento.mjs）

### 4.1 映射（B9 §3 定稿 + 细化）
| memento | → ACP evidence | authority | claimDomain |
|---|---|---|---|
| user track（text 即人写） | append | user_explicit | 按内容：偏好→user_preference、纠正类→user_preference、一般→user_fact；source_ref=memento:<id> |
| user track（source=auto 的 agent 代写） | append | agent_inference | user_fact（如内容明确偏好可 user_preference——规则保守：agent_inference 不冒充） |
| agent track | append | agent_self_evaluation（环境事实/系统事实类按内容可 system_policy→external_fact） | experience 为主 |
| 超 500 字符条目 | 切分（≤500/条，content 规则同 evidence） | 同源 | 同源 |
| proposals ×8 | **不迁正文**：归档快照（db 备份即含）；ACP 已有其精华 | — | — |
| audit ×567 | ACP audit 记 op=import_memento（批次/条数/哈希）；原 db 归档 | — | — |

触发 consolidation：迁移后运行 consolidation 批次（观察期正常触发即可，
user track 重复性画像会被蒸馏进 user_model observation 轨道）。

### 4.2 流程（脚本三段式）
1. **dry-run**：读 memento.db → 生成迁移清单（映射后条目 + 校验：超长切分点、非法 authority 兜底）→
   输出 JSON + 统计（不写 ACP）；
2. **备份**：memento memory.db → archive\memento-backup-<date>\（WAL 一并复制/或 sqlite backup API）；
3. **执行**：逐条 ACP append（带 source_ref）→ 每批对账（ACP 侧按 source_ref=memento:* 计数 vs 清单）→
   哈希抽查 → audit 落账 op=import_memento（批次统计）。幂等：已存在 source_ref=memento:<id> 的跳过
   （重跑安全）。
4. 输出报告：{清单条数, 成功, 跳过(已存在), 失败, 哈希对账结果}。

### 4.3 观察期语义（重要）
- 迁移后 memento **仍在 bundle**（观察期 2 周，双轨并存）：memento 注入块（冻结快照）与 ACP
  单轨并存——**重复风险**：同一事实两侧各有一份。B9 §7 验收"无重复注入（同事实单轨单次）"
  在观察期难严格达成（memento 快照还在）；缓解：迁移完成即把 memento 层**清空数据但留插件**
  （entries 清空 → 冻结快照为空块，注入零成本）——比"双写观察"干净；回滚 = 从备份恢复 db。
  清空动作同样审计（op=memento_cleared_after_migration，快照留档）。
- 观察期内其他会话的 memory 工具写入 → 会重新长数据（清空后继续写）——退役前窗口有增量：
  处理 = 摘除日再做一次增量迁移（幂等脚本天然支持）或提前告知各会话改用 acp_query。

## 5. 退役步骤（观察期满后，用户确认）

1. profile：web bundle 摘 dsh-memento + dsh-shared-memory（package.json dependencies + bundles）；
   cordis.patch.yml 对应配置块删除（memento writePolicy、shared 相关）；
2. .dsh/dsh-memento 目录归档（memory.db 已备份）；
3. meow 残留目录（.dsh-meow，未启用）确认后删除（先备份）；
4. memory 工具语义：memento 摘除后 memory 工具消失——写记忆 = 对话自然摄入（自动轨），
   查记忆 = acp_query；显式"记住 X"语义走 S3 P4 显式通道设计（下一评审点，本期不实现）。

## 6. 执行顺序（本文件批准后）

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | P3 画像层：composer 闸门按 (section,authority) 放行 user_model 高权威 + targetDomain 读侧语义修正 | 新用例（跨会话 user_explicit 画像注入 / single_observation 维持 dropped）；278 基线不破 |
| 2 | scripts/migrate-memento.mjs（dry-run/备份/执行/对账/审计）+ 单测（临时库模拟 memento 结构） | dry-run 输出与手工核对一致；幂等重跑 |
| 3 | 真实 dry-run（正式 memento.db 只读）→ 报告给用户 | 清单人工过目 |
| 4 | 备份 + 执行迁移 + 对账报告 | 25 条全迁、哈希一致、audit 落账 |
| 5 | 清空 memento entries（快照空块）→ 观察期 2 周（用户拍板开始时间） | 注入无重复 |
| 6 | 观察期满：增量迁移 + 摘 bundle（§5） | 单轨运行 |

## 8. P3 代码侦察附录（2026-09-05 实装前发现，勿重复踩）

1. **user_input 的 authority 就是 user_explicit**（extract.mjs authorityOf：user_input→user_explicit，
   claimDomainOf：user_input→user_fact → section user_model）——**user_model 段 = 用户原始消息**
   的天然归宿。F7 non-instructional 挡跨会话 user_input 时，挡的也是 user_explicit/user_model。
   ⇒ P3 的放行对象**不能是 evidence 级 user_input**（那等于推翻 F7），必须是
   **observation 轨（consolidation 蒸馏产物）**：重复信号蒸馏出的稳定画像才跨会话放行。
2. **observation 轨现状**：store.listObservations(scopeId) 返回全部 active（无域过滤）；
   observation 表有 claim_domain 列；注入侧 observationToCandidate 传 o.claimDomain ?? 'experience'
   → user_model 域 observation 可自然进 user_model section。**observationInjection 默认 false
   （P1-1 2026-09-02 冻结：consolidation 失败吞批止血）——P3 = 打开开关 + 域路由 + 修复吞批遗留**。
3. **新坑：observation 候选 authority='single_observation'**（observationToCandidate 硬编码）
   → readGuard 的 authority→claimDomain 矩阵对 user_model 列很可能 ✗（注释"single_observation
   不影响 preference/style"）→ user_model observation 即使打开也会被 readGuard 挡。
   ⇒ 需要 observation 候选的特殊待遇（蒸馏产物 ≠ 原始 evidence：其权威来自 evidenceIds 溯源，
   矩阵应放行或绕过——设计点：observation 走独立 readGuard 分支或矩阵加行）。
4. **读侧 targetDomain 语义**（composer → readGuard 传 targetDomain='work'）：矩阵列查的是
   "authority 能否 claim work 域"，与候选自身 claimDomain 无关——历史包袱。P3 一并修正为
   按候选 claimDomain 查列（或 observation 分支绕过）。写入侧矩阵保留（写边界权威约束）。
5. 修完后的验收信号（用户例子）：会话 A 说"视觉工具更新了 X"数次/被纠正确认 → consolidation
   蒸出 user_model/experience observation → 会话 B（同 workspace，另一工作流）pre-step 稳定
   收到"用户画像/经验：视觉工具状态"——不再依赖词法召回。
6. P9（跨会话变更通知）与 P3 的关系：P3 解决"画像/经验稳定可见"（慢信号）；P9 解决
   "刚发生的完成事件即时感知"（快信号，轻量广播）——两者正交，P9 单独立项。

## 7. 决策点（需要用户拍板/知悉）

- D1 观察期清空策略（§4.3：迁后清空留插件 vs 双写观察）——本文件推荐**迁后清空**；
- D2 摘除 bundle 的时机与"其他会话正在用 memory 工具"的协调（观察期满后）；
- D3 分支策略：S1+S2 同分支（feat/memory-seam-s1）持续开发、S1 验收后整体合 master，
  还是 S1 先合 master、S2 新开分支——推荐**同分支续做，发布时整体评估**（S1 未发布功能已在
  正式实例跑=事实验收）；
- D4 P9（跨会话变更通知）另行立项（不在本规划）。

## 9. 执行进度（2026-09-07 追加，随执行更新）

| 步 | 状态 | 记录 |
|---|---|---|
| 1 P3 画像层 | ✅ 完成 | commit e3f46cf（store v5 溯源权威列）+ 04891c4（读侧 claimDomain 自然分组 + 注入接线）；20 新用例全绿；309 基线
| 2 迁移管道 | ✅ 完成 | commit 0dd9469（scripts/migrate-memento.mjs 三段式）+ 6f8ba20（scope-map flatten）；9+1 用例
| 3 真实 dry-run | ✅ 完成 | 25 entries → 32 候选（6 条切分）；guard block 0；清单见会话 dry-run 输出
| 4 备份+迁移+对账 | ✅ 完成 | 备份 .dsh/archive/memento-backup-20260906/；32/32 插入 0 失败；对账 32；审计 op=import_memento 落账
| 5 清空 memento + 观察期 | ⏳ 待拍板 | D1 推荐迁后清空；patch 已加 observationInjection:true（重启生效）
| 6 观察期满退役 | ⏳ 观察期后 | §5 步骤（用户确认）

执行中拍板记录：
- workspace 层 14 条 → **升 user-global**（用户选 A1：ACP workspace scope 无时间表，主工作区资产）
- agent 层 authority 用 **single_observation**（非 §4.1 原文 agent_self_evaluation——矩阵全 ✗ 会把 17 条工作记忆挡在注入面外；single_observation 忠实表达「一次观察」且可进 experience 段）
- 迁移证据 sessionId 不落列（sourceRef 承载原会话追溯）——稳定内容轨，F7 闸门不受影响

代码实现与 §8 侦察点的对应：observation 候选特殊待遇 = store 落库溯源权威列（v5）→ observationToCandidate 透传 → 读侧矩阵按候选自身 claimDomain 查列（§8.3/§8.4 双修正均落地）。
