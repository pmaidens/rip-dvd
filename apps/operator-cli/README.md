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

# Disc Selection commands

Use an Original Disc Archive ID for every Disc Selection command. `show`
returns the current selection, catalog revision, available actions and blocking
reason, and associated Encode Jobs. `preview` takes a proposed action and the
same selection input as that action. It validates the proposal without saving
it and returns its effect, `catalogRevision`, and `previewToken`.

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
to an unused Media Item run directly. Updates that affect a referenced item,
its children, kind, or parent, and all deletes require a preview revision as
`--acknowledge`. Preview an update with the same changes you intend to submit;
quote the returned revision when passing it to the shell. A stale revision
returns `STALE_MEDIA_ITEM_REVISION`. A preview shows the proposed result,
eligibility, and the number of direct archive references or children affected. Catalog
hierarchy, TMDB uniqueness, and reference rules remain enforced during the
mutation. Validation and eligibility failures return JSON errors with stable
codes and exit status 2.
