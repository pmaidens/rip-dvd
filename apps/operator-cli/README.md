# Server-local JSON CLI

The installed `rip-dvd` command starts the production `operator-cli` image as a
short-lived Compose process. It mounts the same SQLite data and libraries as
the application, but it uses `--no-deps`, so it neither starts nor calls the web
service. Run `./install.sh` from the deployment checkout, then use `rip-dvd`
from an SSH session on that server.

Bare invocation returns command discovery as JSON. `rip-dvd help <command>`
returns the selected command's arguments, options, and a synthetic example.
Every invocation writes exactly one JSON document to stdout. Diagnostics go to
stderr and never alter that document.

Exit status has a stable meaning:

- `0` means the command completed.
- `1` means configuration or application execution failed.
- `2` means the input, target, or requested transition was rejected.
- `3` means a bounded wait expired without cancelling the work.

Commands never prompt. Simple values use flags. Complex catalog input accepts
exactly one of inline JSON, stdin, or a file:

```sh
rip-dvd media-item create --key <key> \
  --json '{"kind":"movie","title":"Example Film","year":2020}'
printf '%s\n' '{"label":"Feature"}' | \
  rip-dvd disc-selection update <archive-id> <selection-id> --key <key> --stdin
rip-dvd catalog-review preview-completion <archive-id> --file <completion.json>
```

The installed wrapper mounts the one `--file` input read-only into the CLI
container. Relative paths resolve from the directory where `rip-dvd` is run;
absolute paths are passed through at the same path.

Generate and retain a key before every mutation:

```sh
rip-dvd generate-key
rip-dvd submit-archive-request --key <key> --detected-disc-id <disc-id>
```

Repeating the same mutation with the same key and semantic input returns the
original result. Using that key for another operation or changed input returns
`MUTATION_KEY_CONFLICT`. Key generation does not open the database or submit
work.

Replacement and destructive changes require a read-only preview. Apply the
same input with the returned revision and preview token plus `--acknowledge`.
The command rejects a stale or changed preview without applying part of the
plan.

Background submissions return a durable work ID immediately. The worker owns
execution after the CLI exits. Inspect it in another session or wait for a
bounded interval:

```sh
rip-dvd submit-archive-audit --key <key> --limit 100
rip-dvd inspect archive-audits <run-id>
rip-dvd wait archive-audits <run-id> --timeout-ms 30000
```

Wait expiry and SSH disconnection do not cancel submitted work. The same
status and wait pattern applies to Disc Inspections, Archive Requests, Archive
Jobs, Archive Recoveries, Encode Jobs, archive audits, and filesystem
verification.

The former `interactive`, `rip`, `scan`, `title`, `extras`, `queue`, `encode`,
and `join` forms are retired. Each returns `LEGACY_COMMAND_RETIRED` with a
migration direction instead of acquiring a new meaning.

# Archive Request commands

Every preservation mutation requires a key chosen before submission. A normal
Archive Request targets a Detected Disc. A Re-archive Request targets the exact
Original Disc Archive that should remain as its predecessor.

```sh
rip-dvd submit-archive-request --key <key> --detected-disc-id <id>
rip-dvd request-rearchive --key <key> --source-archive-id <id>
```

`request-rearchive` creates fresh request-owned copy state and returns the new
Archive Request ID, lineage target, and current waiting reason. Use `inspect
archive-requests <request-id>` or `wait archive-requests <request-id>` to follow
it. Retrying a failed request continues that same request and rescue state. It
does not create a fresh generation. The prior archive and its catalog history
remain unchanged when the request succeeds, fails, or is cancelled.

# Archive Recovery evidence

Inspect a recovery's current accepted extent, checkpoint identity, category
counts, pass progress, and bounded history. Page every normalized source range
by carrying `nextCursor` into the next request:

```sh
rip-dvd archive-recovery ranges <recovery-id> --limit 100
rip-dvd archive-recovery ranges <recovery-id> --limit 100 --cursor <cursor>
```

A range cursor is bound to the exact recovery checkpoint. If that checkpoint
changes, the command returns `available: false` with the current checkpoint
and progress identities instead of combining pages from different revisions.
`completionEstimate` is either a minimum and maximum for the current pass or
`unknown`; it is never an overall recovery estimate. Pass observations are
counted incrementally from the durable checkpoint revision recorded when that
pass starts, so polling does not rescan the checkpoint history. A pass already
in flight during an upgrade reports unavailable observation counts and an
`unknown` estimate until the next revision-bound pass starts.
Transition history is a bounded recent view; `totalCount` is `null` and
`truncated` is `true` when older meaningful transitions fall outside that
view. Immutable read metadata identifies meaningful transitions before the
bounded evidence validation step, so repeated no-change reads do not make the
polling query grow with the full recovery history.

