# DVD subtitles for Jellyfin

- **Status:** core implementation complete; deferred work linked below
- **Date:** 2026-08-24
- **Scope:** DVD ISO Original Disc Archives encoded by the current HandBrakeCLI worker into MKV
- **Decision:** pin HandBrake 1.8.0 or newer, keep every DVD subtitle as a soft VobSub track in the MKV, and keep HandBrake's foreign-audio search as a separate soft forced/default track when it finds one

## Recommendation

Add these arguments to every DVD Encode Job after the selected preset:

```text
--all-subtitles
--subtitle-burned=none
```

Upgrade and pin the encode-worker's HandBrakeCLI to at least 1.8.0 before treating this as reliable. HandBrake 1.8.0 fixed VobSub passthrough when a track contains empty or fully transparent samples, fixed subtitle setting overrides, and fixed `scan` when it is not first in an explicit subtitle list ([official 1.8.0 notes](https://github.com/HandBrake/HandBrake/releases/tag/1.8.0)). At research time, the Bookworm image installed 1.6.1, so adding the flags without upgrading would have retained known bugs in the exact path this feature needs. The implementation pins and checks 1.9.2 in an encode-worker-specific runtime.

A live `--preset-export` check against the then-current 1.6.1 encode worker confirmed the intended setting transformation. `Fast 480p30` starts with subtitle selection `none`, foreign-audio search enabled, burn behavior `foreign`, and DVDSub burn enabled. Adding `--all-subtitles --subtitle-burned=none` changes selection to `all`, burn behavior to `none`, and DVDSub burn to false while retaining foreign-audio search. This proves the command override, but it does not cover the VobSub payload defect fixed in 1.8.0.

Keep `--format av_mkv`. Do not restrict `--subtitle-lang-list` for the preservation-derived output. That would discard tracks before Jellyfin ever sees them.

This is the smallest change that fits the current pipeline. `--all-subtitles` selects every source subtitle language when no language list is supplied. `--subtitle-burned=none` overrides a preset's burn rule, including its DVD bitmap burn flag. Both behaviors are explicit in the [HandBrake 1.6 command reference](https://handbrake.fr/docs/en/1.6.0/cli/command-line-reference.html#subtitles-options) and in the [1.6.1 CLI implementation](https://github.com/HandBrake/HandBrake/blob/1.6.1/test/test.c#L3772-L3815).

