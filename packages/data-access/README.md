# @rip-dvd/data-access

This package is the only runtime persistence boundary for rip-dvd. Its public
interface speaks in Optical Drives, Disc Inspections, Detected Discs, Archive
Requests, Original Disc Archives, Media Items, Disc Selections, Encoding
Profiles, Archive Jobs, and Encode Jobs.
Drizzle tables, SQL, SQLite connections, and transaction objects remain
private. The migration-only `@rip-dvd/data-access/legacy-sidecars` entrypoint is
the sole format-named exception; it converts legacy persistence into those
domain records and does not expose Drizzle or SQLite. Aggregate identifiers are
opaque domain types, so callers cannot
cross-wire, for example, a Media Item ID into an Original Disc Archive field.

`createDataAccess()` opens the configured local SQLite file, configures WAL,
foreign keys, normal synchronization, and a 5000 ms busy timeout, then applies
the checked-in Drizzle migrations. A short-lived lock file beside the database
serializes first-run migrations across web and worker processes; stale locks
expire after five minutes. Opening an already-migrated file is safe.

`catalog.reconcileOpticalDrives()` applies one complete discovery snapshot in a
short transaction. Seen drives become present and advance `lastSeenAt`; drives
absent from a successful snapshot become missing without changing their last
seen time. A configured-device proof applies the enabled default once to a new
or stable known drive, including when a device alias becomes resolvable later;
subsequent enabled/disabled choices are preserved. A matching nonempty serial
is authoritative continuity evidence even when vendor or model text changes.
A changed stable serial, a loss or appearance of serial evidence, or a changed
model identity without matching serial proof is replacement hardware and is
atomically reset to disabled. After a disappearance, authorization is
preserved only when a matching serial proves physical-drive continuity;
uncertain same-path hardware is disabled. Retargeting a configured alias to a
different canonical device path consumes the configured default. A new or
identity-changed target is disabled, while an existing identity-stable target
keeps its current enabled/disabled authorization.

The package exports the versioned, bounded DVD title-map contract through
`@rip-dvd/data-access/dvd-scan`. Hardware parsing, worker persistence, and web
rendering share its schema-v2 decoder, stream limits, metadata types, and
content-ID validation instead of maintaining separate scan shapes.

Bounded dashboard reads keep current state ahead of history: every present or
enabled Optical Drive is returned before a capped history of disabled missing
drives. Detected Discs awaiting review, current Disc Inspections, nonterminal
Archive Requests, and Archive/Encode Job attempts remain bounded before recent
terminal history is added.
Pending catalog review pages use an archived-time and archive-ID keyset cursor,
so completing a visible review does not shift or duplicate later pages.