# Catalog Review read commands

Run the server-local `rip-dvd` executable with the same database and
library configuration as the application. Commands write one JSON result to
stdout. Invalid input exits 2; an unavailable read exits 1.

```sh
rip-dvd catalog-review show <archive-id>
rip-dvd catalog-review damage <archive-id> [--limit 100] [--cursor <cursor>]
rip-dvd catalog-review preview-damage-acceptance <archive-id> [--exclude-title-identity <id> ...] [--resolve-main-feature <disc-selection-id> <title-identity-id> ...]
rip-dvd catalog-review preview-damage-acceptance <archive-id> --json '<object>'
rip-dvd catalog-review preview-damage-acceptance <archive-id> --stdin
rip-dvd catalog-review preview-damage-acceptance <archive-id> --file <path>
rip-dvd catalog-review accept-damage <archive-id> --key <key> --json '<exact-preview-input>'
rip-dvd catalog-review archive-only <archive-id> --key <key> --revision <catalog-revision> --checkpoint-revision <n> --checkpoint-digest <digest>
rip-dvd catalog-review reopen <archive-id> --key <key> --revision <catalog-revision> --checkpoint-revision <n> --checkpoint-digest <digest>
rip-dvd catalog-review suggest <archive-id>
rip-dvd catalog-review suggest <archive-id> --tmdb-id 42 --media-type movie
```

`show` returns the current catalog revision, archive and scan provenance,
coverage, Media Items, Disc Selections with structured action availability,
correction history, and corrected Encode Job and retained-output history.
For a `dvd-recovery-evidence-v1` archive, `reviewWorkflow` also reports the
initial save, current recovery, mapping state, damage-decision readiness,
current workflow identities, and stable reasons for unavailable actions.
Mapping remains available while recovery is active. Legacy archives keep the
legacy response and completion behavior.
`preview-damage-acceptance` starts with every Title Identity observed at the
current checkpoint, including unmapped content and every angle. Repeat
`--exclude-title-identity` only for content the operator does not want. An
available result returns the concrete catalog mappings, angle and chapter
bounds, assessment snapshots, damage and unknown coverage, affected work, the
identities a later acceptance must present, and a persisted opaque token. The
preview does not accept damage or queue an Encode Job. A missing optional
Damage Preview never appears as an acceptance blocker. Repeat
`--resolve-main-feature` to bind each active main-feature Disc Selection to an
exact current Title Identity; unresolved main-feature choices remain blocked
and no representative title is inferred. Instead of repeatable flags, pass the
same `excludedTitleIdentityIds` and `mainFeatureResolutions` fields as one JSON
object with `--json`, `--stdin`, or `--file`.
`accept-damage` submits the preview token, operator, expected checkpoint,
assessment, mapping projection, complete review-set identity, reviewed-content
identity, exclusions, and main-feature resolutions. Set
`damageAcknowledgement` to `true` when the preview requires it. The database
checks every identity in one transaction and records an immutable decision
with the assessment snapshot. A changed checkpoint, assessment, mapping, or
review set returns `STALE_TITLE_DAMAGE_DECISION` with current identities and
records nothing. Reusing the same mutation key with the same input replays the
result; changing the input conflicts. The decision does not queue encoding,
claim watchability, or waive Encode Output validation. `show` reports the
current decision or its derived `expired` state.
`reviewActionAvailability` reports whether completion with selections or
Archive-only completion is currently allowed, with a reason when blocked.
Each paginated section includes its offset, limit, and next/previous flags.
Use `--selection-offset`, `--correction-offset`, `--correction-job-offset`,
`--correction-output-offset`, `--replacement-offset`, and
`--replacement-profile-offset` to read later pages. Offsets start at zero.

`damage` returns revision-bound Title Damage Assessment evidence. Each response
includes the checkpoint revision, item offset, bounded items, truncation state,
and a next cursor. Continue with the returned `nextCursor` until it is `null`.
The response reports Unrecovered Source separately from Source-Continuity Risk
introduced by operator-confirmed mismatched or inconclusive recovery. Confirmed
source ranges include their immutable confirmation and verification provenance.
Risk outside all known title paths remains in
`unattributedSourceContinuityRisk`, including after Archive Integrity becomes
`clean_read`.
Each affected title also reports `estimatedAffectedPlayback`. Qualified
intervals keep repeated playback occurrences separate and identify their
timing method and either source-span or whole-cell coverage. Missing source
that cannot be placed on the timeline remains in occurrence-specific
`unknownCoverage`. The intervals locate affected source; they do not report
exact playback lost or bound decoder effects.
The default limit is 20 and the maximum is 100. A cursor stops being valid when
the checkpoint or its current assessment changes and returns
`TITLE_DAMAGE_CURSOR_STALE`; restart without a cursor to inspect the current
state. Outdated assessments retain their summary and unavailable reasons but do
not expose a partial historical item page.

