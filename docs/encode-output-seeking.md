# Seeking into an Encode Output

The Encoding view lists Estimated Affected Playback intervals from the inspected
output's immutable source assessment. Checking an interval calls the existing
shared interval operation. Its `verified`, `absent` and `unknown` classifications
retain their evidence and reasons. A verified interval displays the measured
canonical output envelope and its start as the canonical seek target. An absent
or unknown interval offers ordinary playback without a targeted seek.

The JSON CLI uses the same query and results:

```sh
rip-dvd encode-output intervals <artifact-identity> --json '{"assessmentIdentity":"<assessment-identity>","titleIdentityObservationId":"<title-observation-identity>","intervalIndexes":[0],"renditionId":"00000000-0000-4000-8000-000000000001"}'
```

`renditionId` is optional. Without it, `viewing` is null. With it, `viewing`
reports a separate rendition media identity, machine-readable unavailable
reasons, and proved targets where available. Each target records its canonical
output interval, rendition interval and rendition `seekSeconds`. The canonical
classification does not change when rendition targeting is unavailable.

The existing correspondence producer owns chapter selection, playback path,
angle, time-base shifts, repeated or omitted content, and truncation. This
consumer preserves its qualified whole-cell envelope. A source timestamp,
percentage or Damage Preview cannot supply an output location. Incomplete
mapping and truncation remain unknown unless the producer proves otherwise.

## Rendition clock evidence

The worker records an optional `timeline` in the existing durable rendition
record. `browser-rendition-exact-video-v1` compares complete decoded video
sequences and pairs native timestamps on each container's normalized clock.
It records canonical and rendition byte digests and every corresponding frame
envelope. Reads are bounded by the existing exact-video measurement limits.
This evidence connects canonical output to rendition only. It does not create
source-to-output correspondence or change validation, publication or Keep.

Copied video can establish this proof, including copied video with converted
audio. Converted video, incomplete or unbounded measurements, unavailable
timestamps, changed bytes and historical records without clock evidence report
`RENDITION_TIMELINE_UNVERIFIED`. Equal durations are insufficient. Ordinary
rendition playback remains available under its existing contract.

A target requires the exact rendition's recorded source authority and file
revision, canonical digest, available measured media and matching frame bounds.
The browser repeats the query at the seek click and rejects changed evidence.
It uses the rendition target only when that position is currently seekable;
it never scales, clamps or substitutes the source estimate. Failed validation
stays visible during playback. Seeking records no inspection acknowledgement.

## Validation

Public CLI and HTTP tests use real persistence with authored synthetic mapping
and finalized rendition evidence. Clock tests replace only external decoder
responses. Worker tests cover persistence independently of source decisions.
The real-media gate additionally requires an actual remux clock and decoding
at its measured target. Rendition browser tests exercise authored verified,
absent, unknown and changed-at-click responses with real MP4 playback in stable
Chrome and mobile WebKit. These layers prove different claims.

Run the repository check, production build, ordinary browser suite, rendition
media and browser gates, and installed CLI smoke in a coordinated validation
slot. Current mobile Safari on a physical device must separately exercise the
seek control, ordinary playback for absent and unknown correspondence, failed
status, and rendition identity. Automated WebKit is an approximation; another
issue's Safari deferral does not complete this gate.
