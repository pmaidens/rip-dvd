# DVD subtitle variant validation

## Problem and requirements

The reported failure is `expected 1 source VobSub stream, found 2` after
encoding an explicit DVD title. The stored schemaVersion 2 Disc Inspection
describes one English subtitle declaration. HandBrake reads two physical
VobSub streams for that declaration, one widescreen and one letterbox. Both
streams have ordinary, non-default, non-forced dispositions. The Original Disc
Archives record `clean_read` Archive Integrity.

This repair must derive expectations that match HandBrake's DVD display
variants for explicit title and chapter selections, including existing
Original Disc Archives. It must preserve exact source-track count and metadata
validation, the separate foreign-audio-search allowance, and the Original Disc
Archives.
Arbitrary extra or missing streams must still fail. Regression coverage must
exercise the Encode Job caller and output validator together. Missing or
invalid source evidence must prevent publication.

Explain metadata compatibility and any refresh or migration needed. Deliver
tested changes through a PR after the Standards and Spec review cycle, using
`233cfb81bf4bc677ec09d1fcdab9d3716262b644` as the fixed baseline. Deployment
and modifying live jobs are outside this request. A later delivery instruction
authorized merging the reviewed change through the repository's normal PR
workflow and synchronizing local `main`.

## Implementation plan

1. Reproduce the failure through worker polling with one stored subtitle and
   two ordinary VobSub output streams.
2. Before encoding an explicit title or chapter range, scan that title from
   the Original Disc Archive using the packaged HandBrake and `--no-dvdnav`.
   Bound the scan time and output size. Read its JSON subtitle list in order,
   retaining each VobSub variant's language and optional track name.
3. Supply those expectations to the existing output validator. Preserve the
   stored full-title duration check and the chapter-range duration exemption.
4. Test variants, strict rejection, malformed scans, cancellation, and legacy
   metadata. Run repository checks and the review and repair loop.

## Compatibility and operations

No database migration, scan-data backfill, or Disc Inspection refresh is
needed. Every new attempt reads subtitle expectations from its archive.
Stored scan data remains the evidence for disc identity, catalog mapping,
and duration. The new scan supplies attempt-local subtitle evidence only;
it does not overwrite the Detected Disc or archive metadata.

After deployment, failed jobs can use the existing retry workflow. They
re-encode from the archive and validate before publishing. This change does
not adopt previously failed partial outputs or replace completed outputs
automatically. The extra title scan reads only the archive and adds bounded
preparation work before each explicit-title encode.

The scan has a two-minute timeout and a 4 MiB limit per output pipe. Failed,
incomplete, or malformed scans stop the job during preparation. They never
fall back to the stored declaration count. The regression fixture keeps the
reported English widescreen and letterbox subtitle fields, with a synthetic
title number and no media paths or payloads. Regular tests simulate the
HandBrake and media-tool process boundaries; they do not decode the episodes.

Main-feature resolved-title provenance remains tracked in
[#246](https://github.com/pmaidens/rip-dvd/issues/246). Existing completed-output
backfill remains tracked in [#249](https://github.com/pmaidens/rip-dvd/issues/249).
Neither is included in this repair.