`suggest` returns a proposal or a `needs_review` reason. When TMDB search
succeeds, `candidates` contains the returned movie and TV matches, even if
the proposed match is uncertain or absent. A selected TMDB identity must be
present in the current search results. The lookup does not change the catalog;
accept a proposal through a catalog mutation workflow with its revision.

All three commands return `REVIEW_NOT_FOUND` for an unknown archive ID.
`INVALID_ARGUMENTS` covers malformed offsets and TMDB selections. A failed
read returns `CATALOG_REVIEW_UNAVAILABLE` without exposing database or
provider details.

For a newly published re-archive, `show` also returns `rearchiveProposal`.
That object keeps prior and fresh archive integrity and boundary evidence
beside each prior mapping and its editable proposed fresh source. Its state is
`ready`, `incomplete`, `incompatible`, or `stale`. Reading or previewing it
does not create a Disc Selection.

## Review a Re-archive Mapping Proposal

Use the proposal revisions returned by `catalog-review show`. Pass exactly one
of `--json`, `--stdin`, or `--file`. Preview is read-only. Saving requires a
preselected invocation key and persists only the reviewed proposal; Re-archive
Acceptance is a separate operation and is the only workflow that may later
adopt these mappings.

```json
{
  "action": "preview_rearchive_mapping_proposal",
  "catalogRevision": "2026-01-02T00:00:00.000Z",
  "sourceCatalogRevision": "2026-01-01T00:00:00.000Z",
  "mappings": [{
    "sourceDiscSelectionId": "<prior-selection-id>",
    "mediaItemId": "<media-item-id>",
    "sourceIdentity": { "kind": "dvd_title", "titleNumber": 2 },
    "label": "Feature"
  }]
}
```

```sh
rip-dvd catalog-review preview-rearchive-proposal <fresh-archive-id> \
  --file <preview.json>
rip-dvd catalog-review save-rearchive-proposal <fresh-archive-id> \
  --key <key> --file <save.json>
```

For save input, change `action` to `save_rearchive_mapping_proposal` without
changing the reviewed fields. Every active prior Disc Selection must appear
exactly once. Proposed Media Items must still exist, and DVD title or chapter
coordinates must be valid in the fresh inspection. A
changed prior or fresh Catalog Review revision returns
`STALE_CATALOG_REVISION`; incomplete and incompatible proposals return
`REARCHIVE_PROPOSAL_INCOMPLETE` and `REARCHIVE_PROPOSAL_INCOMPATIBLE`.
Repeating the same key and input returns the first saved result; reusing the key
for different input returns `MUTATION_KEY_CONFLICT`.

## Accept a reviewed re-archive

Save a ready Re-archive Mapping Proposal first. The acceptance document may
list only the predecessor Encode Jobs that should be replaced. Omit
`replacementEncodes`, or pass an empty array, to accept the mappings without
queueing replacement encodes.

```json
{
  "action": "accept_rearchive",
  "catalogRevision": "2026-01-02T00:00:00.000Z",
  "sourceCatalogRevision": "2026-01-01T00:00:00.000Z",
  "replacementEncodes": [{
    "predecessorEncodeJobId": "<encode-job-id>",
    "encodingProfileId": "<encoding-profile-id>",
    "outputPath": "/media/movies/Example Film (2020)/Example Film (2020).mkv"
  }]
}
```

```sh
rip-dvd catalog-review preview-rearchive-acceptance <fresh-archive-id> \
  --file <acceptance.json>
rip-dvd catalog-review accept-rearchive <fresh-archive-id> \
  --key <key> --revision <catalog-revision> \
  --source-revision <source-catalog-revision> \
  --preview-token <preview-token> --acknowledge --file <acceptance.json>
```

The review and preview list replacement candidates from the prior selection
lineage. A selected replacement may keep its prior Encoding Profile and output
path or use an active DVD video profile and another unreserved path inside the
configured media library. Preview validates the complete selection, reports
selected and omitted candidates, and binds those choices to its token.

