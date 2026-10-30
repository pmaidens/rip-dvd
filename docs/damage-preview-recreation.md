# Recreate a Damage Preview

Recreation inspection reads retained request evidence even after preview media
has been deleted or expired. It does not restore a file, modify the original
request, or request generation. Failure results, actual coverage, commands,
tool versions and media-removal outcomes stay with the original request.

Exact recreation creates a new request linked by `recreation.sourceRequestId`.
It requires the same proved source checkpoint and publication, Title Identity,
playback path and selection, streams, damage targeting and clip plan, and
versioned intended settings. The current source must still pass durable
checkpoint verification. Retaining a manifest or an MKV does not retain old
source bytes. This implementation can prove old bytes only while that exact
checkpoint remains available as the archive's current durable image. It does
not reconstruct an earlier image from checkpoint history.

Start with a read-only review:

```sh
rip-dvd damage-preview recreate <old-request-id>
```

The response includes `exact.available`, all `exact.reasons`, field-level
`differences` with original and proposed values, an opaque `recreationToken`,
and a fresh `preflight`. If exact recreation is available, explicitly submit:

```sh
rip-dvd damage-preview recreate <old-request-id> --key <new-mutation-key> \
  --json '{"mode":"exact","recreationToken":"<reviewed-recreation-token>","preflightToken":"<reviewed-preflight-token>"}'
```

Exact mode uses the original selection and rejects replacement selections.
The original generation must have settled. Source or Title Identity changes
report `DAMAGE_PREVIEW_OLD_SOURCE_UNAVAILABLE` or
`DAMAGE_PREVIEW_OLD_TITLE_IDENTITY_UNAVAILABLE`. A title number alone supplies
no continuity proof. Unrepresentable or unavailable streams and settings keep
exact recreation unavailable with the current preflight's blocking reasons.

For a deliberate current-revision sample, discover available titles, intervals,
streams and profiles using `damage-preview availability <archive-id>`. Choose
current identities explicitly. Review the proposed selection against the old
request with `damage-preview recreate <old-request-id> --json
'{"selection":{...}}'`. The complete selection uses the same schema as ordinary
preview availability. This returns differences and a fresh current-revision
preflight without mutating anything. Then submit the reviewed selection:

```sh
rip-dvd damage-preview recreate <old-request-id> --key <new-mutation-key> \
  --file <reviewed-current-revision-request.json>
```

That file contains `mode: "current_revision"`, the complete `selection`, and
both returned tokens. `--stdin` and `--json` accept the same object. Changed
inputs require this explicit mode; exact recreation never substitutes them.
An unavailable proposed preflight still blocks submission. Stale recreation
review returns `DAMAGE_PREVIEW_RECREATION_STALE` with current comparison and
identities. A stale preflight returns `DAMAGE_PREVIEW_STALE`. Neither creates
partial work. Same-key replay returns the original admission result after
source changes or generation; changed semantic input conflicts with the key.

Web and JSON CLI use the same operations. The Damage Preview panel's Review
recreation action works with the retained request identity. It displays exact
availability, differences, and an explicit exact request button. Recreation
review refreshes current title and profile choices; a vanished title observation
requires an explicit current choice. Refreshing availability invalidates the
prior selection review while preserving the historical recreation link. To use
current inputs, review selections in the availability form, inspect the updated
differences, then select Request linked current-revision sample.
`GET /api/damage-previews/<request-id>/recreate` inspects original selections.
`POST` with `mode: "review"` and a proposed `selection` inspects differences;
`POST` with exact or current_revision mode admits reviewed work. POST requests
use the deployment's trusted-origin mutation boundary.

The linked request follows ordinary preview ownership, planned Recovery pause,
Recovery Stop priority, cancellation, worker restart and retention rules.
Generation records current tool versions, resolved commands, stream mapping,
coverage and sample deviations. `recreation.generationDifferences` compares
recorded resolved-command semantics, tool versions, stream mapping and deviations
with the original. Expected request-specific output paths are excluded from
command comparison; source and generation flags remain visible.
Before generation this comparison is pending. Exact inputs do not promise
byte-identical output or watchability. A new request never changes Title Damage
Acceptance, output correspondence, Keep or admission of new-format archives.

## Validation handoff

The focused persistence and adapter tests are
`apps/operator-cli/src/damage-preview-recreation.test.ts` and
`apps/web/app/api/damage-previews/[id]/recreate/*.test.ts`.
Run them sequentially with the repository's pinned Node and package manager.
Use a canonical temporary root, such as `TMPDIR=/private/tmp` on macOS. Preview
media paths must resolve to themselves for safe worker deletion.

Before public delivery, run the required `pnpm check`, `pnpm test:browser`, and
`pnpm test:operator-cli-deployment` gates under coordinated resource authority.
The browser suite covers the explicit recreation review and request controls
on its configured desktop and mobile projects. The installed smoke checks
retained historical evidence after worker media deletion and rejects exact
recreation when the original source proof is unavailable.

On the authorized Linux native lane, run
`apps/encode-worker/src/damage-preview-generator.test.ts` to check real synthetic
DVD streams, selected clips, tool versions and MKV decoding. Run
`packages/worker-runtime/src/archive-preview-ownership.process.test.ts` and
`scripts/smoke-preview-ownership.sh` to check reader closure, worker liveness
and oldest-waiter ownership across process and container boundaries. The linked
request uses the same generator and ownership path. Full image builds and these
native/process/installed checks belong to that coordinated lane. Record their
actual results before delivery; authored checks are not execution evidence.

The queued command and evidence contract is executable without starting a gate:

```sh
node scripts/validation/preview-recreation-plan.mjs --check
```

This prints JSON only. Every gate remains `queued`; file discovery is not
execution evidence. Record exact source revision, runtime/image provenance,
commands, exit status, counts, skips and private raw output when a coordinator
later grants the lane. The existing full-check, browser, HTTP parity, native
stream and ownership scripts remain in that plan.

`apps/web/app/api/damage-previews/[id]/recreate/native-roundtrip.test.ts`
adds a real two-generation workflow. Run it in the Linux native lane with
`RIP_DVD_RECREATION_NATIVE_TEST=1`. It authors a small synthetic DVD, submits
and generates a sample, admits deletion, proves worker unlink and old-export
absence, recreates a distinct linked request, exports and decodes the new MKV,
and verifies unchanged source bytes and original history. Missing native
prerequisites fail an opted-in run. A default skip is not native evidence.
The shared DVD authoring fixture preserves the existing native stream test.

`scripts/smoke-preview-recreation.sh` adds successful installed exact and
current-revision admission after configured-worker deletion. Supply already
built, source-proven validation, operator CLI and Encode-worker images through
`RIP_DVD_RECREATION_VALIDATION_IMAGE`, `RIP_DVD_RECREATION_CLI_IMAGE` and
`RIP_DVD_RECREATION_WORKER_IMAGE`. It inspects those images before starting,
uses an isolated random Compose project and a synthetic-volume sentinel, and
performs no build, pull or image cleanup. The installed wrapper checks replay,
conflict, stale rejection, cancellation and preserved history. This gate does
not claim regenerated-media evidence; the native roundtrip owns that assertion.
The existing installed smoke still covers canonical caller export and missing
source proof. Both installed gates remain required for this recreation slice.

The installed assertion program is
`scripts/validation/verify-preview-recreation-installed.mjs`.
Its public-runner persistence test and the sentinel-protected fixture writer
can be checked locally without Docker or native media. Their success verifies
the harness and fixture, not the installed container workflow.
