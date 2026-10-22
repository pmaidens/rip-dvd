# Preflight DVD Archive Recovery storage

DVD Archive Recovery may update one published image in place. Before any such
write, the Archive Worker must prove the configured Originals Library meets the
versioned `dvd-recovery-storage-preflight-v1` contract. New-format admission
remains closed. This decision adds the dormant storage gate only.

The production provider is `linux-rwf-atomic-v1`. It requires the kernel's
per-file `STATX_WRITE_ATOMIC` and direct-I/O alignment capabilities and probes
an overwrite through `O_DIRECT`, `O_SYNC`, and `pwritev2(RWF_ATOMIC | RWF_SYNC)`.
The complete write must succeed, synchronize, and read back correctly. It never
retries a short write as fragments or falls back to ordinary buffered writes.
Filesystem type and filesystem block size alone cannot establish this contract.

The provider chooses a power-of-two unit within the returned atomic bounds,
large enough for direct-I/O offset and read alignment. Units start at file
offset zero and each write must cover a complete naturally aligned unit.
The one-mebibyte journal reservation leaves 64 KiB for framing, checksums,
prior evidence, and metadata, so all units affected by one sector must fit within
the remaining 960 KiB. The recovery writer enforces that metadata bound and
journals every affected unit, including previously successful neighboring bytes. It
rechecks the actual archive inode's capabilities before each mutation. An EOF
tail that cannot form a complete unit is unavailable under this contract.

The preflight reserves and writes a one-mebibyte undo-journal probe, synchronizes that
journal before any image probe, synchronizes an image update, synchronizes
checkpoint evidence, atomically replaces the checkpoint pointer, synchronizes
the containing directory, and proves that a second process cannot acquire the
writer lock. The reservation bounds one outstanding batch, not recovery time.

The provider relies on the Linux atomic-write and synchronization interfaces,
including the backing device honoring those guarantees. It does not claim to
tolerate arbitrary hardware failure or prove the guarantees from a successful
ordinary write. The kernel's [ext4 atomic-write documentation](https://www.kernel.org/doc/html/latest/filesystems/ext4/atomic_writes.html)
and [pwritev2 interface contract](https://man7.org/linux/man-pages/man2/pwritev2.2.html)
define the requirements. Native syscall tests cover absent capabilities,
alignment, capacity, short writes, sync failure, and read-back corruption.
Physical supported-host testing remains a prerequisite of the first live
admission gate in #391; synthetic tests do not claim that qualification.

An unknown filesystem is unexamined and reports `STORAGE_UNSUPPORTED`. This is
not a claim that the storage is unsafe. Network filesystems also report
`STORAGE_UNSUPPORTED` until a provider demonstrates cross-host writer
exclusion and safe behavior across disconnect and reconnect. Passing a
same-host lock test alone cannot support network recovery.

The worker stores the latest path-free result in SQLite. Web readiness, JSON
CLI readiness, and new-format Original Disc Archive inspection read that same
record. This is an observation, not lasting write authorization: mount, inode,
kernel, device, or configuration changes require a fresh preflight. They report
whether recovery storage is available, the contract
version, the tested facts, the observation time, and either
`STORAGE_UNSUPPORTED` or a specific failed prerequisite. Historical archives
do not gain recovery fields.

Journal reservation and synchronization use a private preflight workspace.
They never open or modify an Original Disc Archive. Failures therefore leave
the published image unchanged and remain storage failures rather than
Unrecovered Source evidence. The recovery writer requires a current supported
result before opening an archive for mutation and still treats any later
storage or synchronization failure as a storage fault. Its commit order is
specified in [DVD recovery batch v1](../dvd-recovery-batch-v1.md).
