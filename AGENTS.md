# Agent Instructions

## Public repository privacy

Keep this repository useful to any Rip DVD operator. Never put personal or
installation-specific information in tracked files or public GitHub content,
including issues, PR descriptions, comments, and attachments. This applies to
all file formats, test fixtures, generated artifacts, and commit messages.

- Keep archive inventories, disc/movie/episode lists, audit results, job and
  archive IDs or prefixes, fingerprints, exact incident measurements, and
  operational timelines private. Removing paths or shortening IDs does not
  make an installation report suitable for publication.
- Keep real hostnames, IP addresses, usernames, local paths, hardware serials,
  VM/storage topology, credentials, and deployed configuration private.
- Document reusable behavior and procedures with clearly synthetic examples
  and placeholders. Repository defaults, supported software versions, public
  project links, and technical error codes may remain when they describe the
  software rather than someone's installation.
- Keep raw logs, screenshots, database exports, and installation audit reports
  in the ignored `.local/private-docs/` directory or a private operator workspace
  outside the repository. Verify ignore rules with `git check-ignore` before
  writing local reports, and never force-add them. An instruction to
  investigate an instance does not authorize publishing its data. Report
  findings privately and extract only the general bug or requirement for
  repository documentation.
- Before committing or publishing, inspect every changed file and proposed
  public message for instance data, including copied tool output, links,
  filenames, and examples. Remove it or replace it with synthetic data before
  proceeding. Do not include removed private values in the cleanup summary.
- If private data is already committed, preserve it in ignored private storage,
  remove it from tracked files, and tell the user that earlier commits or
  public copies may still contain it.
  Coordinate any history rewrite separately; a deletion commit is not erasure.

## Agent skills

### Issue tracker

Issues and PRDs for this repo are tracked in GitHub Issues for `pmaidens/rip-dvd`; external PRs are not treated as a triage request surface by default. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage label vocabulary for this repo. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: use root `CONTEXT.md` and `docs/adr/` when they exist. See `docs/agents/domain.md`.
