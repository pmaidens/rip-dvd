# DVD recovery batch v1

`commitDvdRecoveryBatch` commits one bounded observation against the current
Unrecovered Source map. The persisted evidence contract records one source
sector per recovery read, so one batch covers exactly one 2,048-byte sector.
A later recovery pass may call the operation repeatedly; this operation does
not schedule reads or reopen new-format admission.

The caller must hold an Archive Recovery that has been transitioned to
`running`, its current claimed durable work reservation, and a completed
matching DVD Disc Verification bound at the exact checkpoint where that pass
started. Source-read admission is serialized with Stop in the same immediate
database transaction; `stopping` is accepted only while an already-admitted
read or batch settles. The same Stop boundary invalidates queued DVD Disc
Verification, prevents claim renewal and new verification reads, and waits for
running verification work to settle before reconciliation and completion.
After the binding, the same claim
may commit monotonic one-sector descendants during that pass; a settled pass
cannot reuse the binding at its later checkpoint. The batch validates the
reservation and pass-scoped verification before filesystem I/O, at each commit
boundary, and inside the database projection transaction. The claim does not
expire with an Encode Job lease and is released only after the writer is
quiescent. Stop preserves that reservation through reconciliation and releases
it only as Stop completes; when no pass has been claimed yet, Stop creates the
reservation atomically with its state change. A deferred Stop keeps its queue
position but yields the worker to unrelated eligible Recovery work. The latest
storage preflight must be supported, and a recovered observation must re-prove
the actual archive inode's
`linux-rwf-atomic-v1` unit and alignment. All filesystem work and the database
projection run under the archive's exclusive image-ownership interval.

## Failed and successful reads

A failed source observation does not open the image for mutation. It changes
one `skipped_untested` sector to `individually_failed`, publishes the next
manifest and pointer, and projects that exact checkpoint into SQLite. It is
never represented as recovered.

A successful observation must contain exactly one sector. The worker reads all
complete naturally aligned storage units containing that sector, replaces only
the sector bytes in memory, and retains every neighboring byte. It then writes
each complete unit exactly once through the native atomic writer. A short write, sync
failure, read-back mismatch, inode change, or capability mismatch is a storage
fault; none advances evidence or reports the sector as recovered.

## Undo journal

Before a recovered write, the worker exclusively creates
`.dvd-evidence/<archive-id>/recovery-journal.bin` and reserves exactly one MiB.
The first 64 KiB contains versioned canonical metadata and checksums. The
remaining 960 KiB stores the original bytes for every protected unit. The
metadata binds:

- the archive and image device/inode, size, and modification time;
- the base manifest identity, revision, digests, and complete source map;
- the recovery-read identity, sector, outcome, and source-byte checksum; and
- each protected byte range, storage unit, payload offset, and before/after
  checksum.

The journal digest is domain-separated and included in the recovery manifest.
The journal is synchronized, and its directory is synchronized, before image
mutation. An existing journal is a consistency fault; a new attempt cannot
overwrite it.

## Commit order

The recovered path has one durability order:

1. Reserve, write, and synchronize the complete undo journal.
2. Atomically write each complete protected storage unit exactly once.
3. Synchronize and read back the image; verify bytes, identity, and extent.
4. Install and synchronize the immutable recovery manifest.
5. Atomically replace and synchronize the checkpoint pointer.
6. Project that exact recovery read and manifest in one immediate SQLite
   transaction.
7. Remove and synchronize the journal only after the database commit.

The filesystem pointer is therefore authoritative before the database
projection, and the database is never intentionally ahead of durable
filesystem evidence. A crash before the pointer leaves the prior checkpoint
authoritative. A crash after the pointer may leave SQLite behind. Any retained
journal or projection mismatch makes operator evidence unavailable with an
explicit consistency fault. Reconciliation of those retained states is a
separate recovery operation; this commit path never guesses or silently
cleans them up.

The SQLite transaction verifies the exact base revision and immutable archive
evidence, inserts the one-sector recovery read and next manifest, advances the
header, and updates Archive Integrity and normalized counts. A claimed Recovery
remains `running` through projection, journal cleanup, and writer release. Pass
settlement then removes the claim and atomically marks Recovery `completed`
when the source map is empty or `eligible` when more source evidence remains.
Replaying the exact already projected checkpoint is idempotent; a stale or
conflicting base is rejected. Revision 10,000 is the final readable checkpoint;
a further batch is rejected before journal creation or image access.

## Recovery checkpoints and operator evidence

Recovery manifests form a revision chain from `initial-manifest.json`. Each
manifest binds its predecessor, recovery read, immutable boundary evidence,
current normalized source map, prior and current image versions, protected
ranges, journal digest, and a complete publication digest. Operator evidence
reads validate every filesystem revision through the current pointer, the
current database header, and the protected bytes of the current image. Web and
JSON CLI adapters continue to call the same read operation and expose the same
revision-bound paging contract.

Runtime journals, manifests, pointers, and images are private operator data.
They are not repository fixtures or public issue attachments.

## Interrupted checkpoint reconciliation

`rip-dvd archive-recovery reconcile <archive-recovery-id>` queues a durable
reconciliation operation. The archive worker takes exclusive image ownership
before examining the filesystem pointer, evidence records, journal, image, and
SQLite projection. The operation never resumes source reads and does not open
new-format admission.

The synchronized checkpoint pointer is authoritative. When it still names the
base revision, a valid journal proves an uncommitted batch. The worker verifies
that every protected unit is either wholly before-image or wholly after-image,
restores the retained original units, synchronizes the image, restores the
checkpoint-bound modification time, verifies the prior checkpoint, and only
then removes an uncommitted next manifest and the journal. When the pointer
names the next valid revision and SQLite is one revision behind, the worker
projects that exact checkpoint and then removes the journal. A valid journal
left after an already-projected commit is cleanup-only. Repeating any completed
case is a no-op.

Missing or malformed evidence, a conflicting pointer or manifest, a missing
journal for an unprojected recovered checkpoint, changed protected bytes,
image identity or extent changes, rollback failure, unavailable mutation
protection, or uncertain writer ownership never advances the checkpoint. The
durable operation ends with `CONSISTENCY_FAULT`, `STORAGE_UNSUPPORTED`, or
`WRITER_NOT_QUIESCENT`; retained evidence remains in place for diagnosis.
Public web and JSON CLI adapters expose the same operation identity, phase,
terminal evidence, replay behavior, and machine-readable failure code.
