# Archive copy is the only full-disc read

DVD inspection establishes a Detected Disc identity from the normalized volume
label, complete title and stream map, and declared disc size. It does not hash
every raw sector. The subsequent archive copy is the workflow's only complete
sequential read of the physical disc. A normal-size copy is followed by a
bounded endpoint check: the worker reads only the first logical block after the
accepted size, twice. This check establishes the physical endpoint; it is not a
second full-disc read.

Archive publication at the size reported by Disc Inspection requires two
matching normalized logical-block-address-out-of-range responses for that first
excluded block. A readable block rejects the accepted size. Medium, transport,
hardware, protection, readiness, unit-attention, unclassified end-of-input,
malformed, and conflicting responses all fail closed. The proof is persisted
as versioned Archive Boundary Evidence independently of Archive Integrity.

For a normal endpoint only, a complete current fixed-format response with
`ILLEGAL REQUEST / 21h/00h` and VALID clear may use the known single-sector
request address. Information bytes with VALID clear are ignored. Both responses
must agree on whether valid address evidence is present; when present, that
address must match the first excluded block. Truncated records, overflow flags,
and descriptor-format responses without valid address evidence do not qualify
for this fallback. The general read classifier and corrected-boundary recovery
still require a valid information LBA inside the request, including for
multi-sector failures.

The existing `dvd-normal-endpoint-proof-v1` contract records the requested
`firstExcludedLba` and normalized completion evidence, not an information LBA.
Its schema and version remain unchanged because this rule preserves two
matching out-of-range responses at the independently selected endpoint. The
`scsi-read-classifier-v2` classification of copy and rescue failures is unchanged.

A smaller file is complete only when versioned, structured
logical-block-address-out-of-range evidence proves a sector-precise trailing
boundary and a bounded ISO or UDF and DVD-Video extent proof establishes that
the excluded suffix is unaddressable and unreferenced. Every retained sector
must also have normalized recovery evidence. A corrected retained range may
publish as `clean_read`, or as `watchable_salvage` only when its genuine
unreadable sectors pass the existing versioned salvage policy; excluded suffix
sectors never count as damage. The published file ends at the proven boundary,
its actual size becomes the Original Disc Archive size, and the Disc Inspection
reported size remains in separate Archive Boundary Evidence.

Before normal DVD publication, the worker also checks the actual partial-image
sector count against every supported ISO 9660 and UDF volume-geometry view. The
check reads only bounded, top-level filesystem descriptors; it does not walk
path tables, directories, DVD navigation data, title maps, or every referenced
file extent. Missing ISO or UDF metadata is acceptable when another supported
view supplies valid geometry, but malformed, out-of-image, or conflicting views
fail closed. A failure quarantines only the worker-owned partial image before
filesystem synchronization, catalog persistence, or publication. This narrow
geometry gate is separate from the stricter corrected-boundary completeness
proof described above.

For marked new-format Archive Jobs, the boundary workflow implements the accepted
[`dvd-full-extent-metadata-v1` contract](../dvd-full-extent-metadata-profile-v1.md).
It applies after a proven normal endpoint at the full Disc Inspection extent.
It checks a closed list of geometry, file-location, IFO/BUP address, VOBU-map,
and NAV-pack fields, with exact source-sector dependencies. It permits missing
metadata explained by recorded Unrecovered Source while retaining unknown
structural and title impact. Independently readable listed fields still have
to agree, including fields in a later descriptor, another filesystem view,
or a VOB whose IFO is unavailable. Unexplained local failures, listed readable
contradictions, unsupported layouts, and exceeded work bounds block publication.
V1 also requires a surviving supported bootstrap and readable geometry claim;
complete loss of those declarations blocks this first profile.

This bounded profile was chosen so source damage can be preserved without
making initial preservation depend on proving complete DVD navigation semantics.
The linked contract is authoritative for its exact fields, discovery rules,
comparisons, and limits. It retains partial observations rather than catching a
failure around an entire filesystem view or treating a generic navigation-tool
failure as evidence of source damage. Unlisted playback, VM-command, timing,
and title-mapping semantics remain for later assessment or a new profile version.
The report is distinct from Archive Boundary Evidence, Archive Integrity, and
the source map. It performs bounded reads of saved metadata and adds no whole-disc
read, whole-image snapshot, or hash pass to full-extent validation.

