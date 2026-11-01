# Subtitle validation and retained failed outputs

HandBrake 1.9.2 logs `Forced Only` for subtitle packet filtering. This is
independent of Matroska's forced disposition. With at most one default-marked
passthrough subtitle, its muxer sets both default and forced disposition bits
from the logged `Default` setting. The validator rejects ambiguous multiple
defaults, including defaults on text selections.

Attempt-local provenance records this filter as `forcedOnly`. The final
sanitized Encoding Pass supplies output order and source track identity.
A non-filtered search selection preserves a complete source, including when
HandBrake clears the filter after finding no forced hits. A filtered selection
preserves a complete source only when positive forced hits equal total hits.
A partial search result is additional and cannot replace its complete source.
Source count, language and title checks apply before empty-stream cleanup.
Cleanup needs a successful complete packet-count probe, preserves retained
container flags, and validates the remux against the original source mapping
after indexes change.

The pinned behavior is in HandBrake's
[scan and sanitization](https://github.com/HandBrake/HandBrake/blob/1.9.2/libhb/work.c#L900-L1059),
[default selection](https://github.com/HandBrake/HandBrake/blob/1.9.2/libhb/muxavformat.c#L784-L803)
and [container flags](https://github.com/HandBrake/HandBrake/blob/1.9.2/libhb/muxavformat.c#L971-L978).
Changing subtitle selection or burning policy is separate work.

## Review a retained validation failure

Use supported inspection to find a complete `validation_failed` artifact and
review its recorded failure, source claim, file identity and available checks.
Historical quarantined files without artifact authority are not interchangeable
with these artifacts. Use placeholders below for the identities returned by
inspection.

```sh
rip-dvd inspect encode-jobs <encode-job-id>
rip-dvd encode-output inspect encode-output-v1.failed.<failed-output-id>
rip-dvd encode-output export encode-output-v1.failed.<failed-output-id> --destination /exports/synthetic-baseline.mkv
cp /exports/synthetic-baseline.mkv /exports/synthetic-working.mkv
```

Preserve the exact exported baseline and its export metadata. Run any validator
that may remux empty streams only against the separate working copy. Never
point it at the retained canonical artifact or overwrite the exported baseline.
Byte hashes can confirm the baseline stays unchanged. Recheck stream indexes
and dispositions after any diagnostic remux.

Independent checks remain useful without historical attempt-bound mappings.
Real ffprobe can report duration, codecs, languages, titles, container flags,
packet counts and first packet timestamps. Real ffmpeg can check bounded or
full decoding. Compare duration with a trustworthy selection-specific target
when one exists. These observations describe the exported bytes, but cannot
prove which source subtitle or audio stream each output contains. Matching
counts, languages or names alone do not prove complete source coverage.

The current catalog and a fresh diagnostic HandBrake run cannot establish the
historical attempt's sanitized subtitle order, search statistics, source reuse,
or audio output mapping. A fresh run supplies evidence for its own bytes only.
Do not manufacture historical provenance from that run, infer it from container
flags, or call a validator without the required mappings and treat its narrower
checks as complete validation. Normal worker attempts capture the mappings
before validating and publishing their own Encode Output.

When historical mappings are unavailable, a fresh Encode Job is required for
complete validation and normal publication. Use the supported requeue workflow
with the intended source selection and Encoding Profile. This correction adds
no revalidate-and-promote operation. Inspection and inspection acknowledgement
record review only. Explicit Keep records a separate decision to retain the
reviewed validation-failed artifact; it does not pass validation, complete its
failed job, or promote it to a normal published output.

## Regression gates

Run `pnpm check` with the supported Node and pnpm versions. Focused coverage
lives in the encode worker's provenance parser, output validator, worker and
repairer tests. Run `pnpm test:subtitle-media` separately in an environment with
HandBrake 1.9.2, ffmpeg and ffprobe, such as the pinned encode-worker runtime
with test dependencies. It generates only synthetic bitmap subtitles and
checks actual scan hits, candidate selection, sanitized mapping and Matroska
validation for no-forced-hits reuse, all-forced reuse and partial search without
default. The regular test suite skips this gate unless explicitly enabled;
a skipped test is not a native gate pass.
