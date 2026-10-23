# Prove title missing source at one checkpoint

A Title Missing-Source Percentage is meaningful only when one concrete DVD
playback path has a complete physical source map. The denominator includes the
unique navigation and multiplexed-content sectors referenced by that path,
angle, and chapter selection. Repeated references within one title count once.
The same physical sector may count independently for every title that uses it.

For `dvd-recovery-evidence-v1`, a Title Damage Assessment is immutable and
bound to one committed evidence manifest, one Title Identity review set, and
one Structural Assessment. A worker may claim complete mapping only when the
current DVD navigation and title-enumeration findings are valid. Partial maps
must retain an explicit reason. A checkpoint-stable reader gathers source
references while shared Archive Image Ownership is held, rechecks the
checkpoint and both dependency identities, and persists the assessment before
the read interval ends.

Routine status projections establish the same Title Identity dependency
without traversing historical observations by comparing the assessment's
stored Catalog mapping projection identity at the same exact checkpoint. That
bounded projection contains every mutable mapping input to the review set; the
remaining review-set evidence is immutable within the checkpoint. An older
assessment without that projection identity is outdated rather than assumed
current.

The assessment intersects each title's deduplicated source set with current
Unrecovered Source. Complete maps expose the unique numerator, denominator,
and percentage. Partial maps expose known intersections but omit the
denominator and percentage. Unrecovered ranges outside all known title paths
remain visible as unknown title impact. The system reports that no selected
title path contains missing source only when navigation and title enumeration
are valid, every title map is complete, every title intersection is empty, and
no Unrecovered Source remains outside known paths.

Catalog Review reads the same assessment through web and JSON CLI adapters.
Pages bind their cursor to the archive, manifest revision and digest, and
assessment identity. A cursor for different evidence fails instead of reading
a new revision at the old offset. Historical archives retain their existing
semantics. New-format Archive Job admission remains closed.
