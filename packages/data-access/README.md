# @rip-dvd/data-access

This package is the only runtime persistence boundary for rip-dvd. Its public
interface speaks in Optical Drives, Disc Inspections, Detected Discs, Archive
Requests, Original Disc Archives, Media Items, Disc Selections, Encoding
Profiles, Archive Jobs, Encode Jobs, and Retained Encode Outputs.
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
drives. The dashboard identifies inserted Detected Discs through current Disc
Inspections, caps that set before loading details, and filters Archive Jobs to
those Detected Discs before applying active and terminal-history bounds.
Nonterminal Archive Requests and Encode Job attempts remain bounded before
recent terminal history is added.
Pending catalog review pages use an archived-time and archive-ID keyset cursor,
so completing a visible review does not shift or duplicate later pages.

Catalog review is explicit rather than inferred from the first Disc Selection.
New Original Disc Archives remain in the review queue while a user builds a
partial set of selections. `catalog.completeCatalogReview()` requires the
archive's current `updatedAt` catalog revision and an explicit outcome:
`reviewed_with_selections` requires at least one active selection and makes
those selections encode-eligible, while `archive_only` requires no active
selections and creates no encode work. Completion records the review time and
compares the revision atomically, so a stale review cannot approve a Disc
Selection added by another client. Creating another Disc Selection atomically
returns the outcome to `needs_review`, clears the review time, and advances the
revision, so encoding remains blocked until the changed catalog is explicitly
completed again. Media Item hierarchy mutations are
serialized, reject cycles, and cap parent-child chains at 32 levels without
limiting siblings or the total Media Item count.
`catalog.createMappingProposal()` either creates one proposed Media Item or
reuses one explicitly selected existing Media Item, then creates its exact DVD
Disc Selection in the same immediate transaction against that revision.
Invalid source coordinates, missing reuse targets, Assisted Mapping attempts
to reuse an exact source, assisted-hierarchy violations, and stale revisions
therefore leave no partial mapping behind. `catalog.searchMediaItems()` is an
explicitly bounded,
offset-paged title search used by the separate full-catalog reuse surface. The
`catalog.createEpisodicMappingProposal()` transaction creates or explicitly
reuses a TV Show and its numbered Season, then creates one numbered Episode and
one whole-title Disc Selection for each of up to 512 proposal entries. Existing
hierarchy targets must already have the conventional TV Show/Season shape;
invalid entries, mismatched reuse targets, duplicate titles, and stale catalog
revisions roll back the entire hierarchy and every selection.
The bounded `catalog.listMediaItemMaintenance()` read reports child counts, active
and historical Disc Selection reference counts, referenced-archive scope, and
path-free deletion availability. `catalog.deleteMediaItem()` runs the same
checks in an immediate transaction and deletes only an unused leaf; it never
cascades into hierarchy children, Disc Selections, or Encode Jobs. Media Item
metadata and hierarchy updates do not alter Original Disc Archive review state.
The Assisted Mapping contract requires numbered Season/TV Show and Episode/Season
shapes and limits Trailer or Bonus Feature parents to a Movie, TV Show, Season,
or Episode; ordinary `createMediaItem()` and `updateMediaItem()` remain flexible
for imported and unusual hierarchies.
The facade carries each DVD source as one immutable, validated
`DiscSelectionSourceIdentity` value instead of exposing a source key beside
parallel kind, title, and chapter fields. Its persistence codec alone flattens
that value into the normalized SQLite columns and derives the canonical legacy
source key. Manual mapping, ordinary job-free source edits, and correction may
persist intentional overlaps,
including identical whole-title or chapter-range sources, while every Disc
Selection retains a separate identity. Assisted Mapping rejects whole-title
reuse and intersecting chapter coordinates in its immediate transaction. Title
selections must reference the
archived scan, chapter ranges stay within the selected title, and main-feature
selections remain a distinct DVD source kind. The schema migration replaces
the former active-source unique index with a non-unique lookup index, preserving
existing Disc Selection, correction, and Encode Job rows unchanged.
Full catalog validation for review completion and Encode Job enqueueing runs in
a consistent deferred read snapshot. Each operation then compares the archive's
monotonic catalog revision and writes in one short immediate transaction, so a
concurrent Disc Selection cannot reopen review between validation and the queue
or review write. Enqueueing also requires the referenced Encoding
Profile version to be active in the DVD video domain and rejects a final output
path already reserved by another logical job. Encode Job requeue and claim
operations also require the review boundary. Requeue preserves the referenced
historical profile version even when it is no longer active. Submitting an
ordinary initial job for the same selection and profile preserves that existing
Encode Job unchanged; only explicit requeue can transition terminal work.
Corrected lineage may retain multiple same-profile jobs for one active
selection because every successor has a distinct predecessor link. Existing
databases preserve the review time for canonical main-feature-only catalogs. Caller-era
scan-dependent, noncanonical, or otherwise unsafe catalogs are reopened
conservatively, their active Encode Jobs fail visibly, and paged catalog
validation outside the writer lock is required before review can complete
again. Noncanonical source keys, missing DVD
titles, and out-of-range chapters fail that validation. Scan evidence referenced
by an Original Disc Archive is immutable across rediscovery, so reviewed
selection bounds cannot drift after enqueue. Migration-only legacy sidecar
imports use the same validator before publishing or retaining review state;
unsafe or newly added mappings leave the archive awaiting explicit review and
their queued jobs remain unclaimable. Bounded legacy title evidence is also
normalized for the review response and for title/chapter selection validation,
so archive-only imports can be reviewed without weakening current scan writes.

