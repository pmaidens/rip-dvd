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

**Re-archive Mapping Proposal**:
An operator-reviewed draft that carries active Disc Selections from a prior Original Disc Archive to a fresh re-archive generation and validates them against the fresh Disc Inspection. It does not create Disc Selections or authorize encoding.
_Avoid_: Adopted mappings, replacement selections

**Re-archive Acceptance**:
The later, explicit decision that adopts a reviewed Re-archive Mapping Proposal for the fresh archive and stops new encoding from the prior archive. Saving a proposal is not acceptance.
_Avoid_: Catalog Review completion, proposal save

**Archive Integrity**:
The evidence-backed read completeness of an Original Disc Archive, distinct from structural validity and playback observations. Existing `unknown` records retain their lack of read-quality evidence, `clean_read` records a complete read without remaining unreadable sectors, and historical `watchable_salvage` records acceptance under the salvage policy used at the time; none guarantees an undamaged viewing experience.
_Avoid_: Bit-perfect, exact copy, Archive Job status

**Unrecovered Source**:
Source sectors not yet successfully preserved in an Original Disc Archive. Evidence distinguishes regions skipped without individual testing from sectors individually attempted unsuccessfully and retains their recovery history.
_Avoid_: Proven unreadable sectors, lost playback

**Title Damage Assessment**:
An assessment of a title's source damage, mapping coverage, and estimated affected playback for a particular saved archive revision and selected playback path and angle. Known damage and unknown impact can coexist; subsequent source changes make the assessment outdated.
_Avoid_: Watchability verdict, damage score

**Title Identity**:
The evidence-backed continuity of a title across archive revisions. A matching title number alone does not establish continuity for catalog selections, assessments, or operator acceptance.
_Avoid_: Title number, title position

**Title Missing-Source Percentage**:
The proportion of a title's unique source sectors that remain unrecovered for its selected playback path and angle, including multiplexed content and navigation sectors. A complete percentage requires trustworthy complete mapping; shared sectors count independently for each affected title.
_Avoid_: Video damage percentage, playback lost percentage

**Estimated Affected Playback**:
The title timeline intervals associated with unrecovered source, qualified by timing method and mapping coverage. Repeated source appears at each playback occurrence; these intervals neither measure exact playback lost nor bound visible decoder effects.
_Avoid_: Seconds lost, exact damage duration

**Playback Observation**:
Evidence from an optional decode of a particular archive revision with recorded playback selection and decoder settings. Successful decoding does not establish watchability or replace source-damage evidence.
_Avoid_: Watchability guarantee, read completeness

**Damage Preview**:
An optional sample clip around an estimated affected playback interval, with surrounding context and the intended encoding settings, tied to a consistent archive revision. It illustrates sample decoding and is distinct from playback of the corresponding interval in a finished Encode Output.
_Avoid_: Final-output proof, exact damage prediction

**Skipped Region**:
A range left unresolved during the initial archive copy after a read request fails. Its sectors have not necessarily been tested individually and must not all be called unreadable.
_Avoid_: Bad sectors, proven damage

**Individually Failed Sector**:
A sector that failed a read attempted on that sector alone. This records the observed failure, not a claim that a later attempt cannot recover it.
_Avoid_: Permanently unreadable sector

**Archive Boundary Evidence**:
The versioned provenance that identifies the Disc Inspection size accepted as an Original Disc Archive's complete publication boundary. Historical archives may have no Archive Boundary Evidence.
_Avoid_: Boundary metadata, archive size note

**Archive Audit**:
A bounded, read-only evaluation of Original Disc Archives that retains progress, findings, completeness, and separately whether record selection was truncated. It does not modify archives or perform remediation.
_Avoid_: Filesystem Verification, repair scan

**Archive Audit Run**:
One durable attempt to perform an Archive Audit with explicit record, concurrency, file-time, and runtime bounds.
_Avoid_: Audit Job, verification run

**Filesystem Verification**:
A read-only check of one persisted artifact's recorded path, accessibility, and size. It is narrower than an Archive Audit and does not modify or repair the artifact.
_Avoid_: Archive Audit, repair

**Disc Inspection**:
An insertion-scoped examination that establishes a disc's identity and describes its contents before preservation begins.
_Avoid_: Hash Job, rip, metadata scan, drive inspection

**Retained Encode Output**:
A prior final preserved when a corrected Encode Job publishes a replacement. Its durable provenance links the predecessor and replacement Encode Jobs and marks it eligible for future operator-directed cleanup.
_Avoid_: Backup, failed output

**Worker Incident**:
A durable, operator-facing record of a worker polling or recovery failure that does not belong to a Disc Inspection, Archive Job, or Encode Job. Repeated matching failures coalesce while active, and a later successful pass records recovery without erasing recent history.
_Avoid_: Alert, error event, worker log
