# Disc Inspection progress and Archive Request lifecycle

- **Status:** complete
- **Source request:** Add honest progress while an inserted DVD is inspected, including metadata activity and full-content hashing, then separate pre-execution archive intent from started Archive Job attempts.
- **Approved:** 2026-08-11
- **Domain references:** [CONTEXT.md](../../CONTEXT.md), [ADR 0001](../adr/0001-disc-inspection-owns-pre-identification-progress.md), [ADR 0002](../adr/0002-separate-archive-requests-from-jobs.md)
- **Implementation state:** All phases complete
- **Remaining HITL decisions:** none

> Historical implementation record. [ADR 0003](../adr/0003-archive-copy-is-the-only-full-disc-read.md)
> later removed full-content hashing from Disc Inspection and post-copy archive
> verification so the archive copy is the only complete disc read.

## Problem

The archive worker currently performs a potentially long DVD scan and full-disc content hash before it can claim an Archive Job. The dashboard only persists `ArchiveJob.progressPhase = inspecting_drive` at `0%`, so operators receive no meaningful feedback during this work.

That representation is also incorrect. Before hashing completes, the worker knows which Optical Drive it is examining but cannot prove which previously Detected Disc or queued Archive Job matches the inserted medium. Inspection progress and failures therefore cannot truthfully belong to an Archive Job.

The current approval model compounds this mismatch: approving a Detected Disc atomically creates a queued Archive Job even though no execution attempt has begun. This makes the job record carry operator intent, scheduling, drive inspection, retry state, and execution progress at once.

## Why this matters

- DVD metadata reads and content hashing can take long enough to look stalled.
- Users need honest progress rather than a fabricated percentage.
- Inspection failures must not be attributed to the wrong Detected Disc or Archive Job.
- Removal, replacement, operator cancellation, worker failure, and actual read failure must remain distinguishable for future reliability statistics.
- Archive Job history should contain started execution attempts, not unstarted intent.

## Goals

1. Make Disc Inspection a durable, insertion-scoped lifecycle with structured progress, findings, retries, outcomes, and history.
2. Show the current Disc Inspection as a distinct sub-item inside its Optical Drive item.
3. Show indeterminate metadata work with elapsed time and determinate hash work with byte progress, stable throughput, and approximate ETA.
4. Introduce Archive Request as durable operator intent, distinct from Archive Job execution attempts.
5. Create an Archive Job only when a completed current inspection matches a pending request and execution starts.
6. Preserve race safety, bounded process behavior, SQLite transaction locality, and stale-attempt fencing.
7. Provide truthful structured data for later inspection and archive success-rate analysis.

## Non-goals

- A full Disc Inspection history page.
- Resuming a content hash from a byte offset after process or worker restart; a restarted hash begins again at zero.
- A percentage estimate for `lsdvd` metadata reading; it exposes no reliable incremental percentage.
- Expiring pending Archive Requests automatically.
- Blu-ray or audio-CD inspection support in this slice.
- Changing Encode Job semantics.
- Adding a new frontend component library or a new visual language.

## Approved domain model

### Optical Drive

The long-lived physical device. Its dashboard item embeds only its current Disc Inspection. It does not own inspection progress or outcome history.

### Disc Inspection

One durable examination of one physical disc insertion. It remains the same inspection across worker restarts and automatic/manual retries while media-generation and drive-identity evidence proves the same insertion.

Lifecycle statuses:

- `running`
- `completed`
- `failed`
- `aborted`

Work phases:

- `reading_metadata`
- `hashing_content`
- `confirming_media`
- `retry_wait`

Rules:

- Only `running` is active.
- Ejecting or replacing media changes a running inspection to `aborted` with a structured reason.
- Ejecting an already completed or failed inspection does not rewrite its outcome; it only clears it as the drive's current inspection.
- A completed inspection remains authoritative while the same insertion remains current.
- Manual retry reopens the same failed inspection only when the same insertion is still current.
- A worker restart reacquires the same inspection, increments lifetime attempts, and restarts non-resumable work without incrementing failure counts.
- `attemptCount` never resets.
- `consecutiveFailureCount` controls automatic retries and resets after manual retry or successful completion.
- Abortion does not increment failure counts.
- Five consecutive transient failures exhaust the automatic retry budget: failures 1–4 schedule another attempt; failure 5 records `failed`.
- Clearly invalid metadata/content contracts fail immediately. Known transient drive/read readiness failures use bounded retry. Media change/removal aborts. Centralize and test this classification; do not parse it in the UI.
- Persist structured phase, progress, findings, timings, reason codes, and bounded diagnostics. Do not persist worker-authored display sentences.

Structured findings/progress must support:

