# dsh-adaptive-context

DeepSeek Harness (dsh) 的 **AdaptiveContextPlane (ACP)** 控制面插件——带治理的上下文记忆系统。

## 核心能力

- **Evidence Ledger**：append-only SQLite 证据账本，7 值 authority × 6 claimDomain 资格矩阵，写入时确定性声明权威
- **Governance**：Write Guard（secret/PII/prompt-injection 确定性扫描）+ Read Guard（scope/state/资格矩阵过滤）
- **Context Composer**：agent/pre-step 注入（source-labelled plugin message），section quota 预算（MVP ≤900 tokens/step）
- **用户权利**：inspect / export / correct / release / redact / delete

## 设计铁律

> Evidence is truth; views are rebuildable. Confidence is not authority.
> Retrieval does not imply disclosure. Learning does not imply promotion.
> Memory does not own work continuity.

设计文档见配套仓库 **acp-docs**。

## 安装

profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-adaptive-context": "link:<path-to-this-repo>" },
  "dsh": { "profile": { "bundles": ["dsh-adaptive-context"] } }
}
```

## 配置（Schemastery schema）

```yaml
- id: adaptive-context
  config:
    ledgerDir: C:\\path\\to\\acp    # 显式路径（不依赖 DSH_HOME 环境变量）
    hotTokens: 300
    recallLimit: 20
    targetDomain: work
    debug: false
```

## 开发

```bash
node test/*.test.mjs   # 逐文件跑（沙箱下 node --test runner 受限）
```

License: Apache-2.0
