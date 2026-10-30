# Browser Viewing Rendition conversion validation

The feature remains disabled by default. These are required release checks,
not a record that the checks have run. Keep execution logs, browser versions,
fixture manifests and device observations in ignored private operator storage.
Run the media, browser, build and installed-CLI gates only with a coordinated
validation slot and isolated synthetic storage.

## Focused behavior checks

Run the public CLI rendition, conversion and contract tests, the worker
rendition tests, the HTTP rendition admission/media tests and the browser-viewing
component tests. They cover durable review/request/inspect, replay and changed
selection conflicts, source races, failures without media, canonical independence,
retained failed-source status and authenticated full/HEAD/range behavior.

## Real media and browser matrix

`pnpm test:rendition-media` runs real FFmpeg/ffprobe conversion on Linux under the
inherited kernel execution lock. Cases include compatible remux, MPEG-2/AC-3
conversion, compatible video plus converted audio, 10-bit H.264 conversion,
omitted DVD bitmap and text subtitles, and each subtitle burned separately.
The synthetic bitmap fixture starts as a generated PGS rectangle and is encoded
to DVD subtitles. Text captions use generated SRT. Pixel checks compare black
frames before/after captions with the visible burned caption interval. Audio
must decode to nonzero samples, converted audio must be stereo while copied
mono audio stays mono, seeking must decode a frame, output codecs and duration
must match the plan, and canonical export must preserve source bytes.
An actual FFmpeg process failure must persist a stable conversion failure without
playable media.

Run `pnpm test:browser:renditions` separately for every row below. Each invocation
starts fresh isolated fixtures. The default case is `compatible`. Set
`RIP_DVD_RENDITION_BROWSER_VARIANT` and, for a burned case,
`RIP_DVD_RENDITION_BROWSER_BURN_SUBTITLE` in the invoking environment.

| Variant | Burn subtitle | Expected conversion | Subtitle result |
| --- | --- | --- | --- |
| `compatible` | unset | stream copy | none |
| `incompatible` | unset | H.264 and AAC | none |
| `audio_conversion` | unset | AAC, copied H.264 | none |
| `video_format` | unset | H.264, copied AAC | none |
| `subtitles` | unset | H.264 and AAC | DVD bitmap and text omitted |
| `subtitles` | `2` | H.264 and AAC | English DVD bitmap burned, French text omitted |
| `subtitles` | `3` | H.264 and AAC | French text burned, English DVD bitmap omitted |

Each row exercises stable installed desktop Chrome and the mobile WebKit
approximation with actual video and non-silent audio, seek, caption pixels,
conversion labels, failed-source prominence, unauthorized range denial, 416
responses and browser media failure. The omitted-subtitle row also uses the web
selector to request a separate burned rendition with its own durable identity.
For example:

```sh
RIP_DVD_RENDITION_BROWSER_VARIANT=subtitles \
RIP_DVD_RENDITION_BROWSER_BURN_SUBTITLE=2 pnpm test:browser:renditions
```

External browser mode uses the matching variant and burn settings plus
`RIP_DVD_RENDITION_BROWSER_BASE_URL`, `RIP_DVD_RENDITION_BROWSER_FIXTURE` and
`RIP_DVD_RENDITION_BROWSER_GATE=true`. Prepare that row's fixture on Linux first.
A manifest for another row is rejected. Keep the matching synthetic server and
fault proxy available throughout the check.

## Current mobile Safari on a physical device

Mobile WebKit automation does not complete the Safari gate. Record the current
iOS/Safari versions and device observation for every matrix row. Open the
isolated synthetic server over operator-configured HTTPS, sign in through
`/viewing-access`, inspect its safely retained failed output in Encoding, check
the source/conversion/audio/subtitle labels and create or restore its rendition.
Tap Play with audio enabled. Listen for the tone, seek to the middle and verify
that captions appear only for the chosen burn and clear afterwards. Confirm the
failed-source warning remains after reload and a media failure. Use the isolated
fault proxy to inject 416 responses; verify playback reports failure, then
restore serving. A fresh unsigned-in session must receive 401 for full and range
media access. Never record this gate as passed from an emulated browser or from
another issue's physical-device deferral.

