# Bypass dvdnav for archived ISO encodes

HandBrake can report a successful encode after libdvdnav loses the DVD title
timeline. In observed failures, `Invalid angle block`, `chapter NOT FOUND!`, or
`dvdnav_sector_search failed` left only 97 seconds of an 8,078-second title and
445 seconds of a 6,268-second title. The existing stream and bounded-decode
checks accepted both files.

Every HandBrake encode from an Original Disc Archive ISO uses `--no-dvdnav` on
its first and only attempt. Archived images do not need menu navigation, and
libdvdread found the complete titles in both failures. The worker does not first
run an encode with dvdnav and retry after validation. That would spend time on
an output already known to use the less reliable path and would complicate
cancellation and partial-output ownership.

The output validator also compares a full-title encode with the archived DVD
title duration. An output must retain at least 98 percent of the stored
duration. This allows for whole-second source metadata and container timestamp
differences while rejecting a material truncation. An explicit `dvd_title`
selection uses that title's duration. A `main_feature` selection uses the
longest stored title, matching HandBrake's main-feature choice.

A bounded `dvd_chapters` selection still uses `--no-dvdnav`, but it has no
duration requirement. The archived title map records the whole-title duration
and chapter count, not individual chapter durations. Deriving an expectation
from chapter count would reject valid ranges on discs with uneven chapters.
Stream metadata, subtitle packets, initial timing, and bounded video decode
validation continue to apply.

A duration failure follows the existing failed-output path. The worker does not
publish the partial, marks the Encode Job failed, and retains the partial under
the existing quarantine and recovery rules.
