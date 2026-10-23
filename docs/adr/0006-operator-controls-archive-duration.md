# Operator controls archive duration

DVD archive duration belongs to the operator. Elapsed time and lack of forward
progress do not establish source damage, changed media, or invalid output.
Initial copy, resumed rescue and recovery, helper authorization, endpoint proof,
retained-image snapshots, filesystem classification, navigation validation, and
title playback validation have no wall-clock deadline or inactivity watchdog.
The legacy full-disc content reader follows the same cancellation policy.

An initial archive can hold its drive and worker slot indefinitely. A resumed
recovery runs complete unresolved-only passes without a time limit. Each pass
that recovers bytes schedules another pass in the opposite direction after a
fresh checkpoint-current sampled verification. A verifier interruption queues
a durable retry; a removed, changed, or nonmatching source faults the Recovery
instead of leaving the continuation reported as running. A complete pass that
recovers no bytes durably pauses recovery; this is a safe scheduling boundary,
not a conclusion that the remaining source is damaged. The operator can Stop
the recovery. A future explicit Resume control can start another pass after a
no-progress pause. Web cancellation and
`rip-dvd cancel-archive-request` use the same Archive Request operation. A CLI
wait deadline ends the observer's wait without cancelling background work. The
retired `RIP_DVD_ARCHIVE_STALL_TIMEOUT_MS` setting has no effect.

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
These bounds do not impose a total archive duration, overall recovery deadline,
or fixed recovery-pass cap. The no-progress pass boundary is based on an
exhaustive unresolved-sector sweep rather than elapsed time or inactivity.

The original Archive Job implementation introduced a 12-hour copy deadline
alongside helper cancellation and process-closure ownership. The libdvdcss
reader inherited it. Repository history does not explain the chosen duration.
A later change added a configurable 30-minute stall cutoff, a five-minute
dashboard warning, and nearby cancellation. The warning and operator controls
remain useful; automatic stopping conflicts with operator-controlled duration.