- phase start time and inspection start/end times;
- volume label when known;
- title, chapter, audio-stream, and subtitle-stream totals;
- total content bytes and bytes hashed;
- stabilized bytes/second and approximate ETA, or an explicit not-yet-stable state;
- retry attempt number and next retry time;
- latest structured reason and bounded diagnostic;
- historical attempt/failure information sufficient to calculate attempts, recovery, failure phase, and final insertion outcome without parsing text.

Use normalized child attempt/failure rows if needed to retain reason history while keeping one Disc Inspection record per insertion. This is an implementation mechanism, not another user-visible domain item.

### Detected Disc

The fingerprinted catalog observation produced or refreshed after a Disc Inspection completes. A completed inspection links to the matching Detected Disc. Detected Disc remains factual catalog data and must not absorb request scheduling, retry, or cancellation fields.

### Archive Request

Durable operator intent to preserve a Detected Disc. A request may wait indefinitely for its matching disc and may produce multiple Archive Job attempts.

Statuses:

- `pending` — waiting for a matching completed current inspection;
- `running` — an Archive Job attempt is active;
- `needs_attention` — the latest attempt failed and requires manual retry or cancellation;
- `cancellation_requested` — cooperative shutdown of active work is pending;
- `fulfilled` — an Original Disc Archive was published;
- `cancelled` — the operator ended the request.

Rules:

- Approval creates an Archive Request, not an Archive Job.
- Waiting does not consume retries and never fails merely because time passes.
- A pending request can be cancelled immediately.
- Cancelling a running request sets `cancellation_requested`; the worker stops safely, records the active Archive Job as `aborted`, then records the request as `cancelled`.
- Retain cancelled and fulfilled requests as history.
- Manual retry moves `needs_attention` back to `pending`; the next matching execution creates a new Archive Job attempt.
- Permit a later new request after a cancelled request, while allowing at most one nonterminal request for the same Detected Disc.

### Archive Job

One started execution attempt for an Archive Request.

Statuses:

- `running`
- `completed`
- `failed`
- `aborted`

Rules:

- There is no queued Archive Job state.
- Execution phases remain `preparing`, `copying`, `verifying`, and `finalizing`.
- A job is created and returned with a claim token in the same atomic start operation that matches a completed current Disc Inspection to a pending Archive Request.
- Completion atomically publishes archive provenance, completes the job, fulfills the request, and preserves the existing fingerprint/drive concurrency invariants.
- Failure atomically fails the job and moves the request to `needs_attention`.
- Operator cancellation atomically aborts the job and completes request cancellation after external work has stopped safely.
- Stale worker attempts cannot update, publish, fail, or abort a later attempt.

## User experience

### Optical Drive item

Embed a visually distinct current **Disc Inspection** sub-item.

During `reading_metadata`:

- show an indeterminate animated indicator;
- show `Reading titles, chapters, audio, and subtitles · 25s elapsed` (copy may be refined while retaining meaning);
- update visible elapsed time in five-second buckets locally, without database writes;
- announce meaningful phase changes to assistive technology, not every timer tick.

After metadata is available, retain a compact findings line such as:

`LANGUAGE_DISC · 12 titles · 48 chapters · 6 audio · 4 subtitles`

During `hashing_content`:

- show a determinate progress bar and percentage;
- show human-readable bytes, for example `3.2 GB of 7.3 GB (44%)`;
- initially show `Calculating speed and time remaining…`;
- after a testable rolling estimator stabilizes, show throughput and approximate remaining time, for example `6.4 MB/s · about 11m remaining`;
- never display an unstable early estimate as authoritative.

During `retry_wait`:

- show a sanitized reason;
- show `Attempt 2 of 5 · retrying in 12s`;
- update the countdown locally once per second from persisted `retryAt`;
- retain raw command diagnostics only in bounded worker logs/persistence, not UI copy.

On `failed`:

- show a safe reason and **Retry inspection** action;
- retry is accepted only if the same insertion remains current.

On `completed`:

- initially show 100% and the findings;
- collapse to a compact `Inspection complete` summary after archive work completes;
- retain the compact summary until ejection/replacement;
- clearing the current inspection does not delete its history.

On ejection with no current inspection, show an appropriate no-disc/ready state using existing dashboard tone.

### Detected Disc item

Embed a visually distinct **Archive Request** sub-item rather than flattening request lifecycle fields into the Detected Disc itself.

- `pending`: waiting for matching disc + **Cancel request**.
- `running`: archiving now + **Cancel archive**.
- `needs_attention`: latest failure summary + **Retry archive** and **Cancel request**.
- `cancellation_requested`: cancellation in progress, controls disabled.
- `fulfilled`/`cancelled`: compact historical result without active controls.