Disc Selection Correction exposes a bounded
`catalog.listCorrectedEncodeReplacementPlans()` read for affected historical
Encode Jobs. Each proposal carries the prior Encoding Profile and output path;
operators must explicitly opt each replacement in or out and may override both
values. `catalog.completeCatalogReviewWithReplacements()` rechecks the catalog
revision and commits review completion, replacement Encode Jobs, predecessor
links, and output reservations in one immediate transaction, with at most 100
selected replacements per atomic completion. Predecessor readiness stays false
while the predecessor is active or has fenced cleanup/publication work, then
becomes true automatically after a safely terminal predecessor. The successor
then becomes claimable without releasing the transferred output reservation.
For the same output path, a completed predecessor or a failed/cancelled
predecessor protecting a retained final transfers replacement authority to the
successor; a failed predecessor without a retained final leaves the successor
in initial-output mode and releases its obsolete reservation when review and
all cleanup/publication fences permit it. Cancelling a queued same-path
successor retains its transferred reservation, even in initial-output mode, so
neither a still-stopping predecessor nor a retained final can become
unprotected. Corrected publication retains the prior final at its canonical
path while encoding. Before filesystem cutover, the publication-mutation fence
stages the canonical claim-scoped retained path and prior-final identity in a
private SQLite authority row. The facade derives that path from the persisted
running job and resolves its existing output directory before the write
transaction; caller claim fields cannot select another directory. Every normal
and recovery completion must match that row. Successful atomic cutover records
the displaced output's predecessor,
replacement, private path, filesystem identity, and retention time in
`retained_encode_outputs` before replacement authority is cleared. Cleanup
acknowledgement then removes only the transient authority row. Failure,
cancellation, interruption, and stale authority do not create a retained-output
record or move the prior final. The retained record is cleanup-eligible, but the
facade exposes no deletion, expiry, cleanup mutation, or metadata-only rename.

Disc Selection mutation preserves distinct identity paths:

- **Ordinary job-free update.** `updateDiscSelection()` updates the active
  Disc Selection in place only while it has no Encode Job history and belongs
  to no correction lineage. Omitted Media Item, source identity, and label
  fields remain unchanged; `label: null` is the explicit label-clearing signal.
  A successful update reopens only its Original Disc Archive for Catalog Review
  and advances that archive's catalog revision.
- **Ordinary retry identity.** A current-valid Disc Selection with any dependent
  Encode Job history cannot be repaired or removed. Every dependent job remains
  attached to the selection; `requeue()` of a terminal row resets the same
  logical Encode Job and preserves its retry identity.
