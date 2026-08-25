#!/bin/sh

set -eu

if [ ! -x /usr/local/bin/rip-dvd-handbrake ]; then
  printf 'Encode worker CSS-enabled HandBrake command is unavailable\n' >&2
  exit 1
fi
handbrake_package_version="$(
  dpkg-query --show --showformat='${Version}' handbrake-cli 2>/dev/null
)" || {
  printf 'Encode worker HandBrake package version is unavailable\n' >&2
  exit 1
}
case "$handbrake_package_version" in
  "${RIP_DVD_HANDBRAKE_VERSION}"+*) ;;
  *)
    printf 'Encode worker HandBrake package version is unsupported: %s\n' \
      "$handbrake_package_version" >&2
    exit 1
    ;;
esac
for library in \
  /usr/local/lib/libdvdcss.so.2 \
  /usr/local/lib/libdvdcss-sg-io.so.0
do
  if [ ! -r "$library" ]; then
    printf 'Encode worker DVD CSS library is unavailable: %s\n' "$library" >&2
    exit 1
  fi
done
if ! /sbin/ldconfig -p | grep --quiet 'libdvdcss.so.2'; then
  printf 'Encode worker DVD CSS library is not registered with the dynamic loader\n' >&2
  exit 1
fi

exec sh /app/scripts/worker-priority-entrypoint.sh "$@"