Approval creates this sub-item. A Detected Disc can be approved after ejection because it is durable catalog history; that is a normal path to a pending request, not only a timing race.

### Archive Jobs section

- Show only started execution attempts.
- Group attempts by Archive Request.
- Show the active or latest attempt by default with an attempt count.
- Put older failed/aborted attempts in collapsed history to avoid duplicate-looking rows.
- Keep archive progress separate from inspection progress; do not duplicate the inspection bar on jobs.
- Update operator-attention counts to count requests needing attention rather than every failed historical job attempt.

### Accessibility and responsive behavior

- Use semantic progress bars. Determinate bars include `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`; indeterminate bars omit `aria-valuenow` and have an explicit accessible label.
- Keep phase/status changes in a polite live region; elapsed time, countdown ticks, percentage ticks, and throughput updates must not create repeated screen-reader announcements.
- Preserve focus-visible behavior and disabled/busy states for all mutations.
- Respect reduced-motion preferences for indeterminate animation.
- Validate the existing dark dashboard design at desktop and narrow mobile widths. Do not apply the unrelated Brimsley visual palette from generic planning guidance.

## Current codebase knowledge

### Worker and device pipeline

- [`apps/archive-worker/src/archive-worker.ts`](../../apps/archive-worker/src/archive-worker.ts) discovers and binds drives, begins a drive-wide inspection lease on queued Archive Jobs, calls `hardware.scanDvd()`, registers the Detected Disc, then claims a matching job and calls `preserveDvdArchive()`.
- `beginDriveInspection()` currently marks every queued approved job associated with a drive as `inspecting_drive`; this workaround must be removed when Disc Inspection has its own persistence.
- [`apps/archive-worker/src/optical-drive-dvd-scanner.ts`](../../apps/archive-worker/src/optical-drive-dvd-scanner.ts) performs media-generation checks, an opaque `lsdvd` metadata call, `blockdev --getsize64`, full-content hashing, a final media-generation check, and scan-data validation.
- The in-memory scan cache is keyed by device path and media generation. The durable Disc Inspection becomes the cross-restart authority; retain cache use only as a local optimization that cannot bypass persisted identity checks.
- [`apps/archive-worker/src/optical-disc-content.ts`](../../apps/archive-worker/src/optical-disc-content.ts) exposes `DiscContentReader.hash(devicePath, sizeBytes, signal)` with no progress callback and resolves only after the helper exits.
- [`apps/archive-worker/src/bounded-child-process.ts`](../../apps/archive-worker/src/bounded-child-process.ts) provides bounded helper-process lifecycle and single-flight tombstones. Preserve its critical invariant: capacity is released only after the OS-level `closed` signal confirms the child was reaped.
- [`docker/dvdcss-reader.c`](../../docker/dvdcss-reader.c) emits `bytes copied` on stderr for copy operations but emits no hash progress. Add bounded/throttled `bytes hashed` progress and parse it through a streaming seam. Do not buffer unbounded progress or let repetitive progress trip the current command-output cap.
- [`apps/archive-worker/src/dvd-archiver.ts`](../../apps/archive-worker/src/dvd-archiver.ts) is the best existing pattern for a streaming, bounded stderr progress parser with cancellation and process-reaping safety.

Recommended deep interface:

- Extend the content-reader seam to accept `onBytesHashed(bytes)` or introduce a dedicated hash runner with the same small interface.
- Hide spawning, progress parsing, throttling, cancellation, diagnostics, and tombstone ownership behind that interface.
- Do not expose child-process details to the scanner or worker orchestration.

### Persistence

- [`packages/data-access/src/internal/schema.ts`](../../packages/data-access/src/internal/schema.ts) currently stores inspection lease fields and `inspecting_drive` on `archive_jobs` and enforces one Archive Job per Detected Disc.
- [`packages/data-access/src/internal/create-data-access.ts`](../../packages/data-access/src/internal/create-data-access.ts) is the only runtime persistence implementation. It applies migrations on open, uses short SQLite immediate transactions for multi-record invariants, and intentionally exposes no general transaction callback.
- [`packages/data-access/src/types.ts`](../../packages/data-access/src/types.ts) defines opaque IDs and public facade interfaces. Add opaque IDs and immutable record types for Disc Inspection and Archive Request.
- Existing job progress coalescing persists immediately, then after one second or a five-percentage-point change. Reuse or generalize this policy for hash progress; phase changes and terminal transitions must persist immediately.
- SQLite uses WAL, foreign keys, normal synchronization, a five-second busy timeout, and a migration lock. No external process or filesystem call may run inside a database transaction.
- Drizzle migrations are generated with `pnpm --filter @rip-dvd/data-access db:generate -- --name=<name>` (verify local CLI argument forwarding), reviewed, checked with `pnpm db:check`, and applied by the runtime migrator.