Do not use `--subtitle-forced` on all the tracks. That option filters a selected stream down to subtitle events whose DVD forced bit is set. It does not mean "preserve this track and mark it forced." HandBrake documents the filter behavior in the [CLI reference](https://handbrake.fr/docs/en/1.6.0/cli/command-line-reference.html#subtitles-options).

Do not use `--subtitle-default=none` as a substitute for `--subtitle-burned=none`. The former controls which soft track starts automatically; it does not stop burning. It is reasonable as a later policy choice if the product should never auto-select full subtitles, but the forced-dialogue case must remain covered by an actual forced track.

## Why the pre-implementation command lost selectable subtitles

Before this implementation, the Encode Job built this shape of command and supplied no subtitle overrides:

```text
<title selection> -i <archive.iso> -o <partial.mkv>
--format av_mkv --preset <configured preset>
```

See [`publication-recovery.ts`](../../apps/encode-worker/src/publication-recovery.ts) and its exact command assertion in [`encode-worker.test.ts`](../../apps/encode-worker/src/encode-worker.test.ts).

The default repo profile is `Fast 480p30`. HandBrake 1.6.1 defines that preset with `SubtitleTrackSelectionBehavior: "none"`, `SubtitleAddForeignAudioSearch: true`, and DVD bitmap burning enabled. The former pipeline overrode the preset's MP4 container with MKV, but it did not override those subtitle rules. The result was no selectable full subtitle tracks and, when the foreign-audio scan found a match, a subtitle burned into the video. See the [official 1.6.1 preset definition](https://github.com/HandBrake/HandBrake/blob/1.6.1/preset/preset_builtin.json#L1283-L1295).

With burning disabled, HandBrake 1.6.1 changes the foreign-audio search result into a soft track and marks it default and forced. Its preset builder says this directly: if the search track is not burned, it sets `Default` and always sets `Forced` ([source](https://github.com/HandBrake/HandBrake/blob/1.6.1/libhb/preset.c#L1148-L1158)). The muxer writes the selected default subtitle's default disposition and also writes a forced disposition when the same internal `default_track` flag is set ([source](https://github.com/HandBrake/HandBrake/blob/1.6.1/libhb/muxavformat.c#L1102-L1109)). The normal source tracks remain selectable alongside it. This coupling is another behavior the output probe must pin before and after a HandBrake upgrade.

This behavior needs a fixture test even after the upgrade. The implementation therefore checks the Debian `handbrake-cli` package version both while building the image and when the encode worker starts.

## What the output format should be

DVD subtitles are bitmap subpictures, not text. HandBrake reads them as VobSub and identifies the codec as `AV_CODEC_ID_DVD_SUBTITLE`; it also reads the DVD palette and 90 kHz time base ([HandBrake 1.6.1 DVD reader](https://github.com/HandBrake/HandBrake/blob/1.6.1/libhb/dvd.c#L178-L214)). OCR is therefore not part of a faithful extraction.

MKV is the right container for the derivative. HandBrake can pass through multiple DVD VobSub tracks into MKV as switchable soft subtitles, while a hard burn permanently writes one track into the picture ([HandBrake subtitle documentation](https://handbrake.fr/docs/en/1.6.0/advanced/subtitles.html)). Matroska has a defined `S_VOBSUB` codec mapping. It stores the DVD palette and frame size as codec initialization data and stores each DVD SPU packet as a subtitle frame ([Matroska codec mapping](https://www.matroska.org/technical/codec_specs.html#s_vobsub)).

The intended MKV stream layout is:

```text
video
audio track(s)
optional HandBrake foreign-audio-search VobSub track, default=yes, forced=yes
all source DVD VobSub tracks, default=no unless deliberately chosen
```

Do not replace VobSub with OCR-generated SRT in the base pipeline. SRT may be useful as an additional derived track later because browsers handle text subtitles cheaply, but OCR can change words, timing, positioning, signs, and styling. Keep the original VobSub even if an SRT is added.

## Language, names, default, and forced metadata

Language metadata matters to Jellyfin. HandBrake reads each DVD subpicture's ISO 639-2 language from the IFO and represents forced, closed-caption, commentary, and display-aspect attributes during the DVD scan ([DVD reader](https://github.com/HandBrake/HandBrake/blob/1.6.1/libhb/dvd.c#L178-L300)). Its MKV muxer writes the language using the ISO 639-2 bibliographic code where one exists and writes a subtitle title when it has one ([MKV muxer language mapping](https://github.com/HandBrake/HandBrake/blob/1.6.1/libhb/muxavformat.c#L114-L135), [subtitle metadata](https://github.com/HandBrake/HandBrake/blob/1.6.1/libhb/muxavformat.c#L1102-L1120)).

Jellyfin uses this metadata, not the track's position alone. In `Default` subtitle playback mode it considers external, default, or forced tracks. In `OnlyForced` mode it requires `IsForced` plus a preferred or undefined language. Its scoring also favors preferred languages, then forced and default flags ([Jellyfin stream selector](https://github.com/jellyfin/jellyfin/blob/master/Emby.Server.Implementations/Library/MediaStreamSelector.cs#L31-L86), [scoring](https://github.com/jellyfin/jellyfin/blob/master/Emby.Server.Implementations/Library/MediaStreamSelector.cs#L172-L190)).

Use this metadata policy:

- Preserve the language on every source track. Use `und` only when the DVD provides no usable language.
- Leave full dialogue, SDH, and commentary tracks non-default unless the operator explicitly chooses a house default.
- Keep the foreign-audio-search result as a distinct forced/default track. This lets Jellyfin show foreign dialogue without enabling a full subtitle track.
- Keep recognizable track titles such as `Closed Caption` and `Commentary`. Do not infer SDH or commentary from language alone.

There is a current Jellyfin edge case behind the separate forced track recommendation. Jellyfin 10.11.11 and 12.0 RC5 have an open report that cue-level force commands inside an otherwise non-forced VobSub track are ignored when subtitles are off ([jellyfin/jellyfin#17668](https://github.com/jellyfin/jellyfin/issues/17668)). A short track marked forced at the container level is safer than depending only on forced commands mixed into a full track. Treat the issue as a client/server bug report, not a format guarantee, and retain a regression fixture for it.

## Jellyfin compatibility and client cost

Jellyfin recognizes VobSub as a picture subtitle format and MKV as a supported subtitle container. Its official codec guide also warns that subtitles can cause a remux or a full video transcode when the client cannot render them. Burning subtitles during playback is the expensive case because Jellyfin must decode and re-encode the video ([Jellyfin codec support](https://jellyfin.org/docs/general/clients/codec-support/#subtitle-compatibility)).

Client behavior is not uniform:

- Jellyfin's web playback setting describes `Auto` as burning image formats including VobSub. Stable browser playback should therefore be tested with server-side transcoding available ([jellyfin-web setting text](https://github.com/jellyfin/jellyfin-web/blob/master/src/strings/en-us.json)). A VobSub renderer has merged for the Jellyfin Web 12 line, but 12.0 is still in release-candidate status as of this note, so the archive format should not depend on it ([web change](https://github.com/jellyfin/jellyfin-web/pull/7777), [12.0 RC releases](https://github.com/jellyfin/jellyfin-web/releases)).
- Jellyfin Android TV 0.19.4 added direct play for VobSub/DVDSub ([release notes](https://github.com/jellyfin/jellyfin-androidtv/releases/tag/v0.19.4)). The deployed Android TV 0.19.10 profile advertises embedded DVDSUB plus an encode fallback ([tagged profile](https://github.com/jellyfin/jellyfin-androidtv/blob/v0.19.10/app/src/main/java/org/jellyfin/androidtv/util/profile/deviceProfile.kt#L492-L515)). Older Android TV versions can require server encoding or fail playback.
- Kodi and Jellyfin Media Player use players with broader MKV support, but they still belong in the acceptance matrix. Container and subtitle support must both match before Jellyfin can Direct Play.

The right storage choice is still soft VobSub in MKV. It keeps the disc content intact and lets each client choose direct rendering or server burn-in. Pre-burning every subtitle merely makes one language permanent and throws away all other choices.

### Verified deployment state

These observations were checked against the live deployment on 2026-08-24:

- Encode worker: HandBrakeCLI 1.6.1.
- Jellyfin server: 10.11.11 with jellyfin-ffmpeg 7.1.4.
- Recent television client: Jellyfin Android TV 0.19.10.
- Server video acceleration: none, and no `/dev/dri` device is available.

The last point changes the operational cost. Android TV 0.19.10 can ask for embedded DVDSUB, but stable browser playback that burns a VobSub must do the decode, overlay, and video re-encode on the CPU. A browser acceptance test should include a long sample and inspect real-time transcode speed, not merely prove that playback starts. Preserving soft VobSub remains correct, but browser-heavy use may justify hardware acceleration or an optional OCR-derived text track later.

## Proposed pipeline

1. Keep the ISO as the Original Disc Archive. Do not alter archive publication.
2. Let the existing title selection choose the DVD title or chapter range.
3. Require and record a pinned HandBrakeCLI version of at least 1.8.0.
4. Encode video and audio to MKV with the profile preset plus `--all-subtitles --subtitle-burned=none`.
5. Probe the partial MKV before publication. In addition to the existing video/audio checks, inspect every subtitle stream's codec, language, title, and default/forced dispositions.
6. Reject an output that silently drops expected source tracks. A foreign-audio-search result may add zero or one extra output track, so compare by source tracks rather than requiring exact equality with the output count.
7. Treat an omitted `nb_read_packets` field as a zero-packet stream. Remove packetless VobSub streams with a stream-copy remux, then repeat the metadata and packet probes against the rewritten MKV. Publish only when every retained VobSub track is readable. Then refresh Jellyfin and run the client matrix.

A useful probe during implementation is:

```sh
ffprobe -v error \
  -select_streams s \
  -show_entries stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced \
  -of json \
  output.mkv
```

`ffprobe` supports stream selection, restricted entry output, and JSON output as documented in the [official ffprobe manual](https://ffmpeg.org/ffprobe.html). If metadata must be corrected after HandBrake, use a stream-copy remux and set every subtitle disposition explicitly. FFmpeg copies dispositions by default and can also manufacture a default stream when none exists, so a partial metadata edit is risky ([FFmpeg disposition rules](https://www.ffmpeg.org/ffmpeg.html#Main-options)). Prefer making HandBrake produce the right metadata and proving it with the probe.

The current archive scan already persists subtitle source ID, language code, language label, and content label per DVD title. That is enough evidence for title-specific expectations in explicit title and chapter-range jobs. A `main_feature` job also needs the title number HandBrake actually chose recorded or parsed before a strict source-to-output comparison can be made.

## Backfilling existing outputs

Re-encode existing movies from their Original Disc Archive through the normal corrected Encode Job and replacement-publication path. Do not transcode the already-published MKV. It cannot recover subtitle tracks that the old command dropped, and it may already contain a burned foreign-audio result. The existing replacement path also preserves the prior final as a Retained Encode Output until the corrected output publishes safely.

Do not start with a subtitle-only extraction and remux into the old MKV. The subtitle timing and canvas need to follow the same title, chapter range, crop, and timestamp transformations as the video encode. A full re-encode from the ISO gives HandBrake one source timeline for both video and VobSub and exercises the same validation and atomic publication path as new work.

Prioritize the backfill from persisted source evidence:

- For `dvd_title` and `dvd_chapters` selections, inspect that exact archived title's subtitle metadata. Re-encode outputs whose selected title has one or more subtitle streams.
- For `main_feature` selections, record the title number HandBrake resolves before making a precise decision. Until that provenance exists, conservatively re-encode an output when any plausible feature title on the disc has subtitles.
- Leave no-subtitle titles alone once a probe confirms that the archived title truly has none.

Publication crosses NFS into Jellyfin's media library. The deployment's library scan runs every 15 minutes, so a corrected MKV may not appear immediately. For an interactive verification, run Jellyfin's **Scan Media Library** task after publication rather than waiting for the scheduled scan. Verify Jellyfin's refreshed stream list before judging subtitle playback.

## Acceptance cases

Build or retain small, legally usable DVD ISO fixtures for these cases:

1. No subtitle streams. Encoding succeeds and produces no subtitle tracks.
2. One normal English VobSub track. The MKV contains readable `dvd_subtitle` packets, `eng`, and no default/forced disposition.
3. Several languages including an unknown-language track. Every source track survives, order is stable, and known languages are tagged.
4. A separate forced-only track. Jellyfin auto-selects it under `Default` and `OnlyForced` without enabling full subtitles.
5. Forced cues embedded in a full track. The HandBrake foreign-audio search creates a short forced/default soft track, and the cue displays in Jellyfin. This covers the open Jellyfin cue-level force bug.
6. A short foreign-language track without forced cue bits. HandBrake's 10-percent search heuristic finds it, keeps it soft, and does not burn it.
7. Full subtitles plus SDH/closed-caption and commentary variants. Track titles remain distinguishable and no track is made default by position.
8. Widescreen, letterbox, and 4:3 subtitle variants. Palette, placement, aspect, and cropping remain correct after video encoding.
9. A VobSub track containing an empty or fully transparent sample. It passes through and remains readable. This regresses the defect fixed in HandBrake 1.8.0.
10. A chapter-bounded selection. Subtitle timestamps start correctly at the encoded range and cues do not drift at the chapter boundary.
11. The same MKV played on stable Jellyfin Web, Android TV 0.19.4 or newer, and Jellyfin Media Player or Kodi. Record Direct Play, remux, or transcode for each, and verify subtitle selection, seeking, resume, and forced-dialogue startup.

The automated assertions should include the full HandBrake argument vector. That prevents a later preset or command refactor from quietly restoring bitmap burn-in or dropping `--all-subtitles`.

## Implementation decision and deferred work

Subtitle preservation applies to every accepted DVD Encoding Profile. This keeps the ISO-derived MKV faithful by default instead of letting a profile silently discard source tracks.

The remaining work is tracked separately:

- [Record HandBrake's resolved main-feature title number](https://github.com/pmaidens/rip-dvd/issues/246) so validation can compare against the correct archived title map.
- [Add optional OCR-derived SRT tracks](https://github.com/pmaidens/rip-dvd/issues/247) without replacing VobSub.
- [Validate the supported Jellyfin client matrix](https://github.com/pmaidens/rip-dvd/issues/248).
- [Backfill subtitle-aware encodes](https://github.com/pmaidens/rip-dvd/issues/249) from the Original Disc Archives.
