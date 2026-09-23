# Archive Request commands

Every preservation mutation requires a key chosen before submission. A normal
Archive Request targets a Detected Disc. A Re-archive Request targets the exact
Original Disc Archive that should remain as its predecessor.

```sh
rip-dvd-operator submit-archive-request --key <key> --detected-disc-id <id>
rip-dvd-operator request-rearchive --key <key> --source-archive-id <id>
```

`request-rearchive` creates fresh request-owned copy state and returns the new
Archive Request ID, lineage target, and current waiting reason. Use `inspect
archive-requests <request-id>` or `wait archive-requests <request-id>` to follow
it. Retrying a failed request continues that same request and rescue state. It
does not create a fresh generation. The prior archive and its catalog history
remain unchanged when the request succeeds, fails, or is cancelled.

# Catalog Review read commands

Run the server-local `rip-dvd-operator` executable with the same database and
library configuration as the application. Commands write one JSON result to
stdout. Invalid input exits 2; an unavailable read exits 1.

```sh
rip-dvd-operator catalog-review show <archive-id>
rip-dvd-operator catalog-review suggest <archive-id>
rip-dvd-operator catalog-review suggest <archive-id> --tmdb-id 42 --media-type movie
```

`show` returns the current catalog revision, archive and scan provenance,
coverage, Media Items, Disc Selections with structured action availability,
correction history, and corrected Encode Job and retained-output history.
`reviewActionAvailability` reports whether completion with selections or
Archive-only completion is currently allowed, with a reason when blocked.
Each paginated section includes its offset, limit, and next/previous flags.
Use `--selection-offset`, `--correction-offset`, `--correction-job-offset`,
`--correction-output-offset`, `--replacement-offset`, and
`--replacement-profile-offset` to read later pages. Offsets start at zero.

`suggest` returns a proposal or a `needs_review` reason. When TMDB search
succeeds, `candidates` contains the returned movie and TV matches, even if
the proposed match is uncertain or absent. A selected TMDB identity must be
present in the current search results. The lookup does not change the catalog;
accept a proposal through a catalog mutation workflow with its revision.

Both commands return `REVIEW_NOT_FOUND` for an unknown archive ID.
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
rip-dvd-operator catalog-review preview-rearchive-proposal <fresh-archive-id> \
  --file <preview.json>
rip-dvd-operator catalog-review save-rearchive-proposal <fresh-archive-id> \
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

Save a ready Re-archive Mapping Proposal first. Preview acceptance with the
proposal revisions and an empty replacement plan:

```json
{
  "action": "accept_rearchive",
  "catalogRevision": "2026-01-02T00:00:00.000Z",
  "sourceCatalogRevision": "2026-01-01T00:00:00.000Z",
  "replacementEncodes": []
}
```

```sh
rip-dvd-operator catalog-review preview-rearchive-acceptance <fresh-archive-id> \
  --file <acceptance.json>
rip-dvd-operator catalog-review accept-rearchive <fresh-archive-id> \
  --key <key> --revision <catalog-revision> \
  --source-revision <source-catalog-revision> \
  --preview-token <preview-token> --acknowledge --file <acceptance.json>
```

The preview lists queued and running jobs that use the prior archive. Acceptance
adopts the saved mappings on the fresh archive, stops later enqueue from the
prior selections, and cancels queued jobs or requests cooperative cancellation
of running jobs. It keeps both archives, completed outputs, historical mappings,
and job provenance. Replacement encodes are not supported by this operation;
any non-empty replacement plan is rejected.

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
Catalog Review open.

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
rip-dvd-operator catalog-review apply-proposal <archive-id> --key <key> \
  --json '<proposal-json>'
printf '%s\n' '<proposal-json>' | \
  rip-dvd-operator catalog-review apply-proposal <archive-id> --key <key> --stdin
rip-dvd-operator catalog-review apply-proposal <archive-id> --key <key> \
  --file <proposal.json>
```

The command writes one JSON result and exits 0 on success. Invalid JSON or
proposal shape exits 2 with `INVALID_ARGUMENTS` or `INVALID_PROPOSAL`.
Rejected members, stale revisions, and key conflicts exit 2 with
`PROPOSAL_REJECTED`, `STALE_CATALOG_REVISION`, or `MUTATION_KEY_CONFLICT`.
Database unavailability exits 1 with `PROPOSAL_UNAVAILABLE`.

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

Use `outcome: "archive_only"` only when the review has no Disc Selections, and
leave `replacementEncodes` empty for that outcome. Preview validates the whole
plan, resolves output paths inside the configured media library, reports
selected and omitted replacements plus the exact failed predecessor output
reservations it will release, and returns an opaque `previewToken` bound to the
exact plan and catalog revision.

```sh
rip-dvd-operator catalog-review preview-completion <archive-id> \
  --file <completion.json>
