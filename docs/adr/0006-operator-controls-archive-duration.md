# Operator controls archive duration

DVD archive duration belongs to the operator. Elapsed time and lack of forward
progress do not establish source damage, changed media, or invalid output.
Initial copy, resumed rescue and recovery, helper authorization, endpoint proof,
retained-image snapshots, filesystem classification, navigation validation, and
title playback validation have no wall-clock deadline or inactivity watchdog.
The legacy full-disc content reader follows the same cancellation policy.

An archive can hold its drive and worker slot indefinitely. The dashboard may
warn about missing forward progress, but only an explicit operator cancellation
stops work for that reason. Web cancellation and `rip-dvd cancel-archive-request`
use the same Archive Request operation. A CLI wait deadline ends the observer's
wait without cancelling background work. The retired
`RIP_DVD_ARCHIVE_STALL_TIMEOUT_MS` setting has no effect.

Cancellation still propagates through the Archive Job signal, stops helper
processes, and closes authorization pipes. Copy ownership remains reserved
until the operating system reports helper closure. Cancellation completion and
partial-state cleanup must wait for that closure. Request-owned rescue images
and maps remain available for a safe retry; they are never published merely
because the operator stopped waiting. A read blocked in the kernel may delay
closure even after SIGKILL, so the worker must keep ownership in that case.

Worker heartbeats renew claims independently of byte progress. Ownership loss,
worker shutdown, changed media, actual I/O errors, malformed helper output,
conflicting file identity, and failed integrity checks still stop unsafe work.
Output, capacity, sector, and filesystem bounds remain in force.

Small drive identity, media-generation, capacity, and Disc Inspection probes
retain their command deadlines. Lock acquisition remains bounded to reject
conflicting or unprovable ownership. Native SCSI command timeouts remain part
of actual I/O failure reporting. Separate read-only Archive Audits and
Filesystem Verification remain bounded and cannot cancel an Archive Job.
These bounds do not impose a total archive duration or a progress requirement.

The original Archive Job implementation introduced a 12-hour copy deadline
alongside helper cancellation and process-closure ownership. The libdvdcss
reader inherited it. Repository history does not explain the chosen duration.
A later change added a configurable 30-minute stall cutoff, a five-minute
dashboard warning, and nearby cancellation. The warning and operator controls
remain useful; automatic stopping conflicts with operator-controlled duration.
