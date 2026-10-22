# Bind structural assessments to committed DVD checkpoints

Structural validity is independent of source read completeness. A complete
Archive Job can preserve every accepted source sector while the resulting DVD
filesystem, navigation, or title enumeration is invalid or cannot be proved.
Conversely, an incomplete archive can still have useful structural findings
for the extent that was tested. Structural findings therefore do not mutate
Archive Integrity and cannot authorize source-damage acceptance.

For `dvd-recovery-evidence-v1`, a Structural Assessment is an immutable record
bound to one committed evidence manifest. Its checkpoint includes the archive,
manifest identity and revision, manifest digest, and accepted end LBA. The
required findings cover filesystem structure, DVD navigation, and title
enumeration. Each finding records its check policy, tested extent, outcome,
reason, and evidence reference. The tested extent is derived from the physical
dependencies actually observed by that check. Its bounds and observed-sector
count make sparse reads explicit; it does not claim that every sector between
the bounds was examined. Outcomes are `valid`, `invalid`,
`indeterminate`, or `not_run`. Overall validity is invalid when any finding
proves a contradiction, valid only when every required finding is valid, and
unknown otherwise.

The assessment identity is derived from canonical checkpoint and finding
semantics. Reordering identical findings reuses the identity; a changed result
or evidence reference creates a new identity. Every execution also appends an
immutable attempt record. A failed later attempt remains visible but does not
erase a completed assessment for the same checkpoint.

Image-reading checks run while shared Archive Image Ownership is held across
checkpoint validation, checker execution, final checkpoint revalidation, and
completed-assessment persistence. That persistence is the ownership operation's
synchronous terminal commit: it runs only after final ownership validation,
and it checks the current database checkpoint in the same transaction. A
failed interval therefore cannot leave a completed assessment behind. The
completed-assessment persistence operation is not available outside that owned
interval. The initial concrete checker reuses the bounded full-extent metadata profile while
tracking filesystem, title-enumeration, and navigation execution separately;
unproved physical dependencies remain indeterminate and later checks remain
`not_run` after an earlier interruption.
If the committed image cannot be read consistently, the attempt records a
stable failure reason against the checkpoint that was actually read. A failure
detected after final ownership validation retains that attempted checkpoint;
the database records it only when the checkpoint still matches, and never
rebinds it to a newer revision. If recovery advanced first, the failed interval
is returned as unavailable without creating a revision-bound attempt. The last
completed assessment remains visible as outdated after the checkpoint advances
until a check completes for the new checkpoint.

Original Disc Archive inspection exposes the same structural state through
the web operations route and public JSON CLI. Historical archives retain their
existing response and meanings. New-format Archive Job admission remains
closed; this assessment contract does not make the unfinished recovery or
damage-acceptance workflow available.