Catalog review is explicit rather than inferred from the first Disc Selection.
New Original Disc Archives remain in the review queue while a user builds a
partial set of selections, and `catalog.completeCatalogReview()` records the
review time only after at least one selection exists and the caller supplies
the archive's current `updatedAt` catalog revision. Completion compares that
revision atomically, so a stale review cannot approve a Disc Selection added by
another client. Creating another Disc Selection atomically clears the review
time and advances the revision, so encoding remains blocked until the changed
catalog is explicitly completed again. Media Item hierarchy mutations are
serialized, reject cycles, and cap parent-child chains at 32 levels without
limiting siblings or the total Media Item count.
The facade carries each DVD source as one immutable, validated
`DiscSelectionSourceIdentity` value instead of exposing a source key beside
parallel kind, title, and chapter fields. Its persistence codec alone flattens
that value into the normalized SQLite columns and derives the canonical legacy
source key. The facade rejects duplicate source slices, requires title
selections to reference the archived scan, and keeps chapter ranges within the
selected title; main-feature selections remain a distinct DVD source kind.
Full catalog validation for review completion and Encode Job enqueueing runs in
a consistent deferred read snapshot. Each operation then compares the archive's
monotonic catalog revision and writes in one short immediate transaction, so a
concurrent Disc Selection cannot reopen review between validation and the queue
or review write. Enqueueing also requires the referenced Encoding
Profile version to be active in the DVD video domain and rejects a final output
path already reserved by another logical job. Encode Job requeue and claim
operations also require the review boundary. Requeue preserves the referenced
historical profile version even when it is no longer active. Submitting the
same selection and profile preserves an existing Encode Job unchanged; only
explicit requeue can transition terminal work. Existing databases
preserve the review time for canonical main-feature-only catalogs. Caller-era
scan-dependent, noncanonical, or otherwise unsafe catalogs are reopened
conservatively, their active Encode Jobs fail visibly, and paged catalog
validation outside the writer lock is required before review can complete
again. Duplicate logical
slices, noncanonical source keys, missing DVD
titles, and out-of-range chapters fail that validation. Scan evidence referenced
by an Original Disc Archive is immutable across rediscovery, so reviewed
selection bounds cannot drift after enqueue. Migration-only legacy sidecar
imports use the same validator before publishing or retaining review state;
unsafe or newly added mappings leave the archive awaiting explicit review and
their queued jobs remain unclaimable. Bounded legacy title evidence is also
normalized for the review response and for title/chapter selection validation,
so archive-only imports can be reviewed without weakening current scan writes.
Disc Selection mutation preserves two distinct identity paths:

- **Ordinary retry identity.** A current-valid Disc Selection with any dependent
  Encode Job history cannot be repaired or removed. Every dependent job remains
  attached to the selection; `requeue()` of a terminal row resets the same
  logical Encode Job and preserves its retry identity.
- **Unsafe legacy quarantine.** A caller-era mapping that fails canonical-key or
  archived-scan validation is the only historical exception.
  `repairDiscSelection()` or `deleteDiscSelection()` deactivates the old Disc
  Selection rather than deleting it. Repair inserts a new active selection
  identity; removal inserts none. The inactive mapping and every dependent
  Encode Job remain as history, and the archive returns to review.
- **Retained completed provenance.** Completed Encode Jobs attached to the
  quarantined mapping remain terminal, preserve their original selection,
  profile, and output provenance, and continue to reserve their output paths.
- **Released failed-job reservations.** Failed Encode Jobs attached to the
  quarantined mapping, including upgrade-guard failures, are permanently
  ineligible. Only their output-path reservations are released, so a corrected
  mapping can enqueue a new logical job at the same path.

Job-free selections can still be removed normally.

Catalog Review reads Disc Selection action availability through a dedicated
facade query capped at 100 selection IDs. A job-free selection is editable and
removable. Ordinary Encode Job history locks the selection as provenance;
queued and running dependencies include their job ID and state in the reason.
Unsafe legacy selections remain a distinct Needs repair state and expose only
repair and removal when no active dependency blocks recovery. These reasons do
not include encode output paths. While legacy cutover repair is pending, the
archive fence suppresses every selection mutation action and explains that
changes are unavailable.

## Inspections, requests, and job attempts

`discInspections.beginOrResume()` admits one current insertion per Optical
Drive. Drive identity and media generation fence replacement, while a renewable
claim token fences stale worker callbacks. Structured metadata, hash bytes,
rate/ETA, attempt history, retry deadlines, reason codes, and bounded diagnostics
are persisted without display strings. The fifth consecutive transient failure
is terminal; manual retry preserves lifetime attempts while resetting only the
consecutive budget. Removal and replacement abort rather than fail.

`archiveRequests.create()` atomically approves a scanned Detected Disc and
records durable intent without creating an Archive Job. Pending requests wait
indefinitely. Failure moves a request to `needs_attention`; manual retry returns
it to `pending`; cancellation either completes immediately or enters
`cancellation_requested` until active external work stops.

