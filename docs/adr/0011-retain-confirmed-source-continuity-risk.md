# Retain confirmed source-continuity risk in title assessments

Archive Integrity describes whether the accepted source extent still contains
Unrecovered Source. It does not prove that every recovered byte came from the
same disc. A recovery write authorized by Operator Disc Confirmation therefore
remains a Source-Continuity Risk after all sectors recover and Archive Integrity
becomes `clean_read`.

For `dvd-recovery-evidence-v1`, each new Title Damage Assessment snapshots the
confirmed recovery reads committed before its checkpoint. The snapshot records
the continuity policy version, Disc Confirmation identity, Archive Recovery and
attempt identities, DVD Disc Verification identity and outcome, verification
result digest, confirmation checkpoint, and recovered source ranges. A
confirmation with no committed writes does not create image-level risk.

The assessment intersects confirmed recovered ranges with each concrete title
source map independently from Unrecovered Source. Shared source can therefore
appear in every affected title. Confirmed ranges outside all known title paths
remain visible as archive-level risk. A complete source map may prove that a
title has no missing source while still requiring a damage decision because it
contains confirmed source with uncertain continuity.

Assessment identity includes the normalized continuity snapshot and its method
version. The same checkpoint, selection, mapping, findings, and continuity
evidence reuse one identity. A continuity change creates another immutable
identity. Rows written before continuity tracking remain readable as outdated
evidence, but they cannot become current until a new assessment records the
continuity snapshot.

The checkpoint-stable assessment read collects the confirmation-backed recovery
ranges while shared Archive Image Ownership is held. Web and JSON CLI return
the same current, pending, and outdated state, title intersections, full
provenance, and unattributed archive-level ranges. New-format Archive Job
admission remains closed.
