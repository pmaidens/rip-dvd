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

This deliberately trades sector-level duplicate detection and general
post-copy raw-image hash verification for materially less optical-drive wear
and shorter archive time.
Explicit filesystem verification remains available for checking that an
archive path still exists and is safely reachable.