`archiveJobs.startForInspection()` atomically rechecks a completed current
inspection, matching pending request, approved disc, enabled/present drive,
legacy identity barrier, existing provenance, and same-fingerprint/same-drive
execution exclusions before inserting a claimed running attempt. Every attempt
has its own ordinal and claim token. Publication inserts Original Disc Archive
provenance, archives matching observations, completes the attempt, and fulfills
matching requests in one immediate transaction. Failure and abortion update the
attempt and request together. A stale attempt cannot mutate a later attempt.

DVD title/chapter coordinates and Encoding Profile versions must be positive
safe integers at the facade. SQLite CHECK constraints also require integer
storage, preventing fractional values inserted through direct SQL.

## Encoding Profile versions

Encoding Profiles have a dedicated facade because callers must not choose or
rewrite version numbers. `create` inserts active version 1 within an explicit
media domain. `createVersion` inherits the source profile key and display name,
inserts the next sequential version with a new immutable settings snapshot, and
starts it inactive. `setActive` is domain-scoped and atomically deactivates any
active sibling before activation; deactivation may leave the logical profile
without an active version. `list` supports domain and active-only filters.

The database retains every version referenced by an Encode Job. Active state is
mutable selection policy, while the key, name, domain, version, and settings
that define historical job meaning have no update operation.

Archive Job execution, Disc Inspection hashing, and Encode Job progress use the
same one-second/five-percentage-point persistence policy. The first report is persisted
immediately. Later reports persist when at least one second has elapsed or the
reported value differs from the last persisted value by at least five
percentage points; intermediate reports are coalesced in memory. Completion
always persists 100%, and failure persists the newest coalesced value before
recording the terminal status. Encode Job reports also persist the HandBrake
phase and ETA; phase changes bypass percentage coalescing so scanning, preview,
and encoding transitions reach the database immediately. Terminal updates
clear an obsolete ETA, and requeue clears all prior progress fields. Encode
claims use a renewable one-minute lease with the same attempt-token guard.
Recovery moves at most 100 expired claims per call into visible failed state,
and every mutation from the expired attempt is rejected. The same transaction
records the expired claim's output path and token as durable partial-cleanup
provenance. Queued work with pending cleanup cannot be claimed, and cleanup
acknowledgement compares both retained values so a later path change cannot
orphan or acknowledge the wrong partial. Requeue is likewise rejected until
that provenance is reconciled or acknowledged. The encode worker also records
this provenance before filesystem publication, marks that cleanup as
publication-pending, and retains the partial inode until SQLite completion. A
failed or already-completed job with the exact flagged provenance can therefore
be completed by crash reconciliation before cleanup is acknowledged; cleanup
enumeration excludes running owners. A current publisher must atomically revoke
that flag before destructive rollback, so an expired attempt cannot undo a
publication already accepted by another process. Revoked-publication rollback
uses a recoverable cleanup lease, acquired by compare-and-set immediately before
the final rename. Cleanup acknowledgement authenticates that lease; while it is
held, other reconcilers cannot roll back from stale observations and requeue
remains blocked. Timeout cleanup and legacy cutover invalidation never set the
publication flag, so queued, cutover-invalidated, and unrelated attempts cannot
use the completion transition.

Requeue first grants replacement authority only when a completed Encode Job
keeps its output path. Explicit terminal requeue retains that authoritative
path for completed jobs and for failed replacements that still own their prior
final, preserving both SQLite provenance and the existing path reservation even
when the request supplies a different path. A failed job without retained
replacement authority may move to a new path. The worker records the owned
final's filesystem identity; failure retains authority only when the same
identity is still present, while recovery retains the stored identity for the
next attempt to recheck before HandBrake starts. The identity excludes
link-count ctime changes made by the worker's own rename and hard-link
restoration. Observing a different final revokes authority rather than
transferring ownership of an existing file at the destination.

## Transaction boundary

