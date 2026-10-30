# Damage Preview browser viewing

A retained canonical Damage Preview can supply an authenticated Browser Viewing
Rendition through the same conversion worker and media endpoint as Encode
Outputs. The capability uses the existing disabled-by-default Browser Viewing
Rendition configuration. Enabling or deploying it requires the validation in
`docs/browser-rendition-validation.md`; this change does not enable admission.

Review a canonical artifact, then submit its exact review token and subtitle
selection through either adapter:

```sh
rip-dvd damage-preview rendition-availability damage-preview-v1.<request-id>.0
rip-dvd damage-preview request-rendition damage-preview-v1.<request-id>.0 \
  --key <mutation-key> --json '{"reviewToken":"<review-token>"}'
rip-dvd damage-preview inspect-rendition <rendition-request-id>
```

`rendition-availability` and `request-rendition` accept the same optional
`burnSubtitleIndex`, the actual canonical subtitle stream index. Creation uses
`--key` and the existing `--json`, `--file`, or `--stdin` structured input forms.
Inspection uses the rendition request identity. Availability and inspection
are read-only. A request is admission to conversion, not completion.

The HTTP boundary is
`GET|POST /api/damage-preview-media/<artifact-identity>/renditions`.
`GET /api/browser-renditions/<request-id>` inspects either source kind.
`GET|HEAD /api/browser-renditions/<request-id>/media` authorizes every access,
including every byte-range request. Review, creation and inspection require the
same authentication; mutations also require a trusted origin. The local JSON
CLI uses its existing database and filesystem authority without calling HTTP.

## Shared contracts

These contracts are also relevant to work on Encode Output playback:

- `BrowserRenditionRecord.sourceKind` is optional. Existing records with no kind
  remain Encode Output renditions with their original mutation operation and
  replay shape. New `damage_preview` records use the separate
  `damage-preview-request-rendition` operation in the existing durable table.
- `sourceJson` remains the immutable canonical source snapshot.
  `presentBrowserRendition().source` can now be a Damage Preview source, identified
  by `kind: damage_preview`, or the existing Encode Output artifact. Both have
  `identity` and probed `media`. Preview sources have `requestId`, canonical MKV
  checksum/size/type, generation result, actual coverage and its method, and
  original revision/selection/settings provenance. They have no output validation
  or Encode Job fields. Output consumers must narrow before using those fields.
- `previewCondition` is separate, refreshed from the retained preview on every
  inspection and media open. It preserves generation status independently of
  `outdated`, current canonical media availability and generation reasons.
  A complete MP4 conversion can still represent partial, interrupted, failed or
  outdated sample work. It never promotes that sample to a complete preview.
- `playback.kind` is `damage_preview_sample` for previews and remains `ordinary`
  for outputs. `damageSeek` remains null and watchability remains `not_assessed`.
  This adds no source-to-output correspondence or targeted output-seek control.
- The conversion plan and generator are shared. Actual streams determine stream
  copy or H.264/AAC conversion. Present audio, codec differences, omitted soft
  subtitles and the optional separately selected burned subtitle remain recorded.
  A probe or conversion failure cannot publish playable rendition media.
- Admission verifies the canonical checksum, stream probe, stable file identity,
  retained artifact/provenance and exact review token. Currency changes invalidate
  an old review. A fresh review may deliberately request retained outdated media.
  The worker snapshots the reviewed canonical bytes and rechecks their actual
  streams. Later archive changes do not retarget or invalidate that saved clip.
- Preview media responses carry `X-Damage-Preview-State`,
  `X-Damage-Preview-Generation` and `X-Damage-Preview-Outdated`; they carry no
  Encode Output validation headers. The player keeps source conditions, revision,
  actual coverage and canonical relationship beside playback and refreshes them
  while the player is mounted, including after playback errors. Both players use
  `useBrowserRendition` for restoration, response fencing, polling and mutation
  replay; each player selects its polling policy and keeps its own source labels.
- Rendition range access refreshes the parent preview's media-use time. Pending
  canonical deletion immediately revokes new derived-media access. After canonical
  deletion or proven absence, the rendition worker removes its owned MP4 directory
  under its execution lock, synchronizes the parent directory before committing
  absence, and preserves request/conversion history. Eligibility uses the exact
  artifact's durable removal outcome even when deleting a sibling clip failed;
  `previewCondition.canonicalMediaRemoved` reports this separately from the
  aggregate canonical deletion status. A source
  becoming outdated alone does not remove or relabel its immutable provenance.

Canonical exports and the existing Damage Preview generation, recreation and
retention decisions keep their existing operations. No sample is presented as
finished Encode Output, exact playback-loss prediction or a watchability verdict.
