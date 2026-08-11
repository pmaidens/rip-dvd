# P2-T01 — Add bounded database action aggregates

- Status: deferred
- Phase: 2 — Optimize action summary
- Parent plan: `obsidian-vault/Plans/multi-page-operations.md`
- Type: AFK-ready
- Dependencies: P1-T01
- Blocks: none
- Deferred reason: the exact 30-second summary is acceptable for the current local single-operator workload; revisit when catalog history or deployment scale materially increases.

## Why

The exact action overview currently reads complete matching histories inside one SQLite snapshot, then counts and sorts them in application memory. This is correct for the local library today but grows with permanent archive and job history.

## Work

- Add data-access queries that return exact `COUNT(*)` values plus the newest three preview records for each action category.
- Keep all categories in one consistent read boundary.
- Add indexes that support catalog-review and filesystem-verification predicates after measuring the query plans.
- Avoid large application-generated `IN (...)` lists when resolving preview labels.
- Preserve the existing action-overview response contract.

## Acceptance criteria

- Exact totals and preview labels match the current endpoint for the same database state.
- Query result cardinality stays bounded as archive and job history grows.
- A high-cardinality test covers thousands of historical jobs and verification records.
- Existing action overview API and component tests remain green.

## Validation

- `pnpm --filter @rip-dvd/data-access test`
- `pnpm --filter @rip-dvd/web test`
- Inspect SQLite query plans for the new count and preview queries.
