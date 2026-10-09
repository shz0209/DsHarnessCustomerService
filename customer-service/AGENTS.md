# 共享充电宝智能客服 — Agent 指南

本目录是一套独立的演示系统，挂在 DeepSeek Harness 检出之上，通过 `--patch` 覆盖层加载。
它**不修改本目录之外的任何文件**——包括 `packages/`。理由见
[docs/adr/0003](docs/adr/0003-out-of-tree-local-plugin-directory.md)，动工前先读它。

术语以 [CONTEXT.md](CONTEXT.md) 为准；已做出的取舍见 [docs/adr/](docs/adr/)。

## Agent skills

### Issue tracker

Issues live as GitHub issues on this repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context, anchored at this directory rather than the repository root. See `docs/agents/domain.md`.
