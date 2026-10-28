# Damage Preview media retention

Inspection preserves the request identity, selections, generation result,
coverage and original provenance after media removal. A missing, deleted or
expired sample is never evidence of a clean source. The original generation
status remains separate from media availability.

Current complete samples remain protected during active Catalog Review and
while inspection of a related finished output remains unproved. Choosing
archive-only releases this protection. An old output's current Disc Selection
alone does not prove that it represents the sample. When immutable output
correspondence or a durable operator inspection receipt is unavailable,
inspection reports `FINISHED_OUTPUT_INSPECTION_NOT_RECORDED` and protects the
current sample.

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

Removal saves a durable intent before deleting files. After an interrupted
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