- **Job-backed correction supersession.** `correctDiscSelection()` atomically
  deactivates the locked mapping, inserts a new active Disc Selection, records
  its immutable predecessor/replacement relation and optional reason, and
  reopens Catalog Review. Every job remains attached to the original selection
  with its original profile, output, and actual outcome. Queued work is
  cancelled immediately, running work follows the shared cancellation
  lifecycle, and terminal outcomes remain terminal.
- **Immutable correction lineage.** Catalog Review reads paginated,
  archive-wide history so repeated corrections retain every old-to-new mapping
  and operator reason even when no active replacement remains. A job-free
  replacement already in the lineage cannot be repaired in place; a later
  correction creates another supersession, while removal deactivates the
  replacement rather than deleting either endpoint or an immutable link.
  Catalog history pages supersessions separately from correction Encode Job
  links. Archive-scoped `listDiscSelectionSupersessions()` requires a limit no
  larger than 101 (including the route's one-row lookahead).
  `listDiscSelectionCorrectionEncodeJobLinks()` requires an archive,
  offset, and limit no larger than 101. It returns one path-free row per
  correction-associated predecessor, with an optional replacement summary, and
  always orders by immutable predecessor creation time and identity. Scheduling
  a delayed replacement therefore cannot move a row across offset pages, while
  declining a replacement or later removing its job-free Disc Selection never
  hides the predecessor's outcome. Each job summary contains only its identity
  and status.
  `listDiscSelectionCorrectionRetainedOutputSummaries()` independently
  requires an archive, offset, and limit no larger than 101, orders summaries by
  immutable retention time and identity, and returns every retry as a separate
  path-free row. The resulting projections preserve job outcomes, links, and
  every Retained Encode output summary without exposing output paths. The
  private retained path and filesystem identity remain available only on the
  worker-facing provenance read, never the consistent web read facade.
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

Ordinary job-free selections can still be removed normally. Selections that
participate in correction lineage are retained inactive so their immutable
links remain queryable.

Catalog Review reads Disc Selection action availability through a dedicated
facade query capped at 100 selection IDs. A job-free selection is editable and
removable. Ordinary Encode Job history locks the selection as provenance;
queued and running dependencies include their job ID and state in the reason.
Unsafe legacy selections remain a distinct Needs repair state and expose only
repair and removal when no active dependency blocks recovery. These reasons do
not include encode output paths. While legacy cutover repair is pending, the
archive fence suppresses every selection mutation action and explains that
changes are unavailable.

`catalog.getCatalogReviewCoverage()` accepts only an archive identity, derives
the title map from that archive's immutable Detected Disc scan, and computes
Review Coverage across every active Disc Selection without returning or
materializing those selection rows. Its first aggregate query always returns
one summary row; its interval-union query returns exactly one row for each
archived title, with the scan contract limiting that input and output to 512.
Whole-title, clamped chapter-union, overlap, distinct Media Item, and
main-feature counts therefore remain archive-wide while the surrounding read
snapshot stays independent of the number of Disc Selections.

Catalog Review archive discovery uses a separate facade query capped at 100
rows. It selects either Needs review or Reviewed archives, pages on immutable
archive time and identity, and optionally searches Reviewed disc labels or
active mapped Media Item titles. Reviewed outcome filters distinguish reviewed
selections from Archive-only Review. Returned mapped-item summaries expose a
distinct count and at most three titles.

## Inspections, requests, and job attempts

`discInspections.beginOrResume()` admits one current insertion per Optical
Drive. Drive identity and media generation fence replacement, while a renewable
claim token fences stale worker callbacks. Structured metadata, hash bytes,
rate/ETA, attempt history, retry deadlines, reason codes, and bounded diagnostics
are persisted without display strings. The fifth consecutive transient failure
is terminal. `requestRetry()` persists operator intent while the inspection
remains failed; only `beginOrResume()` with freshly observed matching media
generation reopens it and resets the consecutive budget. Lifetime attempts are
preserved. Removal and replacement abort rather than fail.

`archiveRequests.create()` atomically approves a scanned Detected Disc and
records durable intent without creating an Archive Job. Pending requests wait
indefinitely. Failure moves a request to `needs_attention`; manual retry returns
it to `pending`; cancellation either completes immediately or enters
`cancellation_requested` until active external work stops.

Running Encode Job cancellation first persists Cancellation requested while
retaining the active attempt token. Lease renewal returns that state to the
worker, which stops HandBrake and confirms closure before quarantining the
attempt partial. Cancellation finalization and publication completion both
compare status and token, so exactly one terminal outcome wins. Finalization
releases claim ownership and the output reservation unless a retained final is
still protected. The Encode Worker holds a recoverable per-output OS lock before
startup cleanup and final inspection and through HandBrake closure and
publication. An expired cancellation request remains nonterminal until recovery
owns that lock and proves through Linux process and open-inode inspection that
no HandBrake process still owns the attempt output; only then does the
token-fenced recovery record Cancelled with durable partial-cleanup provenance.

`archiveJobs.startForInspection()` atomically rechecks a completed current
inspection, matching pending request, approved disc, enabled/present drive,
legacy identity barrier, existing provenance, and same-fingerprint/same-drive
execution exclusions before inserting a claimed running attempt. Every attempt
has its own ordinal and claim token. Publication inserts Original Disc Archive
provenance, archives matching observations, completes the attempt, and fulfills
matching requests in one immediate transaction. Archive Integrity evidence is
part of that same publication transaction: historical Original Disc Archives
remain `unknown`, while a newly observed zero-damage recovery is `clean_read`
with its recovery-policy version and zero bad-sector evidence. A rescued image
whose unreadable sectors are proved to occupy unused filesystem space, or whose
isolated title-VOB payload errors pass bounded DVD-aware playback validation for
every affected title, is published as `watchable_salvage`. Affected titles are
derived from the VMG title table and each title set's part-of-title, program
chain, program, cell, and angle relationships; sharing a title set alone does
not attribute a damaged sector to a title. Its atomic evidence
records the versioned acceptance policy, normalized ranges, disc-wide totals,
and sorted per-title bad-sector counts. Version-one salvage rows predate exact
per-title evidence and remain distinguishable from new version-two decisions.
Failure and
abortion update the attempt and request together. A stale attempt cannot mutate
a later attempt.
Each recovery pass bounds ordinary expired claims to 100 visible failures.
Expired cancellation claims remain separately discoverable: the archive worker
must prove the copy runner and every matching partial inactive, then hold the
shared device-inode exclusion while calling the fenced finalization that aborts
the attempt and completes cancellation. The copy path takes the same exclusion
and renews its claim plus rechecks cancellation before authorizing any native
device or output I/O. The recovery path retains the exact locked open-file
description through its synchronous finalization. Lock acquisition is bounded;
a helper that still does not close after cancellation is detached, and its
inherited device descriptor keeps later cross-process inactivity proofs closed.
Lease expiry by itself is never treated as proof that a helper process closed.

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
write. A corrected replacement with a recorded prior-final identity cannot
enter the filesystem mutation fence or finalize without matching its private,
durably staged retained-path authority. Re-encoding the same corrected job
appends new provenance without overwriting any earlier retained output. A
cross-boundary mismatch restores the nonaccepted state without removing
provenance; restart cleanup converts a mismatched tentative completion back to
failure before acknowledging that provenance. Recovery and legacy
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
cutover, including the output path that distinguishes jobs sharing a source
and Encoding Profile. Older markers without that output component remain
readable and are reconciled conservatively. This allows restart/retry to report
later sidecar conflicts while preserving authoritative SQLite requeues. A
parser, persistence, transaction,
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
recovery imports. When intentional exact overlaps provide multiple active
selection candidates, import preserves every identity and resolves provenance
from existing job/output evidence or a unique Media Item match; ambiguous jobs
fail closed without attaching to an arbitrary selection. A shared library-scoped
lease serializes discovery, marker publication, and import with
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