Acceptance adopts the saved mappings on the fresh archive, stops later enqueue
from the prior selections, cancels queued jobs or requests cooperative
cancellation of running jobs, and queues each selected replacement against the
new Disc Selection. Unselected jobs are not re-encoded. The transaction keeps
both archives, completed outputs, historical mappings, and job provenance.
Replacement publication uses the same retained-output safeguards as corrected
Catalog Review replacements. Repeating the same key and document returns the
original result without duplicate jobs; changing the document with the same key
is rejected.

## Apply a complete Mapping Proposal

`catalog-review apply-proposal` accepts one complete movie or episodic
proposal. Get `catalogRevision` from `catalog-review show <archive-id>`. Choose
an invocation key before submitting. The same key and proposal recover the
original result after a lost response. A key reused for different input fails.
Each proposal validates and commits as one catalog change. A stale revision or
invalid member leaves the Media Items and Disc Selections unchanged.

Pass exactly one of `--json '<object>'`, `--stdin`, or `--file <path>`. The JSON
object has the same fields in every form. The key and archive ID remain command
arguments. A file is optional.

Movie proposal schema:

```json
{
  "action": "create_mapping_proposal",
  "catalogRevision": "2026-01-01T00:00:00.000Z",
  "target": {
    "choice": "create_new",
    "mediaItem": { "kind": "movie", "title": "Example Film", "year": 2020 }
  },
  "discSelection": {
    "sourceIdentity": { "kind": "dvd_title", "titleNumber": 1 }
  },
  "completeReview": true
}
```

For an existing Media Item, use
`"target":{"choice":"use_existing","mediaItemId":"<media-item-id>"}`.
The optional `discSelection.label` names the selected source. Source kinds are
`main_feature`, `dvd_title`, and `dvd_chapters`. A chapter source also needs
`titleNumber`, `chapterStart`, and `chapterEnd`. Omit `completeReview` to leave
Catalog Review open. A `dvd-recovery-evidence-v1` archive accepts exact
`dvd_title` and `dvd_chapters` sources only; `main_feature` remains available
for legacy evidence.

Episodic proposal schema:

```json
{
  "action": "create_episodic_mapping_proposal",
  "catalogRevision": "2026-01-01T00:00:00.000Z",
  "tvShow": { "choice": "create_new", "title": "Example Show" },
  "season": { "choice": "create_new", "title": "Season One", "seasonNumber": 1 },
  "episodes": [
    { "titleNumber": 1, "title": "First Episode", "episodeNumber": 1 },
    { "titleNumber": 2, "title": "Second Episode", "episodeNumber": 2 }
  ],
  "completeReview": true
}
```

`tvShow` can instead use `{ "choice": "use_existing", "mediaItemId":
"<tv-show-id>" }`; `season` can use the same form with a Season ID. Each episode
can set `existingMediaItemId` and `label`. An existing Episode must belong to
the chosen Season and match `episodeNumber`. Each `titleNumber` must name a
distinct title in this archive's scan.

```sh
rip-dvd catalog-review apply-proposal <archive-id> --key <key> \
  --json '<proposal-json>'
printf '%s\n' '<proposal-json>' | \
  rip-dvd catalog-review apply-proposal <archive-id> --key <key> --stdin
rip-dvd catalog-review apply-proposal <archive-id> --key <key> \
  --file <proposal.json>
```

The command writes one JSON result and exits 0 on success. Invalid JSON or
proposal shape exits 2 with `INVALID_ARGUMENTS` or `INVALID_PROPOSAL`.
Rejected members, stale revisions, and key conflicts exit 2 with
`PROPOSAL_REJECTED`, `CATALOG_MAPPING_SOURCE_UNSUPPORTED`,
`STALE_CATALOG_REVISION`, or `MUTATION_KEY_CONFLICT`.
Database unavailability exits 1 with `PROPOSAL_UNAVAILABLE`.

## Choose archive-only or reopen

For a `dvd-recovery-evidence-v1` archive, copy the catalog revision and current
checkpoint identity from `catalog-review show`. Archive-only is available after
Archive Recovery stops or completes. It records an explicit choice without
accepting damage or queueing an Encode Job. Reopen records a new choice against
the current checkpoint and does not restore an expired damage acceptance.

```sh
rip-dvd catalog-review archive-only <archive-id> \
  --key <key> --revision <catalog-revision> \
  --checkpoint-revision <n> --checkpoint-digest <digest>
rip-dvd catalog-review reopen <archive-id> \
  --key <key> --revision <catalog-revision> \
  --checkpoint-revision <n> --checkpoint-digest <digest>
```

