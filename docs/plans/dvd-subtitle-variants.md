# DVD subtitle variant validation

## Problem and requirements

A stored schemaVersion 2 Disc Inspection can describe one subtitle declaration
that HandBrake expands into multiple physical VobSub streams, such as widescreen
and letterbox variants. Comparing output streams directly with declaration
counts can therefore reject a valid encode, independently of Archive Integrity.

This repair must derive expectations that match HandBrake's DVD display
variants for explicit title and chapter selections, including existing
Original Disc Archives. It must preserve exact source-track count and metadata
validation, the separate foreign-audio-search allowance, and the Original Disc
Archives.
Arbitrary extra or missing streams must still fail. Regression coverage must
exercise the Encode Job caller and output validator together. Missing or
invalid source evidence must prevent publication.

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
widescreen and letterbox subtitle case, with a synthetic title number and no
media paths or payloads. Regular tests simulate the HandBrake and media-tool
process boundaries; they do not decode real DVD media.

Main-feature resolved-title provenance remains tracked in
[#246](https://github.com/pmaidens/rip-dvd/issues/246). Existing completed-output
backfill remains tracked in [#249](https://github.com/pmaidens/rip-dvd/issues/249).
Neither is included in this repair.