Recommended persistence interfaces:

- `discInspections.beginOrResume(...)` owns current-insertion uniqueness and lease acquisition.
- A small discriminated progress/event command updates phase, metadata findings, hash progress, transient failure/retry, completion, failure, or abortion while checking the lease token.
- `discInspections.retry(id, currentGenerationEvidence)` performs the same-insertion check and resets only the consecutive retry budget.
- `archiveRequests.create/cancel/retry/list` owns request transitions.
- `archiveJobs.startForInspection(inspectionId, workerId)` atomically rechecks current inspection, detected fingerprint, request status, drive authorization/presence, existing archive provenance, same-fingerprint concurrency, and same-drive concurrency before inserting and claiming a running job.
- Archive completion/failure/abortion updates the associated request in the same short transaction.
- Keep callers unaware of SQL ordering and cross-table transition details; test through these facade interfaces.

### Web and activity updates

- [`apps/web/lib/dashboard.ts`](../../apps/web/lib/dashboard.ts) maps bounded consistent snapshots into dashboard DTOs.
- [`apps/web/app/api/dashboard/events/route.ts`](../../apps/web/app/api/dashboard/events/route.ts) emits a fresh snapshot over SSE once per second. This is sufficient for persisted hash samples; elapsed and retry countdown display should be derived locally.
- [`apps/web/components/operations-dashboard.tsx`](../../apps/web/components/operations-dashboard.tsx) renders all three affected sections and currently uses one generic archive/encode job progress row.
- [`apps/web/app/styles.css`](../../apps/web/app/styles.css) contains the existing dark dashboard surfaces, progress bar, status colors, and motion.
- [`apps/web/app/api/archive-jobs/route.ts`](../../apps/web/app/api/archive-jobs/route.ts) currently creates approval and a queued job together. Replace this mutation with an Archive Request creation route and add trusted same-origin cancel/retry routes for Archive Requests plus retry for current failed Disc Inspections.
- [`apps/web/lib/action-overview.ts`](../../apps/web/lib/action-overview.ts) and related tests may need request-based attention counts.

## Data model and migration requirements

This is a mixed schema/data migration and includes a SQLite table rebuild. Use the checked-in Drizzle `generate + migrate` workflow; do not use `push`.

### New persistence

Add normalized tables/constraints/indexes for:

- Disc Inspections, including drive, insertion/media-generation evidence, optional Detected Disc link, lifecycle, phase, structured findings/progress, lease, retry state, current flag/reference, terminal reason/diagnostic, and timestamps.
- Optional Disc Inspection attempt/failure history needed for durable statistics.
- Archive Requests, including Detected Disc, lifecycle, priority, timestamps, and cancellation/fulfillment state.
- Archive Jobs linked to Archive Request with an attempt ordinal and attempt-only statuses.

Required constraints include:

- at most one current Disc Inspection per Optical Drive;
- at most one nonterminal Archive Request per Detected Disc;
- at most one running Archive Job per Archive Request;
- unique Archive Job attempt ordinal within a request;
- valid status/phase/terminal-field combinations;
- byte/count/rate/ETA fields are null or bounded nonnegative integers;
- lease token/timestamp pairs are internally consistent;
- existing same-fingerprint and same-drive active execution exclusion remains enforced atomically at start.

Split Archive Job status constants from Encode Job status constants. Encode Jobs retain `queued`, `running`, `completed`, and `failed`; Archive Jobs do not.

### Existing-data transformation

Rehearse and test migration from the latest checked-in snapshot.

1. Create one Archive Request for every approved Detected Disc and every retained historical Archive Job as needed.
2. Map existing job state:
   - queued job → `pending` request and no Archive Job row, because execution never started;
   - running job → `running` request plus running Archive Job attempt;
   - completed job → `fulfilled` request plus completed Archive Job attempt;
   - failed job → `needs_attention` request plus failed Archive Job attempt.
3. Preserve IDs/timestamps/progress/error/provenance for started and historical jobs where practical; assign attempt ordinal 1.
4. Remove the old unique constraint that limited a Detected Disc to one Archive Job and add request/attempt constraints.
5. Drop Archive Job inspection phase/lease fields after data is safely represented.
6. Do not fabricate historical Disc Inspection records from old `inspecting_drive` rows. Their insertion identity and findings are unknowable. Convert their queued job to a pending request and let the worker start a fresh inspection from current hardware evidence.
7. Ensure approved discs without a job still receive a pending request.
8. Run `PRAGMA foreign_key_check` and explicit row-count/state assertions in migration tests.