Both operations recheck the catalog revision and checkpoint atomically. A
repeated key with the same input returns the original choice. Reusing the key
with different input returns `MUTATION_KEY_CONFLICT`. `catalog-review show`
returns the 100 most recent choices and reports when older retained history is
not included in that response.

## Complete Catalog Review

Review completion is a previewed, keyed operation. Start with `catalog-review
show` and copy its current `catalogRevision`. The completion document chooses
the final outcome and lists only the corrected replacement encodes that should
be queued. An empty `replacementEncodes` array completes the review without
queueing replacements.

```json
{
  "action": "complete_review",
  "catalogRevision": "2026-01-01T00:00:00.000Z",
  "outcome": "reviewed_with_selections",
  "replacementEncodes": [
    {
      "predecessorEncodeJobId": "<encode-job-id>",
      "encodingProfileId": "<encoding-profile-id>",
      "outputPath": "/media/movies/Example Film (2020)/Example Film (2020).mkv"
    }
  ]
}
```

For historical evidence, use `outcome: "archive_only"` only when the review has
no Disc Selections, and leave `replacementEncodes` empty for that outcome.
Preview validates the whole plan, resolves output paths inside the configured
media library, reports
selected and omitted replacements plus the exact failed predecessor output
reservations it will release, and returns an opaque `previewToken` bound to the
exact plan and catalog revision.

```sh
rip-dvd catalog-review preview-completion <archive-id> \
  --file <completion.json>
rip-dvd catalog-review complete <archive-id> \
  --key <key> \
  --revision <catalog-revision-from-preview> \
  --preview-token <preview-token> \
  --acknowledge \
  --file <completion.json>
```

Both commands accept exactly one of `--json`, `--stdin`, or `--file`. Applying
the plan revalidates the review, profiles, corrected lineage, output
reservations, and preview evidence in one transaction. Review completion and
all selected Encode Jobs commit together. Repeating the same key and document
returns the original result after a lost response; changing the document with
that key returns `MUTATION_KEY_CONFLICT`. Stale revisions and rejected plans
leave the review open and queue no replacement work.

# Disc Selection commands

Use an Original Disc Archive ID for every Disc Selection command. `show`
returns the current selection, catalog revision, available actions and blocking
reason, and associated Encode Jobs. `preview` takes a proposed action and the
same selection input as that action. It validates the proposal without saving
it and returns its effect, `catalogRevision`, and `previewToken`.
An eligible preview has `state: "available"` and `consequences` describing
whether the existing selection will be updated, superseded, deactivated, or
deleted; whether a replacement selection will be created; which active Encode
Jobs will receive cancellation requests; and whether job history remains.
Unsupported actions have `state: "blocked"`, a reason and any related Encode
Job. A blocked preview has no token and cannot be acknowledged.

```sh
rip-dvd disc-selection show <archive-id> <selection-id>
rip-dvd disc-selection create <archive-id> --key <key> \
  --revision <catalog-revision-from-show> \
  --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
rip-dvd disc-selection update <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-show> \
  --label "Main feature"
rip-dvd disc-selection preview correct <archive-id> <selection-id> \
  --revision <catalog-revision-from-show> \
  --media-item-id <media-item-id> --source-kind main_feature
rip-dvd disc-selection correct <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --preview-token <token-from-preview> \
  --acknowledge --media-item-id <media-item-id> --source-kind main_feature
rip-dvd disc-selection preview delete <archive-id> <selection-id>
rip-dvd disc-selection delete <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --preview-token <token-from-preview> \
  --acknowledge
rip-dvd disc-selection preview repair <archive-id> <selection-id> \
  --revision <catalog-revision-from-show> \
  --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
rip-dvd disc-selection repair <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --preview-token <token-from-preview> \
  --acknowledge --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
```

`create`, `update`, `repair`, `correct`, and `delete` require a previously
chosen mutation key. Repeating an identical invocation returns its original
result. Reusing the key with different inputs fails. For a
`dvd-recovery-evidence-v1` archive, `create` and every `update` also require
the Catalog Review revision returned by `catalog-review show`; the mutation
validates the source against current Title Identity evidence and rejects a
stale revision rather than retargeting a title number. New-format repair and
correction previews also require that reviewed revision. Legacy correction
previews keep their established automatic current-revision lookup. Only exact default-angle `dvd_title` and
`dvd_chapters` sources are accepted for this format. Legacy creation remains
revision-optional and continues to accept `main_feature`.
An `update` that changes
the Media Item or source, plus every `repair`, `correct`, and `delete`, requires
an action-specific preview. Pass the returned revision and token with
`--acknowledge`. A changed Catalog Review revision or different proposal
rejects the decision. Label-only updates execute directly. The catalog uses
the same archive binding, source validation, and Encode Job provenance rules
as the web editor. Every new-format mutation, including label or Media Item
updates and deletion, is rejected if current Title Identity evidence or a
consistent Recovery state is unavailable.
For an unsafe legacy selection, `delete` quarantines the selection when its
Encode Job history must remain. Inspect the affected job with
`inspect encode-jobs <job-id>` and the current mappings and correction history
with `catalog-review show <archive-id>` after a repair or correction.

