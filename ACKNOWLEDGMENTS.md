# ACKNOWLEDGMENTS — 致谢

dsh-adaptive-context（AdaptiveContextPlane，ACP）的设计与实现参考了以下开源项目。
谨向这些项目的作者与社区致以诚挚谢意。

## 致谢项目

| 项目 | 许可 | 对本项目的贡献 |
|---|---|---|
| **DeepSeek Harness (dsh)** | MIT | 宿主平台：本插件运行于 dsh 插件树（Cordis），热路径、审批门、事件钩子均基于其真实契约实现 |
| **MemOS** | Apache-2.0 | RecallProvider 设计模式参考：bounded recall（3s 前台 SLA）、per-session serial queue、fail-open 热路径纪律（见 PROVIDERS.md §2） |
| **Hindsight** | MIT | Observations / consolidation 认知模型参考：证据支撑的派生、refine 不覆盖、矛盾保留完整旅程（见 CONSOLIDATION.md） |
| **personagent** | MIT | Evidence→Candidate→Promotion 状态机与 promotion 策略参考：floors（min_events/min_strong）、strength 分类、可审计拒绝路径（见 EXPRESSION.md，2026 年许可变更为 MIT 后核实） |

## 说明

- 本项目为 **clean-room 参考实现**：仅借鉴上述项目的设计与模式（并已在设计文档中逐条标注来源），无代码复制。
- 各项目许可全文见其各自仓库。

License: MIT
