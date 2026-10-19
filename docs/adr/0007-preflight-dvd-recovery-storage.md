# Preflight DVD Archive Recovery storage

DVD Archive Recovery may update one published image in place. Before any such
write, the Archive Worker must prove the configured Originals Library meets the
versioned `dvd-recovery-storage-preflight-v1` contract. New-format admission
remains closed. This decision adds the dormant storage gate only.

The first contract supports local Linux ext-family, XFS, and Btrfs filesystems.
It reserves and writes a one-mebibyte undo-journal probe, synchronizes that
journal before any image probe, synchronizes an image update, synchronizes
checkpoint evidence, atomically replaces the checkpoint pointer, synchronizes
the containing directory, and proves that a second process cannot acquire the
writer lock. The one-mebibyte reservation is the maximum protected batch for
this contract, not a recovery duration or total-work limit.

An unknown filesystem is unexamined and reports `STORAGE_UNSUPPORTED`. This is
not a claim that the storage is unsafe. Network filesystems also report
`STORAGE_UNSUPPORTED` until a provider demonstrates cross-host writer
exclusion and safe behavior across disconnect and reconnect. Passing a
same-host lock test alone cannot support network recovery.

The worker stores the latest path-free result in SQLite. Web readiness, JSON
CLI readiness, and new-format Original Disc Archive inspection read that same
record. They report whether recovery storage is available, the contract
version, the tested facts, the observation time, and either
`STORAGE_UNSUPPORTED` or a specific failed prerequisite. Historical archives
do not gain recovery fields.

Journal reservation and synchronization use a private preflight workspace.
They never open or modify an Original Disc Archive. Failures therefore leave
the published image unchanged and remain storage failures rather than
Unrecovered Source evidence. The future recovery writer must run this contract
before opening an archive for mutation and must still treat any later storage
or synchronization failure as a storage fault.