Because the local stack is deployed as a coordinated web/worker/data-access version over one SQLite file, a single reviewed rebuild migration is acceptable. Before deployment, use the existing backup workflow; recovery should restore the pre-migration database and prior coordinated application version. Prefer roll-forward once new writes have begun.

## Concurrency, safety, and failure handling

- Persist separate lease/attempt tokens for Disc Inspection and Archive Job execution.
- On worker startup, reclaim a stale running inspection only when drive identity and media-generation evidence still match; otherwise abort it and create a new insertion record when appropriate.
- A stale inspection callback cannot update a replacement inspection.
- A stale Archive Job attempt cannot publish or alter its request.
- Cooperative request cancellation must reach the worker through renewal/current-state checks and abort the external copy process safely.
- Keep device paths, raw subprocess output, and filesystem paths out of dashboard DTOs.
- Continue using bounded diagnostic text and `formatFailureDetail`-style user-safe classification.
- Preserve single-flight tombstones for kernel-blocked optical reads; cancellation is not proof that a child exited.
- Progress updates must be monotonic within a hash attempt and bounded by total bytes.
- Throttle native progress emission and SQLite persistence so a full DVD does not generate unbounded stderr, memory, database writes, or SSE churn.
- Generate elapsed time and retry countdowns in the browser from persisted timestamps; never write every countdown tick to SQLite.

## API and interface changes

Expected public data-access additions/replacements:

- `DiscInspectionId`, `ArchiveRequestId`, and their lease/claim token brands.
- `DiscInspection`, `ArchiveRequest`, and attempt-only `ArchiveJob` types.
- Facades for Disc Inspection and Archive Request workflows.
- Replace `archiveJobs.approve/enqueue/requeue/claimNext` semantics with request creation/retry and atomic job start from completed inspection.
- Consistent dashboard read access for current inspections, relevant requests, and grouped attempts.

Expected web mutations:

- create Archive Request for a Detected Disc;
- cancel Archive Request;
- retry Archive Request from `needs_attention`;
- retry the current failed Disc Inspection.

All mutation routes must retain the existing trusted-origin/JSON/no-store behavior and return conflict/not-found/unavailable responses consistently. Route naming may follow current Next.js conventions, but `/api/archive-jobs` must no longer claim to create a job when it creates intent.

## Testing and validation plan

Use vertical red-green slices. Prefer real SQLite and real facade behavior over deep mocks.

### Unit tests

- Native/hash progress line parsing across chunk boundaries, malformed lines, monotonicity, and final flush.
- Rolling throughput/ETA estimator: calculating state, stabilization, zero movement, regression/restart, and completion.
- Inspection error classification into transient, immediate failure, and abortion reason codes.
- Formatting of byte totals, elapsed buckets, retry countdown, findings, and approximate ETA.
- Archive Job grouping by request and attempt order.
- Accessibility rendering for determinate versus indeterminate progress.

### Data-access integration tests

- One current inspection per drive and a new record only after proven insertion change.
- Worker restart reacquires the same inspection and advances attempts without recording failure.
- Lease theft/expiry rejects stale inspection updates.
- Automatic failure streak, retry scheduling, fifth-failure terminal behavior, manual reset, completion, and abortion.
- Completed inspection links to Detected Disc and remains authoritative while current.
- Request create, indefinite pending, cancel, retry, and one-nonterminal-request constraint.
- Atomic start creates a running job only for matching current inspection and pending request.
- Same-fingerprint and same-drive concurrent starts remain excluded, including multi-process concurrency coverage.
- Job complete/fail/abort transitions the request atomically.
- Publication and duplicate archive provenance behavior remains correct.
- Migration fixtures cover queued, inspecting, running, completed, failed, approved-without-job, and mixed historical rows.

### Worker integration tests

- Metadata phase persists immediately and exposes findings after `lsdvd` completes.
- Hash byte callbacks flow from reader to persisted inspection with bounded/coalesced writes.
- Same insertion after worker restart resumes the record and restarts hash honestly from zero.
- Removal/replacement during each phase aborts the old inspection and never consumes retry budget.
- Transient retry countdown and terminal classification.
- Completed current inspection starts a matching request without rehashing.
- No Archive Job exists before external archive execution starts.
- Active request cancellation kills/detaches safely, records job aborted, and records request cancelled.
- Failed execution creates a new attempt only after manual request retry.

### Web/route integration tests

