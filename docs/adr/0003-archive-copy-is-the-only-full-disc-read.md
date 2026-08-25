# Archive copy is the only full-disc read

DVD inspection establishes a Detected Disc identity from the normalized volume
label, complete title and stream map, and declared disc size. It does not hash
every raw sector. The subsequent archive copy is the workflow's only complete
sequential read of the physical disc.

Archive publication normally requires a complete file of the size reported by
Disc Inspection. A smaller file is complete only when versioned, structured
logical-block-address-out-of-range evidence proves a sector-precise trailing
boundary and a bounded ISO or UDF and DVD-Video extent proof establishes that
the excluded suffix is unaddressable and unreferenced. Every retained sector
must also have normalized recovery evidence. A corrected retained range may
publish as `clean_read`, or as `watchable_salvage` only when its genuine
unreadable sectors pass the existing versioned salvage policy; excluded suffix
sectors never count as damage. The published file ends at the proven boundary,
its actual size becomes the Original Disc Archive size, and the Disc Inspection
reported size remains in separate Archive Boundary Evidence.

Both publication paths require stable Optical Drive identity and
media-generation evidence, a current Archive Job claim, filesystem
synchronization, and atomic no-overwrite publication. The worker no longer
rereads the completed image to compare a raw-content hash. Existing raw-content
fingerprints remain valid catalog identities, while newly inspected DVDs use
the `dvdmeta-sha256:` namespace so the two identity strengths cannot be
mistaken for one another. When an older raw-hash archive is rediscovered, its
new metadata fingerprint is derived from the title map and size already stored
in the catalog; compatibility does not require rereading the disc or ISO.

This deliberately trades sector-level duplicate detection and post-copy hash
verification for materially less optical-drive wear and shorter archive time.
Explicit filesystem verification remains available for checking that an
archive path still exists and is safely reachable.
