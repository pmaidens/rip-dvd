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

Use an Original Disc Archive ID for every Disc Selection command. `show` and
`preview` take a Disc Selection ID and need no key. `preview` returns the
`catalogRevision`, the current selection, its available actions and blocking
reason, and Encode Jobs tied to it. Inspect this result before a repair,
correction, or deletion.

```sh
rip-dvd-operator disc-selection show <archive-id> <selection-id>
rip-dvd-operator disc-selection preview <archive-id> <selection-id>
rip-dvd-operator disc-selection create <archive-id> --key <key> \
  --media-item-id <media-item-id> --source-kind dvd_title --title-number 1
rip-dvd-operator disc-selection update <archive-id> <selection-id> --key <key> \
  --label "Main feature"
rip-dvd-operator disc-selection correct <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --acknowledge \
  --media-item-id <media-item-id> --source-kind main_feature
rip-dvd-operator disc-selection delete <archive-id> <selection-id> --key <key> \
  --revision <catalog-revision-from-preview> --acknowledge
```

`create`, `update`, `repair`, `correct`, and `delete` require a previously
chosen mutation key. Repeating an identical invocation returns its original
result. Reusing the key with different inputs fails. `update` with a new Media
Item or source, `repair`, `correct`, and `delete` also require the revision
returned by `preview` and the `--acknowledge` flag. A changed Catalog Review
revision rejects the decision.
The catalog enforces the same archive binding, source validation, and Encode
Job provenance rules as the web editor.

Use `--media-item-id`, `--source-kind`, `--title-number`, `--chapter-start`,
`--chapter-end`, and `--label` for ordinary input. `update` also accepts
`--clear-label`. Source kinds are `main_feature`, `dvd_title`, and
`dvd_chapters`. A correction may include `--reason`.

The same selection object can come from `--json '<object>'`, `--stdin`, or
`--file <path>`. A file is optional. For create, repair, and correct, provide
`mediaItemId` and `sourceIdentity`, with an optional `label`. For update,
provide at least one of `mediaItemId`, `sourceIdentity`, or `label`; set
`label` to `null` to clear it. The key, target IDs, preview revision, and
acknowledgement stay as command options for every input form.

```sh
rip-dvd-operator disc-selection create <archive-id> --key <key> \
  --json '{"mediaItemId":"<media-item-id>","sourceIdentity":{"kind":"dvd_title","titleNumber":1}}'
printf '%s\n' '{"label":"Featurette"}' |
  rip-dvd-operator disc-selection update <archive-id> <selection-id> --key <key> --stdin
```

Invalid selection input exits 2 with a JSON error. Database or storage
unavailability exits 1. No command prompts for input.
