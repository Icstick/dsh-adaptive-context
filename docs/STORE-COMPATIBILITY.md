# DSH STORE 兼容来源与一次性 Profile 验收

关联：[DSH-Store #986](https://github.com/AI-Scarlett/DSH-Store/issues/986)。

## 当前证据

| 项 | 当前记录 |
|---|---|
| 插件版本 | `0.6.0`；本次修改仅补 manifest 和文档 |
| 本次核对的运行源码 | `2f24459f993501bae035727a21e98d7cfe99f606` |
| 兼容来源 | 2026-10-13，仓库作者在修复会话中声明：“0.2.0-rc1可以，后续不清楚” |
| 版本规范化 | 官方 release `dsh-v0.2.0-rc.1`，manifest 使用 `0.2.0-rc.1`；没有把 `rc1` 当另一版本 |
| 作者实际测试的插件 Commit | 未提供；不能把本次核对 Commit 当作作者报告绑定的测试 Commit |
| 作者实际测试的 Node.js / 系统 / Profile | 未提供 |
| 本次只读环境核对 | 本机 DSH CLI manifest 为 `0.2.0-rc.1`，Node.js 为 `24.15.0`；只是环境信息，不是运行验收 |
| install / start / uninstall / rollback | 全部 `unknown`：作者的“可以”不等于这四项分别通过 |
| 后续 DSH 版本 | `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 均 `unknown` |
| 独立安全审查 | 未执行 |

DSH 发布版本依据：
[0.2.0-rc.1 release](https://github.com/deepseek-ai/DeepSeek-Harness/releases/tag/dsh-v0.2.0-rc.1)。
`compatible` 是作者的来源声明，不是商城自动批准、所有系统兼容或完整生命周期验收。
主程序版本与 `@deepseek-ai/dsh-llm` 等子包版本分别记录，不要求版本号相同。

## 本次修改的验证（2026-10-13）

- 环境：Windows，Node.js `24.15.0`。
- `pnpm test`：652 个测试通过，0 失败、0 跳过。
- `pnpm lint`：0 warnings，0 errors。
- `git diff --check`：通过。
- 改动范围：`package.json` 兼容元数据、README、本文和 docs 索引；
  没有修改 `src`、客户端构建物、运行依赖或锁文件。
- 测试使用仓库测试夹具和临时数据；本次未执行一次性 DSH Profile 的完整
  分发安装、Web 可见性、卸载或回滚，不据此提升操作矩阵状态。

## 一次性 Profile 验收准备

下面是**待执行清单**，不是已完成结果。执行后保存脱敏日志、完整 Commit、时间和环境版本，
再更新对应操作矩阵；不要用单元测试或生产 Profile 的历史运行替代此记录。

1. 固定插件的 40 位 Commit，并记录 `git rev-parse HEAD`、插件版本、
   `dsh --version`、`node --version`、系统及安装的 peer 子包版本。
2. 为本次测试新建独立临时 DSH home 和 Profile，使用单独进程环境设置 `DSH_HOME`；
   不改常驻 DSH 的环境，不复用真实会话、账本、规则目录、凭据或配置。
3. 测试目录布局建议：

```text
<temporary-root>/
  dsh-home/profiles/acp-store-check/
  data/ledger/
  data/views/
  data/rules/
  evidence/
```

4. 本地源码验收按 README 的 link 安装方式，把临时 Profile 的依赖指向已 checkout 固定
   Commit 的插件目录，并把 `dsh-adaptive-context` 加入该 Profile 的 bundles。
   这种结果只证明本地 Bundle 路径；商城固定 GitHub Commit 的分发安装必须单独记录。
5. 确认当前 DSH 版本的 Profile 启动命令和端口参数；选择未占用端口。
   临时 Profile 配置中只放一条 `adaptive-context`，显式指定三个独立绝对目录：

```yaml
- id: adaptive-context
  name: dsh-adaptive-context
  config:
    ledgerDir: <temporary-root>/data/ledger
    viewsDir: <temporary-root>/data/views
    rulesDir: <temporary-root>/data/rules
    recallProviders: []
    autoPromote: false
```

6. 第一轮不配置 LLM 路由或外部 provider，不导入任何真实用户数据。仅使用合成输入，
   如“验收记忆：我偏好把示例配置放在独立目录”，并记录对应合成会话 ID。

## 操作验收与通过条件

| 操作 | 验证内容 | 需要保存的证据 |
|---|---|---|
| install | 依赖解析、Bundle 和 `adaptive-context` 入口唯一；来源固定到测试 Commit；配置只写入临时 Profile | 安装命令与退出码、来源/Commit、脱敏的 Profile manifest/patch、peer 版本 |
| start | 真正启动临时 DSH Profile，插件装配完成，无重复入口；创建 SQLite 账本和视图，记录 schema；通过真实合成会话验证摄入、查询及预期注入 | 启动日志、实际 Profile/端口、synthetic session/event ID、查询/注入回执；Web 目标还需配置卡片可见性证据 |
| uninstall | 停止测试进程，移除插件 dependency、bundles 项和手写 patch 配置，安装并重启；插件不再装配/监听，数据及视图保留 | 修改前后 Profile 差异、命令与退出码、重启日志、数据存在检查 |
| rollback | 恢复测试前的 Profile manifest/lockfile/patch 与数据快照，再启动原固定来源；数据、配置及功能恢复 | 快照标识/哈希、恢复命令、启动日志、合成数据查询结果 |

- 需要真实模型才能完成的会话/注入环节，如果缺少独立测试凭据，单独标 `unknown`；
  能启动或打开 SQLite 不能替代整项 start 通过。
- 备份时先停 DSH，使 SQLite 关闭；连同 WAL/SHM（若仍存在）、viewsDir、rulesDir、
  Profile manifest、锁文件与 patch 一并保存。存在 schema 迁移时，
  回滚旧插件也要恢复迁移前数据库快照，不能仅退回包版本。
- 外部服务测试另起一轮：明确测试 endpoint，保存实际 POST 字段、超时/失败降级结果，
  模型轮则记录 provider/model 与计费边界，日志不含密钥、真实记忆或私人路径。
- 卸载不删数据或规则视图；删除一次性测试数据前确认测试进程已退出、目标确实位于本次
  临时根目录，不能清理真实 `DSH_HOME` 或用户手写规则。

## 结果补录

每个 DSH 精确版本分别补录：

- 插件 Commit、DSH/Node.js/系统/Profile、检查时间；
- 安装来源及固定源校验，四项操作逐项结果和失败原因；
- 合成会话验证、Web 可见性和可选外部服务的覆盖范围；
- 可引用的脱敏证据路径或链接。

`unknown` 只在完成对应操作并保存证据后改为 `passed` 或 `failed`。
不把作者声明升级为独立审计，不把旧 Commit 的验收沿用到新运行代码。
