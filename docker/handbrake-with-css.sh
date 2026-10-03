#!/bin/sh
set -eu

label_library=/usr/local/lib/rip-dvd-handbrake-dvd-label.so
if [ ! -r "$label_library" ]; then
  printf 'HandBrake DVD label compatibility library is unavailable\n' >&2
  exit 1
fi

LD_LIBRARY_PATH=/usr/local/lib LD_PRELOAD="$label_library" exec /usr/bin/HandBrakeCLI "$@"
