# Empty DVD subtitle validation

DVD bonus titles can declare VobSub tracks without containing subtitle packets.
On September 7, 2026, a full trailer encode reproduced this with one ordinary
English track. ffprobe identified that track in its completed packet-count probe
but omitted `nb_read_packets`. Cleanup removed the track, then validation failed
with `expected 1 source VobSub stream, found 0` because the original expectation
still included it.

The validator now checks the complete source count, language, title and
dispositions before cleanup. Only after a successful full packet-count probe
may it exclude expectations matched to zero-packet source tracks. It matches
expectations by source position and filters using the original stream indexes,
so remux index changes do not affect the remaining expectations. It probes and
validates the cleaned output again before publication.

An omitted packet count is accepted as zero only when the probe includes the
identified VobSub stream. Missing streams, duplicate or unexpected indexes,
malformed counts and probe errors still fail. Foreign-audio-search tracks remain
separate from source expectations. Removing an empty search track does not
remove a source expectation.

Worker regression tests run the real scanner and validator through worker
polling, with simulated HandBrake and media-tool results. They cover one empty
trailer track, all-empty and mixed DVD variants, foreign-audio-search tracks,
and strict count and language failures. Validator tests additionally cover
named tracks, malformed packet evidence and count or metadata damage during
cleanup, including renumbered streams.

No migration or metadata refresh is required. Expectations remain local to the
encode attempt, and the caller's expectation array is unchanged. These tests do
not decode real DVD media. Deployment and live-job retries are separate work.