Use `--media-item-id`, `--source-kind`, `--title-number`, `--chapter-start`,
`--chapter-end`, and `--label` for ordinary input. `update` also accepts
`--clear-label`. Source kinds are `main_feature`, `dvd_title`, and
`dvd_chapters`. A correction may include `--reason`. Include the same reason
in the preview and mutation.

The same selection object can come from `--json '<object>'`, `--stdin`, or
`--file <path>`. A file is optional. For create, repair, and correct, provide
`mediaItemId` and `sourceIdentity`, with an optional `label`. For update,
provide at least one of `mediaItemId`, `sourceIdentity`, or `label`; set
`label` to `null` to clear it. The key, target IDs, preview revision, token,
and acknowledgement stay as command options for every input form.

```sh
rip-dvd disc-selection create <archive-id> --key <key> \
  --revision <catalog-revision-from-show> \
  --json '{"mediaItemId":"<media-item-id>","sourceIdentity":{"kind":"dvd_title","titleNumber":1}}'
printf '%s\n' '{"label":"Featurette"}' |
  rip-dvd disc-selection update <archive-id> <selection-id> --key <key> --stdin
```

Invalid selection input exits 2 with a JSON error. Database or storage
unavailability exits 1. No command prompts for input.
# Media Item commands

Use `media-item search` to find Media Items throughout the catalog. `show`
returns the selected item's TMDB identity, revision, and maintenance state.
Search results include ancestors and the number of referencing archives.

```sh
rip-dvd media-item search --query 'Example Film' --offset 0
rip-dvd media-item show <media-item-id>
rip-dvd media-item create --key <invocation-key> --kind movie --title 'Example Film' --year 2024
rip-dvd media-item create --key <invocation-key> --kind tv_show --title 'Example Show' --tmdb-type tv_show --tmdb-id 42
rip-dvd media-item preview update <media-item-id> --title 'Corrected Film'
rip-dvd media-item update <media-item-id> --key <invocation-key> --acknowledge '<preview-revision>' --title 'Corrected Film'
rip-dvd media-item preview delete <media-item-id>
rip-dvd media-item delete <media-item-id> --key <invocation-key> --acknowledge '<preview-revision>'
```

Create and update also accept `--json '<object>'`, `--json -` for stdin, or
`--file <path>`. The object contains Media Item fields directly. Create
requires `kind` and `title`; optional fields are `parentId`, `year`,
`seasonNumber`, `episodeNumber`, and `tmdbIdentity` with `mediaType` and
`tmdbId`. Update accepts the editable fields except `tmdbIdentity`. For
example, an episode can be created with:

```sh
printf '%s\n' '{"kind":"episode","title":"Pilot","parentId":"<season-id>","episodeNumber":1}' |
  rip-dvd media-item create --key <invocation-key> --json -
```

Every mutation needs a key generated before submission with `generate-key`
or another stable source. Repeating a key and the same inputs returns the
original result, including after a process restart. A changed operation or
input with the same key returns `MUTATION_KEY_CONFLICT`. Ordinary updates
to an unused Media Item run directly. Updates that affect an archive through
the item or its descendants, change the item's kind or parent, and all deletes require a preview revision as
`--acknowledge`. Preview an update with the same changes you intend to submit;
quote the returned revision when passing it to the shell. A stale revision
returns `STALE_MEDIA_ITEM_REVISION`. A preview shows the proposed result,
eligibility, and the number of affected archives, including those referencing descendants. Catalog
hierarchy, TMDB uniqueness, and reference rules remain enforced during the
mutation. Validation and eligibility failures return JSON errors with stable
codes and exit status 2.

# Encode Job commands

