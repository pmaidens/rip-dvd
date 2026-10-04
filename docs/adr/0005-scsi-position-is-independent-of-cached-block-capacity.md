# SCSI position is independent of cached block capacity

Disc Inspection compares direct SCSI READ CAPACITY with Linux's cached
block-device size inside the existing drive and media-generation fences.
Either mismatch records a persistent informational `readPathNotice` on the
Disc Inspection. The web dashboard and JSON CLI expose that notice. Inspection
continues automatically through its normal settling, metadata, identity, and
source-continuity checks. The notice requires no operator approval or media
reinsertion and does not establish successful inspection.

Direct capacity remains the identity and inspection extent in both directions.
A smaller cached size does not truncate it; a larger cached size does not
extend it. Archive publication still requires the existing geometry and
physical endpoint proofs in ADR 0003. Capacity disagreement alone supplies
neither boundary evidence nor damage evidence.

The native SCSI association owns a logical byte position for its source
file descriptor. Successful SCSI reads advance that position without seeking
on the block descriptor. Absolute and relative libdvdcss seeks, sequential
reads, and vectored reads share this position, including unscoped metadata
reads and scoped archive, recovery, and endpoint reads. A scoped request must
match the logical cursor. Seek/read interposition declares libc before its
macros so large-file redirects cannot bypass the cursor.

Association validation and descriptor cleanup retain their existing identity
checks. A failed association open or validation fails closed. It cannot
switch to block reads after SCSI has advanced a separate cursor. When no
SCSI-generic node is discoverable, the validated source block descriptor
supplies SG_IO passthrough using the same logical cursor. Regular image files
retain ordinary file I/O. Worker claims, cancellation, drive identity, and
media-generation checks still fence operations independently of native
positioning.

Local request or positioning errors and malformed transfers fail as local
helper errors. Diagnostics distinguish SG_IO syscall errors, SCSI command
failures, and short transfers. Only actual classified SCSI read failures can
enter the existing source-damage or boundary policies.

Synthetic native coverage includes a successful read crossing a smaller
cached boundary, subsequent reads, absolute and relative seeks, compiled
libdvdcss reads and vectored reads, resumed recovery, and endpoint checks.
Worker coverage requires automatic completion with both notice directions
and also verifies that failed metadata cannot complete an inspection.