- Trusted request creation, cancellation, archive retry, and inspection retry routes.
- Dashboard DTOs contain current inspection and structured request/attempt groups without paths or raw diagnostics.
- SSE snapshots reflect phase and sampled progress changes.
- Optical Drive renders metadata, calculating, stable hash, retry countdown, failed, completed, and cleared-current states.
- Detected Disc renders a distinct Archive Request sub-item and correct controls for every request state.
- Archive Jobs show latest attempt and collapsed prior history.
- Mutation busy/error behavior and keyboard-accessible controls.
- Operator-attention counts use `needs_attention` requests, not duplicate failed attempts.
- Update the existing end-to-end operations dashboard workflow integration test through inspection → request → started job → publication.

### Native and full validation

- Extend [`docker/test-dvdcss-reader.mjs`](../../docker/test-dvdcss-reader.mjs) to assert monotonic bounded hash progress and unchanged content identity.
- Run focused package suites while iterating.
- Final required commands:
  - `pnpm db:check`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- Run the compose worker smoke test if Docker is available: `pnpm test:compose-workers`.
- This is a visible UI change. Capture reviewer-facing desktop and narrow-width screenshots from a deterministic local state if the repo's available tooling supports it; do not add Playwright infrastructure solely for screenshots.

## Acceptance criteria

1. Inserting a DVD creates or resumes exactly one current Disc Inspection for that insertion.
2. Metadata work shows an indeterminate state, meaningful copy, five-second elapsed buckets, and no fake percentage.
3. Hashing shows monotonic bytes/percentage plus a calculating state before stable speed and approximate ETA.
4. Findings remain visible through later phases and are persisted structurally.
5. Transient inspection failures show safe reasons, attempt count, live retry countdown, and fail after the fifth consecutive failure.
6. Manual retry works only for the same current insertion and preserves lifetime statistics while resetting the retry streak.
7. Removal/replacement aborts active inspection without counting as failure; completed/failed history remains unchanged.
8. Completed current inspection is reused without another full hash.
9. Approval creates a pending Archive Request and no Archive Job.
10. A matching current inspection atomically starts execution and creates the first running Archive Job attempt.
11. Request cancellation and retry obey the approved lifecycle and remain race-safe.
12. Archive Job attempts use only running/completed/failed/aborted, remain grouped by request, and preserve older history.
13. Existing archive publication, duplicate suppression, stale-claim fencing, and filesystem safety tests remain green.
14. Existing databases migrate without losing started job history or approved intent; queued unstarted jobs become requests only.
15. Dashboard and API responses expose no device paths, filesystem paths, or raw subprocess diagnostics.
16. Determinate/indeterminate progress and live text meet the accessibility requirements above.

## Phased implementation tasks

All tasks are AFK-ready; no product or architecture HITL decisions remain. Keep phases sequential because the affected data-access facade, migration, worker orchestration, dashboard DTOs, and shared fixtures overlap heavily.

### Phase 1 — Persistence foundation (`complete`)

| ID | Status | Task | Dependencies | Validation |
| --- | --- | --- | --- | --- |
| P1-T01 | complete | Add domain constants/types/schema for Disc Inspection, Archive Request, and attempt-only Archive Jobs. Generate and customize the SQLite migration with the approved data transformation. | none | migration tests, `pnpm db:check`, data-access typecheck |
| P1-T02 | complete | Implement deep data-access workflow interfaces, leases, retry/cancel transitions, atomic matching/start, and atomic request/job terminal transitions. Replace old approval/queue inspection methods. | P1-T01 | focused data-access tests including concurrency |

### Phase 2 — Streaming Disc Inspection (`complete`)

| ID | Status | Task | Dependencies | Validation |
| --- | --- | --- | --- | --- |
| P2-T01 | complete | Add throttled native hash-byte output and a bounded streaming hash-reader interface without weakening process-reaping tombstones. | P1-T02 | native reader test, parser/runner unit tests |
| P2-T02 | complete | Refactor scanner/worker orchestration around durable insertion-scoped inspections, phases, findings, rate estimation, retries, restart recovery, completion, and media-change abortion. | P2-T01 | archive-worker unit/integration tests |
| P2-T03 | complete | Start Archive Job attempts only from completed matching inspections; implement cooperative request cancellation and per-attempt execution outcomes. | P2-T02 | workflow, cancellation, stale-attempt, publication tests |

### Phase 3 — Web workflows and presentation (`complete`)

| ID | Status | Task | Dependencies | Validation |
| --- | --- | --- | --- | --- |
| P3-T01 | complete | Replace approval-as-job routes with Archive Request create/cancel/retry and Disc Inspection retry routes; update dashboard/action-overview DTOs and SSE tests. | P2-T03 | route and dashboard integration tests |
| P3-T02 | complete | Render Disc Inspection under Optical Drive, Archive Request under Detected Disc, and grouped Archive Job attempts. Add timers, progress semantics, responsive styling, reduced motion, busy/error states, and accessible announcements. | P3-T01 | component tests and deterministic visual check |