## Build and installed executable

Run `pnpm check`, `pnpm build`, `pnpm test:browser` and the matrix above in the
coordinated slot. Run `pnpm test:operator-cli-deployment` against fresh synthetic
storage. Its installed wrapper now requests/inspects/replays compatible remux,
incompatible conversion, omitted text subtitles and a separate selected burned
rendition. Those requests prove installed CLI admission and persistence; the real
media and browser gates separately prove generated playback. Do not enable
production admission or deploy as part of these checks.

## Damage Preview rendition gate

The preview operations and shared contracts are documented in
`docs/damage-preview-browser-viewing.md`. Run the focused preview public CLI,
HTTP, worker and player tests first. They include stale admission, retained
partial/interrupted/failed samples, conversion failure, missing media, deletion
revocation, durable replay and per-request authorization and range checks.

`pnpm test:preview-rendition-media` runs the real preview FFmpeg gate separately.
It proves stream copy and incompatible/audio conversion, omitted and individually
burned bitmap/text subtitles, nonzero decoded audio, decoded seeks near the end,
canonical byte-preserving export, partial/outdated provenance and a 130-second
sample without truncation. A real failed encoder must produce no playable media.

After the production build, run `sh scripts/check-preview-rendition-browsers.sh`
in the coordinated validation slot. It runs stable installed Chrome and mobile
WebKit automation sequentially for these rows:

| Sample case | Source variant | Burn subtitle |
| --- | --- | --- |
| complete | compatible | none |
| complete | incompatible | none |
| complete | audio_conversion | none |
| complete | video_format | none |
| complete | subtitles | none, 2 and 3 as separate runs |
| partial | incompatible | none |
| stale | incompatible | none |
| longclip | compatible, 130 seconds | none |
| missing | compatible, derived file absent | none |
| conversion_failure | incompatible, actual failed encoder | none |

Each run keeps a separate ignored fixture directory, manifest and traces. It
refuses to overwrite an existing fixture. A single row can be run with
`RIP_DVD_PREVIEW_BROWSER_RUN=synthetic-review-1`,
`RIP_DVD_PREVIEW_BROWSER_CASE`, `RIP_DVD_PREVIEW_BROWSER_VARIANT`, and optionally
`RIP_DVD_PREVIEW_BROWSER_BURN_SUBTITLE`, followed by
`pnpm test:browser:preview-renditions`. External server mode uses matching settings
plus `RIP_DVD_PREVIEW_BROWSER_BASE_URL` and
`RIP_DVD_PREVIEW_BROWSER_FIXTURE`. The manifest must match the exact row.

For each row on current mobile Safari on a physical device, use the isolated
synthetic HTTPS server and open Catalog Review, Damage decision, then inspect the
manifest's preview request. Sign in through `/viewing-access`. Verify revision,
coverage and canonical MKV relationship. For playable cases, listen to audio,
seek near the end, confirm the partial/outdated labels remain beside playback,
and check the selected subtitle appears and clears at its cue. Confirm the
long clip seeks beyond two minutes. Inject the authenticated synthetic fault
proxy's 416 response and confirm the playback error preserves sample conditions.
For missing/conversion-failure rows, confirm explicit unavailability and no
playable media. In a fresh unsigned-in session, check that creation, inspection,
full media, HEAD and each range request are unauthorized. Record the actual iOS,
Safari and Chrome versions and results privately. WebKit automation and earlier
issues' physical-device deferrals do not satisfy this gate.

Also run `pnpm check`, `pnpm build`, `pnpm test:browser` and
`pnpm test:operator-cli-deployment`. The installed wrapper now reviews, requests,
inspects and replays a canonical preview rendition before canonical export and
deletion. These commands do not enable production admission or deploy anything.
