# DVD title damage percentages and playback estimates

Research for [Investigate DVD title damage percentages and playback estimates](https://github.com/pmaidens/rip-dvd/issues/313), under [DVD recovery and title damage review](https://github.com/pmaidens/rip-dvd/issues/311). Investigated 2026-09-09 against rip-dvd commit `21f5c8864173d7ae5a11a3b08d6e07c281b0bb02`. This records evidence and possible measurement methods, not product policy or an implementation.

## Findings

Exact missing-source counts are feasible when the saved archive has a trustworthy damage map. Title attribution additionally needs trustworthy filesystem and navigation mappings. Estimated affected playback needs a timeline. None of these establishes exactly how many seconds a viewer will lose.

The existing classifier translates physical LBAs through filesystem extents and concatenated title VOB parts, finds intersecting title cell ranges, and counts a shared bad sector against every associated title. It returns counts on acceptance and rejects navigation damage or ambiguity. Its internal cell records retain sector and angle fields, but no playback duration. It expands the damage map into individual sectors with a 250,000-sector safety bound. Large skipped regions therefore require different range handling and partial results, not just an extra output field. [Current layout classifier](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/apps/archive-worker/src/dvd-layout-classifier.ts#L1849), [attribution](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/apps/archive-worker/src/dvd-layout-classifier.ts#L4294), [counting](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/apps/archive-worker/src/dvd-layout-classifier.ts#L6327).

The current playback validator runs HandBrake with a fast encode to `/dev/null`. It aggregates audio and video decoder counts and computes duration from synchronized frames and average frame rate. It exposes no timestamps for errors. Aggregate decoder errors are not a count of distinct seconds affected. [Playback validator](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/apps/archive-worker/src/dvd-title-playback-validator.ts).

## Mapping evidence

libdvdread's IFO structures express title navigation through program chains, programs, and cells. Cells carry first/last sector, playback time, VOB/cell identity, angle-block information, interleaving, and clock-discontinuity flags. These fields can support a cell-to-title mapping and coarse timing. A cell envelope alone does not identify which interleaved sectors belong to the chosen angle. [libdvdread IFO definitions, XBMC-maintained source copy](https://raw.githubusercontent.com/xbmc/libdvdread/master/src/dvdread/ifo_types.h).

NAV packets provide a finer association. PCI includes VOBU start/end presentation times and elapsed cell time. DSI includes VOBU extent, cell/VOB identifiers, reference-picture endpoints, next/previous VOBU links, and interleaved-angle addresses. These are useful inputs to a sector-to-VOBU-to-timeline index; their presence does not prove that a damaged disc's pointers are valid. [libdvdread NAV definitions, XBMC-maintained source copy](https://raw.githubusercontent.com/xbmc/libdvdread/master/src/dvdread/nav_types.h).

FFmpeg's DVD demuxer explicitly selects title/program-chain coordinates and angle, uses libdvdnav playback, and tracks cell-relative time, discontinuities, and VOBU timing with a 90 kHz time base. Its source distinguishes estimated IFO timing from frame-accurate timing. Traversal can end when navigation leaves the expected path. An analyst must record selected path and analysis coverage rather than assume that opening a title scans everything it might reference. [FFmpeg 8.0 DVD demuxer](https://ffmpeg.org/doxygen/8.0/dvdvideodec_8c_source.html).

## Candidate measurements and denominators

The following are derived measurement definitions, not API guarantees or selected UI policy.

| Measurement | Calculation | Meaning and limits |
| --- | --- | --- |
| Remaining missing source | Union of currently unrecovered LBA ranges, multiplied by 2,048 bytes | Exact relative to reader evidence. A skipped block is missing from this archive even when many of its sectors have never been individually tested. |
| Disc missing percentage | Missing sectors divided by declared archive sector count | Must use the same archive boundary as the copy. Says nothing about a particular title. |
| Title missing-source percentage | Cardinality of missing sectors intersecting the title's unique source-sector set, divided by that set's cardinality | Exact conditional on complete, correct mapping and a defined playback selection. Includes whatever multiplexed content and NAV sectors that denominator covers; it is not a video-frame percentage. |
| Playback occurrences touched | Union of timeline intervals associated with intersected VOBUs or cells | Estimates where missing source might matter. Repeated playback of the same source range produces separate occurrences. |
| Estimated affected-playback percentage | Duration of that timeline union divided by the matching title playback duration | Conditional estimate, with method and coverage attached. It is not a measured duration removed from encoded output. |

For example, 100 missing sectors among 100,000 unique title sectors is 0.1% missing source. If that title plays the same damaged source twice, its physical missing count remains 100; the two playback occurrences belong in its timeline separately. Two titles sharing the damaged source each inherit the impact. Summing title counts would overcount disc loss. Deduplicate overlapping chapter/cell references for physical counts and overlapping time intervals within each playback occurrence.

Whole-VOB size is an unsuitable title denominator when several titles share a VOB. A union across all angles answers a different question from the sectors used by the selected angle. The contract must name which it measures.

## Estimating playback without inventing precision

A feasible method is to identify intersected VOBUs and place their complete intervals on a normalized title timeline. If their NAV is damaged but trustworthy surrounding anchors and a continuous path survive, bracket the unknown region between those anchors. If only a cell's extent and timing survive, report the cell span as coarse evidence. If ordering or timestamps cannot be established, return unknown for that portion. Do not subtract raw timestamps across a discontinuity or average separate branches together.

These intervals conservatively contain the mapped source gap in playback time. They are not upper bounds on visible decoder impact: corruption of a reference picture can affect later dependent pictures, and loss of navigation can prevent much more content from being reached. Conversely, a gap may affect only an unused audio stream, subtitles, or padding. With variable bitrate and multiplexed streams, missing bytes divided by total bytes cannot establish missing video time. These are consequences of the mapping and decoder evidence above and below, not calibrated error bounds.

FFmpeg documents error concealment, including predicting from previous frames. Its error-resilience implementation uses neighboring/reference-picture information to reconstruct damaged blocks. A decoded frame can therefore be produced despite missing original data. Successful completion or preserved output duration is not proof of an undamaged viewing experience. [Codec error-concealment options](https://ffmpeg.org/ffmpeg-codecs.html), [FFmpeg 8.0 error resilience](https://ffmpeg.org/doxygen/8.0/error__resilience_8c_source.html).

Timed decoder observations would be separate evidence tied to decoder version, settings, stream selection, and archive revision. Missing timestamps, skipped packets, concealment, and early termination mean neither an error log count nor a successful exit measures visual damage exhaustively. A total duration difference can reveal a discrepancy but cannot locate it or assign its entire cause to read errors.

## Cost and uncertainty

IFO/cell analysis reads metadata. NAV indexing adds reads across the saved title structure; full decode examines elementary streams and adds CPU work. FFmpeg's `preindex` performs a second pass for chapter timing and duration, and its documentation recommends a disk backup over the optical drive for this work. It is a useful reference implementation, not a ready-made bad-LBA impact reporter. [FFmpeg DVD options](https://ffmpeg.org/ffmpeg-formats.html#dvdvideo).

No runtime benchmark or damaged-disc experiment was performed in this research. Cost estimates require representative images. Sparse interval intersections can avoid the current per-bad-sector expansion, but NAV traversal and decoder work still have independent costs. Catalog estimates generated while recovery changes the image must identify the evidence revision; otherwise their numerator, navigation data, and decoder observations can describe different images.

Damaged IFO, BUP, filesystem extents, or NAV should reduce mapping coverage explicitly. Surviving validated copies or previously captured metadata may provide evidence, but conflicting or incomplete data cannot justify a clean title. A title may have known missing-source intersections plus additional unknown impact. Unknown title enumeration is also different from a known title with unknown duration.

## Decisions now precise enough to take

- Does title percentage describe unique source sectors for the chosen angle/path, or all referenced content? Which multiplexed streams and NAV sectors belong in it?
- Is the first estimate VOBU-based, cell-based, or a staged combination? What evidence is enough to bracket a damaged NAV region?
- How are known intervals, unknown coverage, coarse timing, and timed decoder observations represented independently?
- Is decoding optional on demand, or required for some titles? Which streams and versions define the observation?
- How does assessment identify the archive revision and become stable before encoding?

These decisions belong in the map's design tickets. The research establishes available evidence and limits; it does not choose a watchability threshold or recovery policy.
