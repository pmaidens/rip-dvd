#!/bin/sh
set -eu
run="synthetic-$(date +%s)-$$"
for row in complete:compatible:none complete:incompatible:none complete:audio_conversion:none complete:video_format:none complete:subtitles:none complete:subtitles:2 complete:subtitles:3 partial:incompatible:none stale:incompatible:none longclip:compatible:none missing:compatible:none conversion_failure:incompatible:none; do
  sample_case=${row%%:*}
  remainder=${row#*:}
  variant=${remainder%%:*}
  burn=${remainder##*:}
  export RIP_DVD_PREVIEW_BROWSER_CASE="$sample_case"
  export RIP_DVD_PREVIEW_BROWSER_VARIANT="$variant"
  export RIP_DVD_PREVIEW_BROWSER_RUN="$run-$sample_case-$variant-$burn"
  unset RIP_DVD_PREVIEW_BROWSER_BURN_SUBTITLE
  if [ "$burn" != none ]; then export RIP_DVD_PREVIEW_BROWSER_BURN_SUBTITLE="$burn"; fi
  pnpm test:browser:preview-renditions
 done
