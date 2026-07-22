# @rip-dvd/data-access

This package is the only runtime persistence boundary for rip-dvd. Its public
interface speaks in Optical Drives, Detected Discs, Original Disc Archives,
Media Items, Disc Selections, Encoding Profiles, Archive Jobs, and Encode Jobs.
Drizzle tables, SQL, SQLite connections, and transaction objects remain
private. Aggregate identifiers are opaque domain types, so callers cannot
cross-wire, for example, a Media Item ID into an Original Disc Archive field.

`createDataAccess()` opens the configured local SQLite file, configures WAL,
foreign keys, normal synchronization, and a 5000 ms busy timeout, then applies
the checked-in Drizzle migrations. A short-lived lock file beside the database
serializes first-run migrations across web and worker processes; stale locks
expire after five minutes. Opening an already-migrated file is safe.

## Queue attempts and progress

Every claim returns a unique, queue-specific claim token. Progress, completion,
and failure commands accept the claimed running job and compare its ID, running
status, and token in the update. Output from a stale worker attempt therefore
cannot mutate a retried job.

Both queues share one progress coalescer. The first report is persisted
immediately. Later reports persist when at least one second has elapsed or the
reported value differs from the last persisted value by at least five
percentage points; intermediate reports are coalesced in memory. Completion
always persists 100%, and failure persists the newest coalesced value before
recording the terminal status.

## Transaction boundary

The facade deliberately has no `transaction(callback)` escape hatch. The few
multi-statement catalog mutations use short internal transactions. Queue claims
use one atomic `UPDATE ... RETURNING` statement and return only after that
statement has committed. Workers must start external programs only after
`claimNext()` returns; process execution never belongs in a database
transaction.

Generate and review schema changes with:

```bash
pnpm --filter @rip-dvd/data-access db:generate
pnpm --filter @rip-dvd/data-access db:check
```
