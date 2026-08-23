# Disc Preservation

This context describes how inserted discs are identified, preserved, and prepared for later media processing.

## Language

**Optical Drive**:
The physical device through which discs are observed and preserved.
_Avoid_: Reader, device

**Detected Disc**:
A fingerprinted disc observed in an Optical Drive.
_Avoid_: Disk, medium

**Archive Job**:
One started attempt to fulfill an Archive Request by preserving its Detected Disc as an Original Disc Archive.
_Avoid_: Rip job, copy job

**Archive Request**:
An operator's durable intent to preserve a Detected Disc. It may wait for the matching disc, may produce more than one Archive Job attempt, and owns any resumable DVD rescue state shared by those attempts.
_Avoid_: Queued Archive Job, approval

**Archive Integrity**:
The evidence-backed read quality recorded with an Original Disc Archive. Historical archives are `unknown`; a new Archive Job that observes a complete recovery with no unreadable sectors records `clean_read`; an archive accepted after automatic damage validation records `watchable_salvage`.
_Avoid_: Bit-perfect, exact copy, Archive Job status

**Archive Boundary Evidence**:
The versioned provenance that identifies the Disc Inspection size accepted as an Original Disc Archive's complete publication boundary. Historical archives may have no Archive Boundary Evidence.
_Avoid_: Boundary metadata, archive size note

**Disc Inspection**:
An insertion-scoped examination that establishes a disc's identity and describes its contents before preservation begins.
_Avoid_: Hash Job, rip, metadata scan, drive inspection

**Retained Encode Output**:
A prior final preserved when a corrected Encode Job publishes a replacement. Its durable provenance links the predecessor and replacement Encode Jobs and marks it eligible for future operator-directed cleanup.
_Avoid_: Backup, failed output