The strict smaller-extent proof and legacy publication policy above remain the
applicable rules for their own paths. The new-format decision is accepted here
as an implementation contract; admission stays closed until the required
recovery, assessment, damage-decision, and encoding gates are complete.

Both publication paths require stable Optical Drive identity and
media-generation evidence, a current Archive Job claim, filesystem
synchronization, and atomic no-overwrite publication. Every endpoint read is
fenced immediately before and after by the current Optical Drive identity,
media generation, Detected Disc source identity, Archive Request, active claim,
and cancellation state. The worker no longer
rereads the completed image to derive or compare a catalog raw-content hash.
The narrow exception is an in-place retry of a damaged corrected rescue: the
worker computes a local hash of only the previously successful retained sectors
before and after the helper runs. It checkpoints that digest in the
request-owned rescue map before the helper may write, so an interrupted retry
can verify and retain its prior progress on restart; successful acceptance
discards the checkpoint. This proves that valid rescue progress survived while
the helper changed only bitmap-bad sectors. The checkpoint neither rereads the
Optical Drive nor creates a disc identity or a general post-copy verification
claim. Existing raw-content fingerprints remain valid catalog identities, while
newly inspected DVDs use the `dvdmeta-sha256:` namespace so the two identity
strengths cannot be mistaken for one another. When an older raw-hash archive is
rediscovered, its new metadata fingerprint is derived from the title map and
size already stored in the catalog; compatibility does not require rereading
the disc or ISO.

DVD Disc Verification is a second, strictly bounded optical-read exception. The
initial publication selects at most one suitable 32-sector window from each of
16 equal address bands by reading the already durable local image; it never
reads an unresolved placeholder. It saves the raw-sector digest, address,
representation, policy, initial checkpoint, and source metadata fingerprint in
the publication-digest-protected manifest and an immutable database projection.
A later verification reads each saved window from the inserted disc at most
once, with at most 16 reads, 512 sectors, and 1 MiB total. No new read starts
after 60 seconds. An in-flight helper has the same bounded lifetime, terminates
if its worker exits, and must be reaped before verification completes. These
samples establish only bounded recovery-source identity;
they are not a whole-disc hash or a completeness proof. DVD Disc Verification
is neither Filesystem Verification nor an Archive Audit.

Each verification claim and source-read admission is also bound to the current
eligible Recovery attempt. Recovery Stop invalidates queued verification,
denies claim renewal and further read admission, and remains `stopping` until
verification work has settled and every admitted verification helper's exact
device identity is proven inactive. The identity remains durable even if an
expired verification lease is settled first. A queued verification has no
device handle to quiesce. Recovery source helpers retain the same exact device
path, device identity, and inode with their claim; Stop proves that identity
inactive before reconciliation rather than trusting a path that may have been
renumbered or reused. The helper reads through the inherited descriptor used
to capture and lock that identity, so it cannot reopen a reused path onto a
different device. While a non-expired Recovery claim remains live, only that
claim's worker may report its reads quiescent and advance Stop; another worker
must wait for the handoff or lease expiry. Both verification and Recovery
helpers first acquire the inherited descriptor and wait behind an authorization
gate. The worker commits that descriptor's exact identity before authorizing
DVD I/O. If admission rolls back or the worker exits first, the helper cannot
begin a read; after a successful commit, Stop has the durable identity needed
to fence the helper even if the worker then crashes.

This deliberately trades sector-level duplicate detection and general
post-copy raw-image hash verification for materially less optical-drive wear
and shorter archive time.
Explicit filesystem verification remains available for checking that an
archive path still exists and is safely reachable.

The separately versioned `dvd-recovery-evidence-v1` contract is identified
only by an explicit Archive Job marker and, after publication, a one-to-one
archive evidence header. Archive creation time, Archive Integrity, and legacy
bad-sector fields do not identify that contract. Its admission remains closed
until the recovery, assessment, damage-decision, and encoding gates are
complete. Consequently, the publication paths above remain the only admitted
DVD behavior, and a legacy Archive Worker must reject a marked job before it
can mutate an image. The compatibility schema may read `incomplete_read`
as a projection of the header's accepted extent and normalized Unrecovered
Source ranges; that versioned evidence remains authoritative. Read
completeness alone establishes neither watchability nor encode eligibility
and does not weaken either boundary proof.

