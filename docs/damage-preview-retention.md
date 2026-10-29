# Damage Preview media retention

Inspection preserves the request identity, selections, generation result,
coverage and original provenance after media removal. A missing, deleted or
expired sample is never evidence of a clean source. The original generation
status remains separate from media availability.

Current complete samples remain protected during active Catalog Review and
while inspection of a related finished output remains unproved. Choosing
archive-only releases this protection. An output's current Disc Selection or
Encode Job alone never proves that it represents the sample. Missing receipts,
source evidence, validation evidence or correspondence keep current media
protected with an explicit reason.

Preview inspection reads exact-generation acknowledgement receipts through the
shared Encode Output identity inspector. `finishedOutputInspection` reports
matching receipts separately from whether the output represents this sample.
A bounded lookup considers up to 100 receipts for the exact observed generation,
then requires the same file mutation and immutable provenance. A later
probe-unknown acknowledgement does not revoke an earlier applicable passing
receipt. Truncated receipt discovery is reported. Unmatched history and matching
job identity cannot acknowledge another generation.
The receipt's captured source snapshot stays unchanged, including historical
`not_recorded` evidence. Ordinary inspection never creates a receipt.

A proof requires a currently owned, regular, nonempty normal output matching its
recorded filesystem identity and the receipt's exact file mutation revision,
generation, validation identity and immutable provenance. The receipt must have
captured passing validation with its immutable validation record and checks.
Failed outputs and receipts with unknown validation cannot release retention.
A successful later probe cannot upgrade the receipt's original unknowns.

The source comparison uses only the preview's saved request and the receipt's
original source snapshot. It requires the same archive identity/fingerprint,
manifest identity/revision/digest, title identity/observation/content digest,
navigation, playback path, angle, source title metadata, and profile
identity/key/version/settings. The manifest digest binds the committed source
revision; current catalog links, filenames and mutable jobs supply no proof.

The current proved equivalence has two bounded differences:

- A normal full-title Encode includes a preview's time window when both name the
  same complete chapter path starting at chapter one, and the requested window
  ends within both stored title duration and recorded observed output duration.
  A chapter subset remains unproved because the producer records no chapter-time
  map. This proves source selection containment, not a damage seek or playback.
- The normal output's versioned `encode-claim-output-v1` policy includes all
  source audio/subtitles without subtitle burn. A preview may choose an audio
  subset from those same recorded streams. Selected audio must also occur in
  the validation's output source IDs. Previews with selected subtitles remain
  protected because successful validation can remove empty subtitle tracks and
  does not record surviving source subtitle IDs. Additional output tracks do not
  replace a selected preview stream. The recorded format, preset, navigation mode and
  concrete title/angle/chapter arguments must match the intended settings.

A matching proof satisfies only the finished-output condition. Active Catalog
Review still protects a current sample. The acknowledgement makes no watchability,
damage-interval inspection or Keep claim. Replacement bytes, changed validation,
unsafe/missing media, or mismatched source/settings cannot inherit authority.

Candidate discovery uses bounded current catalog links and reports truncation.
Those mutable links are hints only; the proof remains immutable. Discovery that
misses an older candidate conservatively preserves media. Identity checks run
without media probes during inspection, cleanup and media-status projection.
Wait, cancellation, deletion and media transfer leave `finishedOutputInspection`
null in their status response. The retention decision still rechecks applicable
receipts synchronously, so unrelated probes cannot extend a wait deadline or
block the cleanup transaction.

Unprotected media expires after 30 idle days. Outdated and partial media can
expire during active review. Successful canonical media access resets idle
time. Read-only status inspection does not. The Encode worker applies cleanup
between preview polls. Generation must settle before any removal.

The Damage Preview web panel offers explicit media deletion before the idle
deadline, including for a current protected sample. The JSON CLI uses the same
rules. First inspect the request, then pass its current `media.token` in a
structured input with a mutation key:

```sh
rip-dvd damage-preview inspect <request-id>
rip-dvd damage-preview delete <request-id> --key <mutation-key> \
  --json '{"mediaToken":"<reviewed-media-token>"}'
rip-dvd damage-preview cleanup <request-id> --key <mutation-key> \
  --json '{"mediaToken":"<reviewed-media-token>"}'
```

Cleanup enforces retention and idle time. Explicit deletion bypasses those
two conditions. Both reject a stale media token without deleting files.
Reusing the same key and input returns the saved outcome; changed input
conflicts. Deletion does not cancel generation or change damage acceptance.

Filesystem observations and response projection run outside SQLite writer
transactions. Admission rechecks preview metadata, current review state and the
recorded output authority using the staged observations. Actual unlink also
checks the admitted preview file identity. Removal saves a durable intent before deleting files. After an interrupted
removal, replaying its invocation or restarting the preview cleanup loop
finishes that intent. Removal failures preserve their outcomes and stop
automatic retries. An operator can inspect, correct the filesystem problem,
and explicitly retry deletion with a new token and key. Earlier removal
failures remain in `media.history`.

Inspection and canonical export distinguish `DAMAGE_PREVIEW_MEDIA_DELETED`,
`DAMAGE_PREVIEW_MEDIA_EXPIRED`, `DAMAGE_PREVIEW_MEDIA_MISSING`,
`DAMAGE_PREVIEW_MEDIA_REMOVING` and `DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED`.
Storage inspection failures report `DAMAGE_PREVIEW_MEDIA_UNAVAILABLE`, and
unsafe paths report `DAMAGE_PREVIEW_MEDIA_UNSAFE`, without claiming absence.
A request that generated no artifact reports `not_generated`; an unknown
request reports `NOT_FOUND`.
