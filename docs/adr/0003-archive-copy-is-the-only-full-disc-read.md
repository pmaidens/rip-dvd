# Archive copy is the only full-disc read

DVD inspection establishes a Detected Disc identity from the normalized volume
label, complete title and stream map, and declared disc size. It does not hash
every raw sector. The subsequent archive copy is the workflow's only complete
sequential read of the physical disc.

Archive publication still requires a complete file of the declared size,
stable Optical Drive identity and media-generation evidence, a current job
claim, filesystem synchronization, and atomic no-overwrite publication. It no
longer rereads the completed image to compare a raw-content hash. Existing
raw-content fingerprints remain valid catalog identities, while newly inspected
DVDs use the `dvdmeta-sha256:` namespace so the two identity strengths cannot be
mistaken for one another. When an older raw-hash archive is rediscovered, its
new metadata fingerprint is derived from the title map and size already stored
in the catalog; compatibility does not require rereading the disc or ISO.

This deliberately trades sector-level duplicate detection and post-copy hash
verification for materially less optical-drive wear and shorter archive time.
Explicit filesystem verification remains available for checking that an
archive path still exists and is safely reachable.