### Phase 4 — End-to-end hardening and documentation (`complete`)

| ID | Status | Task | Dependencies | Validation |
| --- | --- | --- | --- | --- |
| P4-T01 | complete | Update workflow integration, legacy/cutover fixtures, concurrency worker, package README, root README, and domain references; remove obsolete `inspecting_drive` language and helpers. | P3-T02 | focused regressions then full validation commands |
| P4-T02 | complete | Rehearse migration and recovery, run full build/tests/compose smoke when available, inspect final diff for stale interfaces and unbounded queries, and update this plan to `complete`. | P4-T01 | all commands in Native and full validation |

## Implementation record

### Delivered

- Added durable, insertion-scoped Disc Inspections and normalized attempt history with fenced leases, structured findings/progress, bounded diagnostics, restart recovery, automatic retry, manual retry, completion, failure, and media-change abortion.
- Added Archive Requests as the durable intent lifecycle and converted Archive Jobs to started execution attempts with request-scoped ordinals, atomic start/terminal transitions, cancellation-wins race handling, stale-attempt fencing, and the existing drive/fingerprint exclusions.
- Added throttled native hash progress and a bounded streaming reader that keeps helper-process capacity owned until the OS-level `closed` event. Progress is monotonic, bounded, parsed across chunks, excluded from the diagnostic cap, and coalesced before SQLite persistence.
- Reworked archive-worker orchestration to inspect first, reuse completed current inspections, create a job only immediately before archive execution, poll cancellation independently of lease renewal, and quarantine output when cancellation wins publication.
- Added request/inspection mutation routes, bounded dashboard DTOs, request-based operator attention, nested Disc Inspection and Archive Request presentation, grouped job attempts, semantic determinate/indeterminate progress, local timers, reduced-motion behavior, and responsive mutation-safe controls.
- Updated root/package documentation, workflow fixtures, concurrency helpers, and tests; removed the obsolete Archive Job inspection helper and runtime `inspecting_drive` semantics.
- Review remediation replaced text-derived inspection classification with typed outcomes, split polling from focused inspection/archive runners, rechecks media generation after failed reads, defers manual retry until fresh worker evidence, roots related dashboard reads from visible records, retains completed-inspection detail until fulfillment, and derives retry copy from the consecutive failure streak.
- Terminal transitions now flush the newest coalesced progress and nullable estimates, publication fences stale claims before legacy reconciliation, and phase-specific media-change tests prove that removal/replacement never consumes retry budget.
- Expired cancellation recovery is bounded and cursor-rotated, proves cross-process device and partial inactivity, retains the shared device-inode exclusion through fenced finalization, and cannot starve rows beyond the first page. Normal copy obtains that same exclusion and reauthorizes the current claim before the native reader can touch the device or output. A timed-out lock helper is killed and detached without blocking the poll; any still-live inherited descriptor keeps later `/proc` proofs closed.
- After rebasing onto the current prompt-start scheduler, per-drive admission now keeps long inspection/archive work isolated to its drive and configured concurrency slot while available drives are repolled at the configured interval capped at five seconds. Completed inspections with pending requests are admitted in request-priority order. A completed inspection with no pending request remains idle before legacy reconciliation, without creating a job or logging a routine failure; a later request starts within the bounded interval even while another drive is blocked. Native copy capacity matches configured worker concurrency, while same-drive, same-fingerprint, device-lock, and stale-attempt fences remain authoritative.

### Migration and recovery rehearsal

- Generated and reviewed the versioned SQLite migration in `packages/data-access/drizzle/20260812151540_disc-inspection-archive-requests/` rather than using `push`. After current `main` added the Encode Job cancellation migration, regenerated its snapshot from that latest checked-in state and retained the reviewed archive-intent transformation SQL so the history remains linear and the latest snapshot describes the combined schema.
- Rehearsed both a fresh database and the predecessor schema. Fixtures cover queued/inspecting, running, completed, failed, approved-without-job, and mixed history. State/row assertions and `PRAGMA foreign_key_check` pass.
- Queued or legacy inspecting jobs become pending requests without fabricated job or inspection history. Started jobs are preserved as attempt ordinal 1 with their practical status, progress, error, timestamps, and provenance.
- Deployment remains coordinated across web, workers, and data access. Take the existing mode-0600 backup before deployment. If cutover fails before new-version writes, restore that database with the prior coordinated application version; after new-version writes begin, keep the new stack stopped and roll forward rather than running old code against the rebuilt schema.

### Deliberate deviations

