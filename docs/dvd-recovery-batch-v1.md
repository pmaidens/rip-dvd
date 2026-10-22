# DVD recovery batch v1

`commitDvdRecoveryBatch` commits one bounded observation against the current
Unrecovered Source map. The persisted evidence contract records one source
sector per recovery read, so one batch covers exactly one 2,048-byte sector.
A later recovery pass may call the operation repeatedly; this operation does
not schedule reads or reopen new-format admission.

The caller must hold an eligible Archive Recovery, its current claimed durable
work reservation, and a current committed checkpoint. The batch validates the
reservation before filesystem I/O, at each commit boundary, and inside the
database projection transaction. The claim does not expire with an Encode Job
lease and is released only after the writer is quiescent. The latest storage
preflight must be supported, and a recovered observation must re-prove the actual archive inode's
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
header, updates Archive Integrity and normalized counts, and marks Recovery
completed only when the source map is empty. Replaying the exact already
projected checkpoint is idempotent; a stale or conflicting base is rejected.
Revision 10,000 is the final readable checkpoint; a further batch is rejected
before journal creation or image access.

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