rip-dvd-operator catalog-review complete <archive-id> \
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
rip-dvd-operator disc-selection show <archive-id> <selection-id>
rip-dvd-operator disc-selection create <archive-id> --key <key> \
  --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
rip-dvd-operator disc-selection update <archive-id> <selection-id> --key <key> \
  --label "Main feature"
rip-dvd-operator disc-selection preview correct <archive-id> <selection-id> \
  --media-item-id <media-item-id> --source-kind main_feature
rip-dvd-operator disc-selection correct <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --preview-token <token-from-preview> \
  --acknowledge --media-item-id <media-item-id> --source-kind main_feature
rip-dvd-operator disc-selection preview delete <archive-id> <selection-id>
rip-dvd-operator disc-selection delete <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --preview-token <token-from-preview> \
  --acknowledge
rip-dvd-operator disc-selection preview repair <archive-id> <selection-id> \
  --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
rip-dvd-operator disc-selection repair <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --preview-token <token-from-preview> \
  --acknowledge --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
```

`create`, `update`, `repair`, `correct`, and `delete` require a previously
chosen mutation key. Repeating an identical invocation returns its original
result. Reusing the key with different inputs fails. An `update` that changes
the Media Item or source, plus every `repair`, `correct`, and `delete`, requires
an action-specific preview. Pass the returned revision and token with
`--acknowledge`. A changed Catalog Review revision or different proposal
rejects the decision. Label-only updates execute directly. The catalog uses
the same archive binding, source validation, and Encode Job provenance rules
as the web editor.
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
rip-dvd-operator disc-selection create <archive-id> --key <key> \
  --json '{"mediaItemId":"<media-item-id>","sourceIdentity":{"kind":"dvd_title","titleNumber":1}}'
printf '%s\n' '{"label":"Featurette"}' |
  rip-dvd-operator disc-selection update <archive-id> <selection-id> --key <key> --stdin
```

Invalid selection input exits 2 with a JSON error. Database or storage
unavailability exits 1. No command prompts for input.
# Media Item commands

Use `media-item search` to find Media Items throughout the catalog. `show`
returns the selected item's TMDB identity, revision, and maintenance state.
Search results include ancestors and the number of referencing archives.

```sh
rip-dvd-operator media-item search --query 'Example Film' --offset 0
rip-dvd-operator media-item show <media-item-id>
rip-dvd-operator media-item create --key <invocation-key> --kind movie --title 'Example Film' --year 2024
rip-dvd-operator media-item create --key <invocation-key> --kind tv_show --title 'Example Show' --tmdb-type tv_show --tmdb-id 42
rip-dvd-operator media-item preview update <media-item-id> --title 'Corrected Film'
rip-dvd-operator media-item update <media-item-id> --key <invocation-key> --acknowledge '<preview-revision>' --title 'Corrected Film'
rip-dvd-operator media-item preview delete <media-item-id>
rip-dvd-operator media-item delete <media-item-id> --key <invocation-key> --acknowledge '<preview-revision>'
```

Create and update also accept `--json '<object>'`, `--json -` for stdin, or
`--file <path>`. The object contains Media Item fields directly. Create
requires `kind` and `title`; optional fields are `parentId`, `year`,
`seasonNumber`, `episodeNumber`, and `tmdbIdentity` with `mediaType` and
`tmdbId`. Update accepts the editable fields except `tmdbIdentity`. For
example, an episode can be created with:

```sh
printf '%s\n' '{"kind":"episode","title":"Pilot","parentId":"<season-id>","episodeNumber":1}' |
  rip-dvd-operator media-item create --key <invocation-key> --json -
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
one with `rip-dvd-operator generate-key` and keep it for retries. The same key
and inputs return the original result after a lost response or later status
change. A key reused with different inputs returns `MUTATION_KEY_CONFLICT`.
Each successful mutation returns `job.id` and `work: { kind: "encode-jobs", id }`.

```sh
rip-dvd-operator encode-queue --encoding-profile-id <profile-id>
rip-dvd-operator encode-resolve --encoding-profile-id <profile-id> --disc-selection-id <selection-id>
rip-dvd-operator encode-enqueue --key <key> --disc-selection-id <selection-id> --encoding-profile-id <profile-id> --output-path /media/movies/example.mkv
rip-dvd-operator encode-cancel --key <key> --encode-job-id <job-id>
rip-dvd-operator encode-requeue --key <new-key> --encode-job-id <job-id>
rip-dvd-operator encode-requeue-preview --encode-job-id <completed-job-id>
rip-dvd-operator encode-requeue --key <new-key> --encode-job-id <completed-job-id> --revision <preview-revision> --acknowledge
```

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