- The obsolete `POST /api/archive-jobs` surface remains as an explicit HTTP 410 compatibility tombstone directing callers to Archive Requests. It no longer creates intent or work.
- The stale-partial ownership test in `dvd-archiver.test.ts` runs only where Linux `/proc` can prove writer ownership. macOS skips that platform assertion; production ownership/tombstone safety code is unchanged and the Linux Compose smoke covers the deployed environment.

### Final validation — 2026-08-12

- `pnpm db:check` — passed; Drizzle reports the schema and migration history consistent.
- `pnpm typecheck` — passed across all six packages/applications.
- `pnpm test` — passed locally with 845 tests, including 107 Archive Worker tests; macOS skipped the 9 Linux-only ownership assertions.
- `pnpm build` — passed, including the production Next.js build and both worker builds.
- `docker compose --profile validation build validation` — passed the pinned Node/pnpm toolchain check, native reader compile/test, all 854 tests (including all 116 Archive Worker tests and Linux ownership assertions), Drizzle consistency check, and all production builds on Linux.
- `sh scripts/smoke-compose-workers.sh all` — passed the native reader compile/test and named-volume plus bind-mount archive/encode worker smoke paths under UID 1000 after the final review fixes. The script deliberately retained its inspection resources under project prefixes `rip-dvd-worker-smoke-20260812152312-2172fdb630e68c21-named` and `rip-dvd-worker-smoke-20260812152312-2172fdb630e68c21-bind`, with bind source `/var/folders/nq/1b74p7fn7gn1d850ny6dr7d00000gn/T//rip-dvd-worker-bind-smoke.rrgKNR`.
- Deterministic browser verification passed at 1440×1000 and 390×844 with no horizontal document overflow. Reviewer evidence: `/private/tmp/rip-dvd-visual.V7yDMy/disc-dashboard-desktop.png` and `/private/tmp/rip-dvd-visual.V7yDMy/disc-dashboard-narrow.png`.
- Iterative parallel Standards/Spec review continued through the post-rebase scheduler integration and per-device cancellation-recovery fixes. Every finding was fixed and revalidated; the final round returned no Standards problems and no Spec problems.
- `git diff --check` passed. A stale-interface scan found `inspecting_drive` only in this historical plan text and the intentional predecessor migration fixture; no obsolete inspection/job interface remains in runtime code.
- The implementation branch was rebased onto current `origin/main` at `e7bdca4` while preserving its feature history. The source handoff remains at `98ae8d6` with exactly its four intended untracked planning/domain artifacts. `CONTEXT.md` and both ADRs in this worktree remain byte-identical to their source copies; this plan alone was advanced with implementation results as required.

## Risks and mitigations

- **Large SQLite rebuild:** Generate and review SQL, rehearse against migration fixtures, verify foreign keys and row/state counts, and use the existing backup workflow before deployment.
- **Cross-version incompatibility:** Schema and application semantics change together. Deploy web and worker as one coordinated stack after migration; do not run an old worker against the new schema.
- **Progress output explosion:** Throttle native emission, retain only bounded trailing diagnostics, coalesce database updates, and test a full-size byte count without allocating a full disc image.
- **Incorrect insertion attribution:** Require drive identity plus media-generation evidence for begin/resume/retry and fence every mutation with an inspection lease token.
- **Duplicate Archive Job starts:** Keep all matching and exclusion checks inside one short atomic persistence operation before spawning external work.
- **Cancellation races:** Treat cancellation as requested until the worker confirms external work stopped; stale completion must lose to token/status checks.
- **Dashboard growth:** Include only current inspections, relevant request sub-items, and bounded grouped job attempts in activity snapshots. Do not include all inspection history.
- **Misleading estimates:** Persist/display no throughput or ETA until the estimator meets a testable stability threshold; regressions restart the calculating state.
- **Accessibility noise:** Timer and progress ticks are visual updates, while live regions announce only phase and meaningful lifecycle changes.

## Handoff instructions

1. Read this plan, root [`CONTEXT.md`](../../CONTEXT.md), both linked ADRs, root `AGENTS.md`, and the persistence README before editing.
2. Mark this plan `in-progress` and P1-T01 `in-progress` when implementation begins; keep task/phase statuses synchronized in this file.
3. Preserve the current uncommitted domain documents and plan; they are intentional outputs of the approved design session.
4. Implement in the phase order above with vertical red-green loops and focused commits/checkpoints if the user later requests git delivery.
5. Do not reopen resolved product decisions. Ask the user only if an implementation discovery would materially contradict this plan or require destructive migration behavior beyond the documented transformation.
6. On completion, record validation results, any deliberate deviations, migration recovery notes, and screenshot paths/URLs in this plan before marking it `complete`.