Use `encode-queue` to read eligible Disc Selections, active DVD video Encoding
Profiles, suggested output paths, and paged `not_encoded` or `re_encode`
history. Supply `--encoding-profile-id` to see each row's `queueAction`, with an
eligibility reason when blocked. `--query`, `--selection-offset`, and
`--profile-offset` narrow or page the result. `encode-resolve` accepts up to 100
repeated `--disc-selection-id` flags and reports the logical job for each one
under the chosen profile. `inspect encode-jobs [id]` gives status, failure
reports, actions, and history; `wait encode-jobs <id> --timeout-ms <n>` waits
without cancelling work. When a suggested path is reserved, `queueAction`
names that conflict and exposes an eligible `enqueue-with-output-path`
alternate requiring `outputPath`.

Every Encode Job mutation requires a key created before submission. Generate
one with `rip-dvd generate-key` and keep it for retries. The same key
and inputs return the original result after a lost response or later status
change. A key reused with different inputs returns `MUTATION_KEY_CONFLICT`.
Each successful mutation returns `job.id` and `work: { kind: "encode-jobs", id }`.

```sh
rip-dvd encode-queue --encoding-profile-id <profile-id>
rip-dvd encode-resolve --encoding-profile-id <profile-id> --disc-selection-id <selection-id>
rip-dvd encode-enqueue --key <key> --disc-selection-id <selection-id> --encoding-profile-id <profile-id> --output-path /media/movies/example.mkv
rip-dvd encode-cancel --key <key> --encode-job-id <job-id>
rip-dvd encode-requeue --key <new-key> --encode-job-id <job-id>
rip-dvd encode-requeue-preview --encode-job-id <completed-job-id>
rip-dvd encode-requeue --key <new-key> --encode-job-id <completed-job-id> --revision <preview-revision> --acknowledge
rip-dvd encode-output inspect encode-output-v1.published.<encode-job-id>
rip-dvd encode-output acknowledge-inspection encode-output-v1.published.<encode-job-id> --key <key> --json '{"acknowledged":true,"reviewToken":"<operatorInspection.reviewToken>"}'
rip-dvd encode-output export encode-output-v1.published.<encode-job-id> --destination /exports/example-output.mkv
```

A completed Encode Job exposes its current and retained generations in
`encodeOutputArtifacts`; retained-output summaries also include their artifact
identity. Current identities use `encode-output-v1.published.<encode-job-id>`
and retained identities use `encode-output-v1.retained.<retained-output-id>`.
Bounded lists set `encodeOutputArtifactsTruncated` when older generations are
omitted. Page the complete history with
`inspect encode-jobs <encode-job-id> --limit 1..100 --offset <n>`; each result
returns `encodeOutputArtifactPage.nextOffset` when older generations remain.
`encode-output inspect` reports the artifact state, recorded validation and
provenance, file identity and completeness, and probed duration and streams.
Historical outputs keep unavailable validation identities and source snapshots
explicit. A successful media probe does not manufacture validation evidence.
Probe failure reports unknown inspectability and does not claim that the file
is playable. Inspection reports export as available only when the observed
regular, nonempty file matches its recorded identity.

Inspection, probing, export and playback do not record an operator
acknowledgement. Use `acknowledge-inspection` with explicit `acknowledged: true`,
the exact `operatorInspection.reviewToken` you reviewed, the artifact identity,
and a mutation key. JSON input also supports `--file` or `--stdin`.
`commands` and `help encode-output` describe the required input schema.
The response returns a durable `receipt` with its identity, generation identity,
acknowledgement time and exact evidence. Inspection exposes matching generation
receipts and the Encode Job's receipt history in `operatorInspection`.
History defaults to 20 receipts. Use `inspect --receipt-limit <1..100>
--receipt-offset <n>` and follow `operatorInspection.historyNextOffset` to page
older receipts. The HTTP query uses `receipt-limit` and `receipt-offset`.

The receipt binds the observed file and recorded validation evidence to a
particular normal output generation. Requeueing a job does not acknowledge its
replacement bytes. Retained normal generations stay separately addressable,
and their original receipts remain available. Same-key, same-input retries
return the original receipt even after later changes. Changed input conflicts
with that key. A fresh key with stale evidence fails without a receipt and
returns current inspection identities with a stable reason. Missing, unowned,
changed or unsafe files also report their observed `error.currentIdentity`
when obtainable, separately from the owned artifact's inspection state.
Unsafe or changing files cannot be acknowledged. Probe failure can be
acknowledged as an explicit unknown, preserving the reported validation result
and `playability: not_assessed`.
Receipt applicability also requires the same observed file mutation revision
and provenance. Moving a retained file may change that revision. Its original
receipt stays in history, but a fresh acknowledgement is required unless a
producer records proof that the changed observation still represents the
reviewed bytes. This capability does not manufacture that correspondence.