Every `dvd-recovery-evidence-v1` digest is a lowercase SHA-256 hash over a
domain-prefixed UTF-8 encoding. The encoding is a fixed-order JSON tuple rather
than caller-provided JSON object text. Archive Boundary Evidence includes the
complete normalized boundary proof. Unrecovered Source evidence is the ordered
list of normalized `(start LBA, sector count, classification)` tuples. A
one-sector recovery digest binds the archive, source manifest and revision,
sector, and outcome. A manifest digest binds its archive and revision, exact
predecessor digest, exact recovery-read digest when present, image and extent,
boundary digest, and normalized source-map digest. Data-access constructors
compute these values before a writer persists them, and authoritative reads
validate the current manifest, its immediate transition, and the marked
source-job provenance without loading the complete recovery history. Revision
2 and later are represented by immutable
`recovery-manifest-<revision>.json` records beside the initial publication
manifest; an authoritative current-checkpoint read validates the current record
and its immediate filesystem predecessor before accepting the durable pointer
and matching database projection. The
current digest is the authenticated checkpoint for that bounded projection;
a separately bounded evidence-chain audit validates every predecessor,
recovery read, transition, and stored digest. Operator evidence supplies
revision-bound range paging over the current checkpoint.

The dormant initial publication workflow now implements the filesystem
checkpoint contract in [DVD initial publication v1](../dvd-initial-publication-v1.md).
It persists publication intent before synchronizing and linking the image,
persists immutable initial evidence before installing the authoritative pointer,
and synchronizes each containing directory. Its complete publication digest
also binds the policy versions, integrity projection, and validated filesystem
image identity. Replay verifies these bindings and rejects competing artifacts
without overwrite. Request staging cleanup retains the archive-owned evidence.
The dormant Archive Job workflow now commits the archive, authoritative initial
evidence, completed Job, fulfilled Request, and separate Recovery in one database
transaction after verifying the durable checkpoint. Clean reads create completed
Recovery; remaining source creates eligible Recovery only after commit. Replay
uses the same Job-bound archive identity and durable intent, including after a
lost commit response. It preserves archive-owned evidence and never sends this
artifact through legacy quarantine or failure handling. Operator exposure remains
a separate slice, and this workflow does not open new-format admission.

The dormant recovery commit workflow now installs one journaled sector
observation per revision as described in
[DVD recovery batch v1](../dvd-recovery-batch-v1.md). A recovered observation
protects every complete aligned storage unit it intersects before writing each
unit exactly once, then
publishes and synchronizes the next filesystem checkpoint before projecting
that exact revision into SQLite. A failed observation advances evidence
without mutating the image. Retained journals and mismatched projections fail
operator reads closed; this commit operation does not perform reconciliation
or open new-format admission.

A recovery pass binds a completed matching DVD Disc Verification only when its
revision and digest are the exact current checkpoint. That binding belongs to
the claimed Recovery attempt. It remains valid across only the monotonic
one-sector checkpoint descendants committed by that same claim during the
pass; it cannot authorize another attempt or a pass that starts from a later
checkpoint. Once a partial pass settles, another pass requires a new
checkpoint-current verification. This pass-scoped rule lets one verified pass
narrow several sectors without treating its own first committed sector as an
unrelated checkpoint change.

The same durable work record advances a pass cursor in the transaction that
projects each one-sector checkpoint. Graceful restart and post-crash takeover
therefore resume strictly after the last attempted sector, including a sector
that retained individually-failed evidence. Workers renew the pass claim
independently of sector progress. Before inspecting an expired claim's admitted
device identity, takeover atomically rotates the claim token so the prior
worker can neither renew nor admit another read. It then proves that exact
device identity and the archive writer quiescent, reconciles any published
checkpoint while retaining the claimed `running` state, requeues the pass,
clears the now-inactive identity, and preserves the cursor.
