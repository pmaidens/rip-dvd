# Hold archive image ownership across complete I/O intervals

Original Disc Archives carrying `dvd-recovery-evidence-v1` may eventually be
updated in place by DVD Archive Recovery. Every process that reads or writes
one of these images must therefore participate in one archive-wide ownership
contract. New-format admission remains closed, and historical archives keep
their existing behavior.

The production contract is `archive-image-ownership-v1`. It stores one
owner-only lock file per archive in a private
`.rip-dvd-archive-ownership` directory beside the shared database. The archive
ID is represented by a SHA-256 filename rather than copied into the path. A
writer takes an exclusive Linux `flock`; a stable reader takes a shared lock.
The lock file's device and inode are permanently recorded when the lock is
first created. Matching owner-only identity files in the durable authority and
the Originals Library root bind both roots and the lock directory by device
and inode. Either surviving root therefore rejects replacement of the other
root, including movement of the lock directory with its authority-side
identity. Every reader, writer, and inspection must prove that the namespace,
named lock, and held descriptor still match those identity records. Linux
descriptor information proves that the specific held descriptor still owns
the expected shared or exclusive `flock`; a conflict caused by a different
owner is not accepted as proof. Missing, unlocked, replaced, unsafe, or
unverifiable lock state fails closed as `CONSISTENCY_FAULT`.
The actual ownership directory and named lock are storage-classified after
creation and throughout the interval, and their owner-only mode and effective
user ownership are revalidated rather than trusted from acquisition time.

The process that performs image I/O inherits the locked descriptor. An initial
copy helper receives the exclusive descriptor, and HandBrake and Archive Audit
helpers receive the shared descriptor. The inherited open-file description
keeps the operating-system lock alive if the worker process dies while its
helper continues. A worker lease or heartbeat is not ownership and cannot
override a live lock.

Writers also publish a private, versioned worker claim with creation,
heartbeat, lease-expiry, and lock device and inode values. This claim is
diagnostic evidence only. A claim for a different lock inode blocks readers
and writers, even after its lease expires. A worker that loses the named lock
path retains its claim so inspection can report the fault. Inspection reports
the operating-system writer and worker claim separately. An active writer
blocks stable reads with `WRITER_NOT_QUIESCENT`; an uncertain lock, invalid
claim, mismatched claim, or active claim without a proven writer blocks them
with `CONSISTENCY_FAULT`. An expired claim for the current lock inode does not
hide a live writer, and is not by itself evidence that a writer still exists.

Initial DVD publication holds exclusive ownership across the copy, evidence
publication, and reconciliation interval. Both the durable staging path and
final archive path are resolved and bound before lock acquisition. Initial
publication and reconciliation both reject a path or intent that differs from
the admitted paths.
Existing encode source reads,
including subtitle scans, Archive Audit file scans, and Original Disc Archive
Filesystem Verification hold shared ownership for the complete image-read
interval. Archive-evidence checkpoint validation also holds a shared interval
while it reads the checkpoint, manifest, and image identity. Catalog-only work
does not take an image lock. Title Damage
Assessment and Damage Preview must use the same shared interval when they gain
image-reading implementations.

The only declared production storage setup is a local Linux ext filesystem,
which is one filesystem class recognized by the `linux-rwf-atomic-v1`
provider from ADR 0007. Ownership classifies the actual archive image when it
exists, the nearest existing ancestor of a known staging or destination path,
the Originals Library root, and the durable ownership authority beside the
database, including the actual ownership directory and lock file. It rechecks
those live classifications throughout every interval. A network or unknown
filesystem used for staging or publication, mounted below a local library
root, or used for ownership authority therefore still fails closed.
The separate recovery preflight remains responsible for proving atomic
mutation and durability. XFS, Btrfs, other production platforms, and network
filesystems remain unsupported by this ownership contract until their process
behavior is covered and any required cross-host exclusion and safe disconnect
behavior are proven. An in-process backend exists only under the test
environment so platform-neutral unit and adapter parity tests can exercise the
contract.

The native helper accepts new-format initial copying only through the
`initial-copy-owned-v1` operation. Linux descriptor information must prove that
the inherited open-file description already owns an exclusive `flock`. The
helper never acquires or reacquires that lock. It revalidates the inherited
lock after authorization and before creating, writing, truncating, or syncing
the image. An unlocked descriptor is rejected, even when another descriptor
holds a conflicting lock, and lock loss stops later writes. The prior helper
operation is rejected. This keeps legacy or unowned helper entry points from
writing a new-format archive image.