Receipts preserve the inspection producer's source provenance exactly as
recorded. Historical `sourceSnapshotAvailability: not_recorded` remains
`not_recorded` in an old receipt even when later producers record more evidence.
An acknowledgement asserts neither validation success, watchability,
damage-interval playback nor Keep. Failed-output integration is separate.

Damage Preview automatic-retention consumers require both an explicit receipt
and immutable normal-output source provenance. They must prove that the receipt
and exact generation match the preview's archive, checkpoint, concrete title,
path, angle, playback selection, applicable streams and versioned intended
settings, or a documented, proved equivalence. Current job or Disc Selection
state cannot supply missing proof. Missing or mismatched proof protects current
media, and failed-output receipts never release that protection. Active Catalog
Review independently protects current media. Archive-only decisions and explicit
deletion keep their separate rules. This receipt capability does not implement
retention cleanup or open new-format admission.

`encode-output export` copies that identity-bound canonical file to the path
on the machine running the CLI. The destination must not already exist. Success
returns one JSON document with the artifact identity and type, byte size,
destination, source identity, and provenance. Media bytes never go to stdout.
Missing, substituted, changed, or otherwise unsafe source files return a
nonzero status and a stable JSON reason with the current observed identity.
Export never substitutes a browser rendition or Damage Preview.

An initial `encode-enqueue` is deduplicated by Disc Selection and Encoding
Profile, including after completion. Use `encode-requeue` for a terminal job.
If another job reserves its output path, supply `--output-path` with a safe
path inside the configured media library when requeueing a failed or cancelled
job. Queue and detail results expose this as an alternate action requiring
`outputPath`. A completed job keeps its output path; a different `--output-path` is
rejected so the worker can apply its existing replacement checks. Requeueing a
completed job or a failed replacement first requires `encode-requeue-preview`.
Pass its `revision` with `--acknowledge`; a later job change returns
`STALE_ENCODE_PREVIEW`. Queue and detail actions list these required inputs and
the preview action. Running cancellation remains cooperative; the worker
settles it after observing the request. Malformed inputs return exit 2 with a
JSON error. Database or configuration failures return exit 1.

Notification administration is available through `rip-dvd notifications`. See
[Browser notifications](../../docs/notifications.md) for configuration and commands.

## Damage Preview availability

`rip-dvd damage-preview availability <archive-id>` discovers current saved
checkpoint, Title Identity and assessment identities, qualified intervals,
Encoding Profile versions and blocking reasons. It works before catalog mapping.
Generation remains unavailable and new-format archive admission remains closed.
Inspection never enqueues work, accepts damage or retains an ownership reservation.

Supply a selection with exactly one of `--json`, `--stdin`, or `--file` to review
the concrete input. This synthetic example uses placeholders returned by discovery:

```json
{
  "mode": "damage",
  "titleIdentityObservationId": "<observation-id>",
  "assessmentIdentity": "<current-assessment-id>",
  "playbackRange": { "startMilliseconds": 0, "endMilliseconds": 600000 },
  "intervalIndexes": [0, 1],
  "streams": { "audio": [1], "subtitles": [] },
  "encodingProfileId": "<profile-id>"
}
```

Interval indexes are zero-based within the selected title's current assessment.
A changed assessment returns `DAMAGE_PREVIEW_ASSESSMENT_STALE` and current
identities without substituting new intervals. The opaque `preflightToken`
binds the normalized input, durable checkpoint and manifest, exact title path,
angle and chapter bounds, assessment and timing evidence, streams, context,
and intended profile version and settings. It authorizes no work.

Individual markers remain in the response. Intervals with gaps of at most
30 seconds group together. Context defaults to five seconds on each side;
override it with `context.beforeMilliseconds` and `context.afterMilliseconds`.
Context clips only to `playbackRange`, overlapping clips count once, and no
clip-length cap applies. The range is an explicit operator selection, not a
claim about verified decoded coverage. Coarse whole-cell timing requires
`samplingWindow` with start and end milliseconds inside that range. The
response retains the full uncertain span alongside the planned sample.

With unknown timing, choose `mode: "ordinary_playback"` and an empty
`intervalIndexes` list. This offers an identifiable-title selection without
inventing a damage seek. Playback generation remains gated. Duration estimates
describe planned clip coverage. Storage remains unknown because the intended
preset settings do not provide a reliable byte rate; stream reproducibility
also requires verification before generation is enabled. Every inspection
returns all blocking reasons, and unavailable inspection succeeds with JSON
`available: false`. Malformed input returns exit 2.