The facade deliberately has no general mutation `transaction(callback)` escape
hatch. The `readConsistentSnapshot()` boundary supplies only synchronous read
operations and keeps composed cross-table reads on one short SQLite snapshot;
it rejects asynchronous callbacks. The few multi-statement catalog mutations
use short internal transactions. Archive attempt start and Encode Job claim
return only after their atomic writes commit. Workers start external programs
only after those operations return; process execution never belongs in a
database transaction.
Encode publication persists a mutation token in one short transaction before
filesystem work begins. Identity callbacks inspect already-staged media entries
only outside writer transactions. Completion first commits while retaining the
token and cleanup provenance plus a durable completion-pending marker, rechecks
the media identity after that commit, then finalizes success in another bounded
write. A cross-boundary mismatch restores the nonaccepted state without
removing provenance; restart cleanup converts a mismatched tentative completion
back to failure before acknowledging that provenance. Recovery and legacy
cutover respect the persisted token, while a process-scoped filesystem lock
distinguishes a paused owner from an abandoned mutation. No media-filesystem
call or external process runs while SQLite holds its writer transaction.

## Legacy sidecar import

`legacySidecars.importLibrary()` is the idempotent migration boundary for
existing `.rip-dvd.json` files. It scans an originals library once, validates
schema-one and schema-two sidecars, and writes each valid sidecar to SQLite in
a short transaction. Valid jobs in a partially invalid sidecar still import;
invalid jobs and duplicates are returned in a structured report and keep their
archive pending review behind a durable repair marker, so a corrected live
sidecar can be recaptured on the next import. A wholly corrupt, oversized, missing-archive, or
otherwise unrepresentable sidecar prevents first cutover publication, leaving
every sidecar active for a supported repair-and-retry. Completion is inferred
from the final output file at import time. Relative recorded paths use the
legacy CLI's invocation-directory semantics; an existing sidecar-relative path
is accepted as a compatibility candidate, but two existing candidates are
reported as ambiguous. A missing or unreadable originals library is an input
error rather than an empty successful import.

Schema-two `created_at` and `updated_at` values provide the historical record
dates. When they are absent, the archive file modification time is the fallback;
a completed Encode Job uses its output file modification time. Re-import never
replaces an existing SQLite Encode Job's status, output, priority, progress, or
error, including an intentional retry.

Before committing any imported records, the migration-only entrypoint clears
catalog review and sets a persistent cutover fence for related existing
archives in one immediate transaction,
then atomically writes and synchronizes a `.rip-dvd-sqlite-catalog` marker at
the originals-library root. A marker failure exposes no imported SQLite state
and leaves those archives pending review; a restart after marker publication
safely resumes the idempotent import with the legacy queue already inactive.
The marker records the immutable logical-job configuration captured at
cutover, allowing restart/retry to report later sidecar conflicts while
preserving authoritative SQLite requeues. A parser, persistence, transaction,
or captured-source conflict changes the marker to a `repair` state: its
presence continues to block legacy workers, while a later complete and
parseable live inventory can replace the failed snapshot after repair. Repair
cannot retire the marker unless every previously captured sidecar is present.
Every schema-four retry re-fences the marker's captured archives before it can
return for incomplete live inventory, including after a database upgrade.
The SQLite fence independently blocks catalog completion and Encode Job
enqueue, requeue, and claim until the whole captured batch succeeds. Catalog
review timestamps are committed together only after that validation and only
for archives unchanged since the review boundary was staged. Existing Media
Items and Disc Selections remain SQLite-authoritative throughout initial and
recovery imports. A shared
library-scoped lease serializes discovery, marker publication, and import with
in-flight legacy archive/encode batches. It never writes the sidecars
themselves. All legacy archive and queue commands refuse a marked library,
making SQLite the enforceable catalog and queue authority. Recursive traversal,
the lease, and the cutover writer live behind the
`@rip-dvd/data-access/legacy-sidecars` entrypoint and are excluded from the web
runtime graph.

The repository-level `pnpm import:legacy-sidecars -- ...` command invokes this
facade operation for users and automation.

Generate and review schema changes with:

```bash
pnpm --filter @rip-dvd/data-access db:generate
pnpm --filter @rip-dvd/data-access db:check
```
