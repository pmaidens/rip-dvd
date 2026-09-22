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
