# @rip-dvd/data-access

This package is the only runtime persistence boundary for rip-dvd. Its public
interface speaks in Optical Drives, Detected Discs, Original Disc Archives,
Media Items, Disc Selections, Encoding Profiles, Archive Jobs, and Encode Jobs.
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
drives. Detected Discs awaiting review and the shared Archive/Encode Job policy
each have an explicit active cap before recent terminal history is added.

## Queue attempts and progress

Every claim returns a unique, queue-specific claim token. Progress, completion,
and failure commands accept the claimed running job and compare its ID, running
status, and token in the update. Output from a stale worker attempt therefore
cannot mutate a retried job.

Archive Jobs can be enqueued or requeued only while their Detected Disc is
approved and no archive exists for its fingerprint. The
single-statement claim also joins the current Detected Disc state and returns
only approved work, so a revocation between enqueue and claim prevents an
external preservation process from starting. It also excludes another running
Archive Job for the same fingerprint across Optical Drives. Approval freezes
the reviewed Disc Kind and scan data until approval is revoked, and every
observation of a fingerprint must have the same Disc Kind. Archive publication
marks every observation of the fingerprint archived. Once archive
provenance exists, rediscovery may refresh metadata but cannot change the
Detected Disc kind.

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

Both queues share one progress coalescer. The first report is persisted
immediately. Later reports persist when at least one second has elapsed or the
reported value differs from the last persisted value by at least five
percentage points; intermediate reports are coalesced in memory. Completion
always persists 100%, and failure persists the newest coalesced value before
recording the terminal status.

## Transaction boundary

The facade deliberately has no general mutation `transaction(callback)` escape
hatch. The `readConsistentSnapshot()` boundary supplies only synchronous read
operations and keeps composed cross-table reads on one short SQLite snapshot;
it rejects asynchronous callbacks. The few multi-statement catalog mutations
use short internal transactions. Queue claims use one atomic
`UPDATE ... RETURNING` statement and return only after that statement has
committed. Workers must start external programs only after `claimNext()`
returns; process execution never belongs in a database transaction.

## Legacy sidecar import

`legacySidecars.importLibrary()` is the idempotent migration boundary for
existing `.rip-dvd.json` files. It scans an originals library once, validates
schema-one and schema-two sidecars, and writes each valid sidecar to SQLite in
a short transaction. Valid jobs in a partially invalid sidecar still import;
corrupt sidecars, invalid jobs, missing archives, and duplicates are returned
in a structured report. Completion is inferred from the final output file at
import time. Relative recorded paths use the legacy CLI's invocation-directory
semantics; an existing sidecar-relative path is accepted as a compatibility
candidate, but two existing candidates are reported as ambiguous. A missing or
unreadable originals library is an input error rather than an empty successful
import.

Schema-two `created_at` and `updated_at` values provide the historical record
dates. When they are absent, the archive file modification time is the fallback;
a completed Encode Job uses its output file modification time. Re-import never
replaces an existing SQLite Encode Job's status, output, priority, progress, or
error, including an intentional retry.

After a successful import, the migration-only entrypoint creates a
`.rip-dvd-sqlite-catalog` marker at the originals-library root. It never writes
the sidecars themselves. The legacy encoder refuses a marked library, making
SQLite the enforceable catalog and queue authority. Recursive traversal and the
cutover writer live behind the `@rip-dvd/data-access/legacy-sidecars` entrypoint
and are excluded from the web runtime graph.

The repository-level `pnpm import:legacy-sidecars -- ...` command invokes this
facade operation for users and automation.

Generate and review schema changes with:

```bash
pnpm --filter @rip-dvd/data-access db:generate
pnpm --filter @rip-dvd/data-access db:check
```
