# Domain Docs

How the engineering skills should consume this project's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the **project root** — this directory (`customer-service/`), not the repository root.
- **`docs/adr/`** — also under this directory. Read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context, with a project root that is not the repository root:

```
<repo root>/                 ← the DeepSeek Harness checkout; not our project
└── customer-service/        ← the project root, and what "root" means below
    ├── AGENTS.md
    ├── CONTEXT.md
    └── docs/
        ├── adr/
        │   ├── 0001-order-card-as-blocking-tool.md
        │   └── ...
        ├── agents/          ← this directory
        └── product-overview.md
```

The repository root is an upstream checkout of DeepSeek Harness. Everything under
`customer-service/` follows `docs/adr/0003-out-of-tree-local-plugin-directory.md`:
it is loaded through a `--patch` overlay and modifies nothing outside this directory.
Read that ADR before proposing a change that would reach outside it.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

The glossary deliberately avoids the word "User" for the person talking to the agent — the harness already uses it for its own identity and settings concepts. Say **Customer**.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (validation enforced by single-use grant) — but worth reopening because…_
