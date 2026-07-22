# @rip-dvd/data-access

This package is the only runtime persistence boundary for rip-dvd. Its public
interface speaks in Optical Drives, Detected Discs, Original Disc Archives,
Media Items, Disc Selections, Encoding Profiles, Archive Jobs, and Encode Jobs.
Drizzle tables, SQL, SQLite connections, and transaction objects remain
private.

`createDataAccess()` opens the configured local SQLite file, configures WAL,
foreign keys, normal synchronization, and a 5000 ms busy timeout, then applies
the checked-in Drizzle migrations. Opening an already-migrated file is safe.

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
