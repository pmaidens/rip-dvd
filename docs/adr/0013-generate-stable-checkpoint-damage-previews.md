# Generate canonical Damage Previews from stable checkpoints

Damage Preview requests use the reviewed preflight token and a canonical input
snapshot. Submission holds Archive Image Ownership while verifying the durable
checkpoint, then rechecks all database identities in the final synchronous ownership commit
and inside the same immediate
transaction that records the request and mutation result. Replaying a committed
key returns its original admission result even after source changes. Changed
input conflicts with that key; stale input creates no request.

Generation also supports active Archive Recovery. Submission waits through a
live Recovery writer instead of treating the ownership acquisition timeout as
unavailability. Once ownership is available, admission rechecks the exact
reviewed token and commits no work if its checkpoint changed. An admitted request durably
fences new Recovery source reads. An already admitted command closes and its
batch commits before Recovery yields its claim at a complete checkpoint. The
preview waits for that handoff, then takes exclusive consistent-read ownership.
If the checkpoint advanced, the reviewed request fails stale rather than
substituting a new revision. Recovery attempt identity remains bound; an ordinary
state transition within that attempt does not by itself change the reviewed
source. Stopping and faulted Recovery cannot admit new previews.

The durable planned pause belongs to preview work and does not enqueue Recovery
as an ordinary contender. It ends after source readers close, before artifact
postprocessing. Recovery can continue its saved pass after the preview releases
it. Cancellation addresses only its request. Dead executions settle interrupted
or partial after closure proof and never restart source generation. This
capability does not open new-format Archive Job admission or record Title Damage
Acceptance.

The Encode worker runs a separate preview loop. A preview takes an exclusive
image-read interval and passes the locked descriptor to its path verifier and
HandBrake processes. An owner-only kernel-lock queue orders ordinary
readers and writers waiting behind it. Ticket and worker-execution locks prove liveness across container PID namespaces.
The image lock remains authoritative:
removing an unlocked dead parent's queue ticket never releases a surviving helper's lock.
A preview has no clip-length cap. Ordinary contention starts a two-minute grace;
Recovery Stop and changed Recovery attempt interrupt it immediately. Process
closure is proven before the preview returns its interval and the oldest
eligible waiter can enter. Lease expiry never proves reader quiescence.

A libdvdread verifier checks the exact navigation identity and selected cell
path against the reviewed Title Identity. The first implementation rejects
multi-angle, multi-PGC and other unrepresentable paths explicitly. The title scan
then checks chapter boundaries. DVD source stream IDs are logical lsdvd identities,
not HandBrake track ordinals. The verifier maps logical IDs through the PGC physical
stream controls in HandBrake enumeration order. The scan must agree on count,
codec, channels and subtitle display style. Selected subtitle sources retain every
representable display variant. Unprovable mappings fail explicitly. The resolved
source IDs, physical IDs and HandBrake ordinals remain in provenance.
Generation uses the versioned intended HandBrake preset and canonical MKV.
Each interval group produces an artifact with a retained command, tool versions,
stream choices, checksum, requested seek and probed video-packet coverage.
Source ownership closes as soon as the admitted source processes are quiescent.
Artifact probing, hashing and publication then run without an image lock. The coverage method
is qualified as HandBrake seek plus video-packet timestamps. Incomplete coverage
or interrupted finalized media remains partial. Empty and undecodable files
are never successful evidence about damage.

Requests retain queued, waiting, generating and terminal state independently of
media currency. An abandoned execution becomes interrupted or partial after
process closure is proven. Finalized files whose metadata commit was interrupted are reconciled by the
request identity and command list before settling partial state. Generation
never restarts automatically. Cancellation targets
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
boundary. Browser Viewing Renditions, retention cleanup and recreation remain separate
capabilities.
