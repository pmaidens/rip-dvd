# Generate canonical Damage Previews from stable checkpoints

Damage Preview requests use the reviewed preflight token and a canonical input
snapshot. Submission holds Archive Image Ownership while verifying the durable
checkpoint, then rechecks all database identities inside the same immediate
transaction that records the request and mutation result. Replaying a committed
key returns its original admission result even after source changes. Changed
input conflicts with that key; stale input creates no request.

Generation is available only after Archive Recovery stops or completes.
Active-Recovery checkpoint pauses remain unavailable. This capability does not
open new-format Archive Job admission or record Title Damage Acceptance.

The Encode worker runs a separate preview loop. A preview takes an exclusive
image-read interval and passes the locked descriptor to its path verifier and
HandBrake processes. An owner-only kernel-lock queue orders ordinary
readers and writers waiting behind it. Ticket and worker-execution locks prove liveness across container PID namespaces.
The image lock remains authoritative:
removing an unlocked dead parent's queue ticket never releases a surviving helper's lock.
A preview has no clip-length cap. Ordinary contention starts a two-minute grace;
Recovery Stop and changed Recovery state interrupt it immediately. Process
closure is proven before the preview returns its interval and the oldest
eligible waiter can enter. Lease expiry never proves reader quiescence.

A libdvdread verifier checks the exact navigation identity and selected cell
path against the reviewed Title Identity. The first implementation rejects
multi-angle, multi-PGC and other unrepresentable paths explicitly. The title scan
then checks chapter boundaries and selected audio and subtitle streams.
Generation uses the versioned intended HandBrake preset and canonical MKV.
Each interval group produces an artifact with a retained command, tool versions,
stream choices, checksum, requested seek and probed video-packet coverage. The coverage method
is qualified as HandBrake seek plus video-packet timestamps. Incomplete coverage
or interrupted finalized media remains partial. Empty and undecodable files
are never successful evidence about damage.

Requests retain queued, waiting, generating and terminal state independently of
media currency. An abandoned execution becomes interrupted or partial after
process closure is proven. It never restarts automatically. Cancellation targets
the request identity and does not require a current checkpoint. Source,
selection, title, stream, profile and later admitted preview-intent changes mark
retained media outdated while preserving its original provenance. New profile
versions do not change Title Damage Acceptance.

The public JSON CLI and HTTP adapters call the same operations. Canonical media
exports use artifact identity and checksum verification. The installed Compose
wrapper uses Docker's file transport to place bytes at the executing caller's
chosen path, including with a remote daemon. Staging beside the destination
also supports a caller destination on another filesystem; no caller bind mount or server-local
path substitutes for that transfer. JSON stdout contains metadata only. The web
offers canonical downloads through the deployment's operator authentication
boundary. Browser Viewing Renditions, retention cleanup, recreation and
active-Recovery previews remain separate capabilities.
