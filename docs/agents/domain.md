# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists.
- `CONTEXT-MAP.md` at the repo root, if it exists. It points at one `CONTEXT.md` per context; read each one relevant to the topic.
- `docs/adr/`, if it exists. Read ADRs that touch the area you are about to work in.

If any of these files do not exist, proceed silently. Do not flag their absence and do not suggest creating them upfront. The `/domain-modeling` skill, reached via `/grill-with-docs` and `/improve-codebase-architecture`, creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```text
/
|-- CONTEXT.md
|-- docs/adr/
|   |-- 0001-example-decision.md
|   `-- 0002-example-decision.md
`-- rip_dvd/
```

Multi-context repo, signaled by `CONTEXT-MAP.md` at the root:

```text
/
|-- CONTEXT-MAP.md
|-- docs/adr/
`-- src/
    |-- context-a/
    |   |-- CONTEXT.md
    |   `-- docs/adr/
    `-- context-b/
        |-- CONTEXT.md
        `-- docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept needed is not in the glossary yet, either reconsider the wording or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly instead of silently overriding it.
