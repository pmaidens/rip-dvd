# DVD initial publication v1

`publishDvdInitialArchive` consumes the proven initial copy returned by
`runDvdInitialArchiveBoundaryForArchiveJob`. This is the dormant filesystem
part of #394. Admission remains closed. `saveDvdInitialArchiveForArchiveJob`
consumes its checkpoint in the atomic database save. #409 owns operator
evidence presentation through web and the public JSON CLI.

The caller holds archive exclusion, closes all copy helpers, and fences each
mutation with the current claim and cancellation state. It must keep that
exclusion through reconciliation and the subsequent database save. No legacy
rescue helper may keep write access after this ownership transfer. The module
does no optical reads, recovery reads, whole-image hashing, or metadata recheck.

## Files and identities

The publication uses `<archive-id>.iso` in the Originals Library and an
archive-owned `.dvd-evidence/<archive-id>/` directory containing:

- `publication-intent.json`, the immutable expected publication and original
  staging path. It contains the complete expected manifest so interrupted
  publication can finish without regenerating evidence from a damaged source.
- `initial-manifest.json`, the immutable revision 1 manifest.
- `checkpoint.json`, the authoritative committed checkpoint pointer.

These files are runtime operator evidence. They must never be committed to the
repository or attached to public issues or PRs.

The manifest binds the archive and source Archive Job, the existing image
fingerprint, filesystem device/inode and validated modification time, accepted
extent, full Archive Boundary Evidence and digest, complete normalized source
map and digest, initial-copy diagnostics, metadata decision, integrity
projection, and applicable publication/copy/metadata/boundary/integrity policies.
The filesystem identity is an inode identity, not a raw-content fingerprint.
It requires the same filesystem and a quiescent writer. The boundary workflow
captures the modification time while checking that the proof's image remained
unchanged. Publication and replay reject a changed inode, size, or modification
time. Link-count changes during publication do not change the image revision.

The existing `manifestDigest` retains the database chain encoding in ADR 0003.
The additional `publicationDigest` binds every field of this filesystem
manifest, including its policy versions and integrity projection. Its encoding
is SHA-256 over `rip-dvd:dvd-initial-publication:v1` followed by a NUL byte and
UTF-8 JSON with object keys sorted by JavaScript string comparison at every
level. Arrays retain their order. The `publicationDigest` field itself is
excluded from that payload. The pointer contains both digests and the manifest
identity and revision. An initial manifest has no predecessor or recovery read.
Publication creates no earlier image revision or recovery history.

## Durability order

1. Create and synchronize archive-owned evidence directories and their parents.
   Persist the complete publication intent and synchronize its directory.
2. Verify and synchronize the proven image through an `O_NOFOLLOW` descriptor.
3. Write and synchronize the manifest, atomically install it without overwrite,
   and synchronize its containing directory.
4. Hard-link the image into the Originals Library without overwrite. Verify
   and synchronize that inode and synchronize the Originals Library directory.
5. Verify the image again. Atomically install the checkpoint pointer without
   overwrite and synchronize its containing directory. Only then return a
   checkpoint eligible for the subsequent database save.

JSON records are written to exclusive temporary files, synchronized, and
installed with a no-overwrite hard link. A crash may leave an unreferenced
temporary file; it cannot make partial JSON an authoritative record. An
already installed record is accepted only when its complete contents match,
and replay synchronizes it again. Errors retain intent and archive-owned
evidence for diagnosis. No conflict path replaces or quarantines another
archive's image.

## Reconciliation and database handoff

`reconcileDvdInitialArchivePublication` requires the expected archive, source
job, and image fingerprint. It validates the persisted intent by reconstructing
the manifest and its digests, checks boundary and source-map invariants, checks
the exact saved manifest and pointer, and verifies the image identity, version,
and extent. Matching size or file existence alone is insufficient. Before the
pointer exists, the intent can finish a missing manifest or publication link.
Once a pointer exists, missing evidence or a missing image is a consistency
fault. Replay does not invent a replacement committed artifact.

The database handoff must supply any existing `databaseProjection`. An absent
projection may lag the pointer. A projection above the durable revision, or a
projection present without a pointer, fails with
`DVD_PUBLICATION_PROJECTION_AHEAD`. An equal revision must have the same
manifest identity and digest. The Archive Job save uses only the returned,
verified manifest in `archiveJobs.publishDvdInitial`. One immediate database
transaction creates the Original Disc Archive, initial evidence projection,
and Archive Recovery, completes the Archive Job, and fulfills its Archive
Request. No projection advances before filesystem verification succeeds.

The dormant `runDvdInitialArchiveJob` workflow holds the existing fingerprint
exclusion through copy, boundary proof, publication, database save, and cleanup.
It waits for the initial helper to close before validating the saved image.
The archive ID derives from the source Archive Job ID and remains stable across
restarts. `reconcileDvdInitialArchiveForArchiveJob` supplies the existing database
projection when replaying durable intent. A completed save returns its existing
Job and archive after verifying that evidence and lifecycle records agree.
Missing or conflicting database lifecycle records raise
`DVD_INITIAL_SAVE_CONSISTENCY_FAULT`; a lost running claim or cancelled Request
raises `DVD_INITIAL_SAVE_OWNERSHIP_LOST`. Filesystem faults keep their specific
publication codes. An interruption retains the image and evidence for replay,
including when the database transaction rolls back or its commit response is
lost. This path never calls legacy image quarantine or rewrites the Job as failed.

An empty current source map records `clean_read` and completed Recovery. A
nonempty map records `incomplete_read` and eligible Recovery, visible together
only after commit. Neither integrity value asserts structural validity,
watchability, playback, or encoding eligibility. The database first inserts an
unknown projection inside the transaction, then installs authoritative evidence
and its matching integrity projection before commit. Existing evidence guards
remain in force. Closed-admission triggers allow only the marked initial terminal
handoff backed by its manifest; scheduling and legacy mutations stay closed.
Later Recovery has no authority to change the completed Archive Job outcome.
This adds no operator operation or Recovery reads.

Conflict codes distinguish missing intent, conflicting intent, image,
manifest, checkpoint, projection, and unsafe paths. Fault injection before
and after intent, image, manifest, publication link, and pointer steps exercises
replay at the publication interface. Repeated replay returns the same image
inode and checkpoint or the specific fault.

After the database commit, `finalizePublication` rechecks intent, manifest,
pointer and image, then removes only the verified request-owned staging image
link and synchronizes its parent. The caller still holds archive exclusion;
cleanup does not renew the Archive Job claim that the transaction completed.
It never recursively removes a directory or
deletes archive-owned evidence. The archive and checkpoint remain available
when the entire request staging directory is subsequently removed.
