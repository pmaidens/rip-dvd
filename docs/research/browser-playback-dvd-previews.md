# Browser playback for DVD preview artifacts

- Status: research only; browser validation pending
- Date: 2026-09-27
- Question: Can the web app play a Damage Preview and the actual Encode Output in current stable Google Chrome and mobile Safari while keeping the preview materially close to the intended output?

## Finding

The app can target both browsers with an MP4 viewing rendition containing H.264 video and AAC audio. Apple recommends H.264 MP4 for static Safari video; Chromium lists MP4, H.264, and AAC support in Google Chrome. Codec support still depends on the actual profile, device, and file, so the produced artifacts need testing on the supported stable browsers ([Apple Safari delivery guidance](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari), [Chromium media formats](https://www.chromium.org/audio-video/)).

Chromium also lists Matroska as a supported container, so direct MKV playback in Chrome is worth testing. Apple's Safari guidance does not establish mobile Safari MKV playback. Changing HTML or the MIME type cannot make a native video element decode unsupported content. A browser rendition is the dependable route across both targets ([Chromium media formats](https://www.chromium.org/audio-video/), [Apple Safari delivery guidance](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)).

## Current repository output

The encode worker passes the selected HandBrake preset, forces Matroska with `--format av_mkv`, and retains DVD subtitles with `--all-subtitles --subtitle-burned=none` ([encode worker](../../apps/encode-worker/src/publication-recovery.ts)). Encoding profiles require MKV but accept different HandBrake presets ([profile validation](../../packages/data-access/src/encoding-profile-eligibility.ts), [preset list](../../packages/config/src/handbrake-presets.ts)). HandBrake's Fast 480p30 preset uses H.264 and AAC stereo; other presets can select other codecs and audio layouts ([HandBrake 1.9 official presets](https://handbrake.fr/docs/en/1.9.0/technical/official-presets.html)). Probe the finished stream rather than assuming its codecs from the preset name.

DVD VobSub is the key mismatch. HandBrake says MKV can retain multiple soft VobSub tracks, while MP4 cannot retain them through its output path. The proposed MP4 remux preserves selected video and audio packets but omits the canonical MKV's VobSub subtitle tracks ([HandBrake subtitles](https://handbrake.fr/docs/en/latest/advanced/subtitles.html)).

## Conversion rule

Keep the MKV as the canonical preview or finished output. Probe its video, audio, subtitle, and timing properties before selecting a browser rendition; FFprobe supports structured stream inspection ([ffprobe manual](https://ffmpeg.org/ffprobe.html)).

| Canonical streams | Browser rendition | Fidelity label |
| --- | --- | --- |
| Suitable H.264 video and AAC audio | Stream-copy selected video and AAC into MP4; omit VobSub | Same compressed picture and selected sound; subtitle and other audio tracks omitted |
| Suitable H.264, no suitable AAC | Copy video and encode an AAC viewing track | Same compressed picture; sound converted; subtitles omitted |
| Video or profile unverified on both targets | Encode H.264/AAC MP4 viewing copy | Picture and sound converted; differences near damage possible |
| Conversion or playback fails | Offer canonical MKV export | Browser inspection unavailable |

FFmpeg stream copy performs no decode or re-encode and therefore avoids generation loss, though a mux can fail when the destination container lacks required information. Use explicit stream mapping, probe the MP4, and test playback. For progressive download of a completed MP4, FFmpeg's `-movflags +faststart` places its index at the front ([FFmpeg stream copy and mapping](https://ffmpeg.org/ffmpeg.html), [FFmpeg MP4 muxer](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)).

The subtitle choice needs an explicit product rule. A clear default is to label the MP4 "subtitles omitted" and provide the canonical MKV for inspection. If the operator needs one DVD subtitle track in the browser, burn that track into a separate H.264/AAC rendition, naming the selected track and the video transcode. Burning changes picture pixels and exposes only one track; it cannot verify the canonical soft subtitles. Turning VobSub into text would require OCR or transcription, not a lossless remux ([HandBrake subtitles](https://handbrake.fr/docs/en/latest/advanced/subtitles.html)).

## Preview fidelity

Make the canonical Damage Preview with the same concrete title, angle or playback path, selected streams, HandBrake version, preset revision, filters, and subtitle policy intended for the full encode. Record the archive revision and source interval. This is still a separate short encode: HandBrake does not guarantee frame-exact point-to-point boundaries. The finished Encode Output is the final check of what was published ([HandBrake point-to-point encoding](https://handbrake.fr/docs/en/latest/advanced/point-to-point.html)).

The player must name the artifact it shows: canonical MKV, stream-copy MP4, or transcoded MP4. State which audio track is present and whether subtitles were omitted or burned. Do not call a converted viewing rendition the actual output or infer the canonical file's subtitle or damage behavior solely from it.

## Web delivery

Serve the completed MP4 from an authenticated route with `Content-Type: video/mp4`. Support byte-range GETs with correct 206, `Content-Range`, `Content-Length`, and `Accept-Ranges: bytes`; use 416 for an unsatisfiable range. Apple says iOS uses byte ranges for random access. HTTP defines these response rules ([Apple iOS media server guidance](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/CreatingVideoforSafarioniPhone/CreatingVideoforSafarioniPhone.html), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)). Reauthorize seeks and avoid long-lived tokens in URLs.

Start with native `<video controls playsinline>`. Safari documents `playsinline` for iPhone playback in the page and restrictions on autoplay with sound. Static MP4 and byte ranges meet this initial use case; HLS can be evaluated if adaptive delivery is later needed ([Apple Safari delivery guidance](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)). The HTML `canPlayType()` result is only a confidence hint; handle actual load and playback errors and offer export ([HTML media standard](https://html.spec.whatwg.org/multipage/media.html#dom-navigator-canplaytype-dev)).

## Acceptance matrix

Test on the then-current stable Google Chrome and mobile Safari. Record browser, OS, and device versions. Use synthetic clips only. Include H.264/AAC with VobSub, surround audio with an AAC stereo track, a case needing audio conversion, and a case needing video conversion. Include both a short visible corruption and a long sample with multiple markers.

For each applicable rendition, check start, sound, pause, repeated seeking near damage, end of clip, iPhone inline and full-screen modes, rotation, interrupted download, and retry. Inspect first and seek requests for correct range responses and authorization after session expiry. Compare stream-copy video and audio timing with the canonical artifact; compare transcoded picture and sound around damage. Verify the player labels omitted or burned subtitles and never identifies a viewing copy as the canonical output.
