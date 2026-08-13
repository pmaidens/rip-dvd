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
An operator's durable intent to preserve a Detected Disc. It may wait for the matching disc and may produce more than one Archive Job attempt.
_Avoid_: Queued Archive Job, approval

**Disc Inspection**:
An insertion-scoped examination that establishes a disc's identity and describes its contents before preservation begins.
_Avoid_: Hash Job, rip, metadata scan, drive inspection

**Retained Encode Output**:
A prior final preserved when a corrected Encode Job publishes a replacement. Its durable provenance links the predecessor and replacement Encode Jobs and marks it eligible for future operator-directed cleanup.
_Avoid_: Backup, failed output
