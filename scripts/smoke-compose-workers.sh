#!/bin/sh

set -eu

project_name_base="${COMPOSE_PROJECT_NAME:-rip-dvd-worker-smoke-$$}"
smoke_mode="${1:-all}"

compose() {
  RIP_DVD_MEDIA_LIBRARY_HOST_PATH="$media_source" \
    RIP_DVD_ORIGINALS_LIBRARY_HOST_PATH="$originals_source" \
    docker compose --project-name "$project_name" "$@"
}

smoke_worker() {
  service="$1"
  writable_path="$2"
  entry_point="$3"
  ready_message="$4"
  marker_name="$5"

  output="$(compose run --rm --no-deps "$service" sh -eu -c '
  test "$(id -u)" -eq 1000
  test -w /data
  test -w "$1"
  marker="$1/$3"
  : > "$marker"
  rm "$marker"
  node "$2" &
  worker_pid=$!
  sleep 1
  kill -TERM "$worker_pid"
  wait "$worker_pid"
' smoke-worker "$writable_path" "$entry_point" "$marker_name")"

  printf '%s\n' "$output"
  printf '%s\n' "$output" | grep -F "$ready_message" >/dev/null
}

smoke_workers() {
  smoke_worker \
    archive-worker \
    /media/originals \
    apps/archive-worker/dist/index.js \
    "Archive worker ready" \
    .rip-dvd-archive-write-smoke

  smoke_worker \
    encode-worker \
    /media/movies \
    apps/encode-worker/dist/index.js \
    "Encode worker ready" \
    .rip-dvd-encode-write-smoke

  printf 'Worker smoke test passed as UID 1000 using Compose project %s.\n' "$project_name"
}

smoke_named_volumes() {
  project_name="${project_name_base}-named"
  media_source=rip-dvd-media
  originals_source=rip-dvd-originals

  smoke_workers
  printf 'Named volumes were retained for non-destructive inspection.\n'
}

smoke_bind_mounts() {
  project_name="${project_name_base}-bind"
  bind_root="$(mktemp -d "${TMPDIR:-/tmp}/rip-dvd-worker-bind-smoke.XXXXXX")"
  media_source="$bind_root/media"
  originals_source="$bind_root/originals"
  mkdir -p "$media_source" "$originals_source"

  compose run --rm --no-deps --user root archive-worker \
    sh -eu -c 'chown 1000:1000 /media/originals && chmod 0775 /media/originals'
  compose run --rm --no-deps --user root encode-worker \
    sh -eu -c 'chown 1000:1000 /media/movies && chmod 0775 /media/movies'

  smoke_workers
  printf 'Compose volumes and UID-1000 bind sources were retained at %s.\n' "$bind_root"
}

case "$smoke_mode" in
  all)
    smoke_named_volumes
    smoke_bind_mounts
    ;;
  bind)
    smoke_bind_mounts
    ;;
  named)
    smoke_named_volumes
    ;;
  *)
    printf 'Usage: %s [all|bind|named]\n' "$0" >&2
    exit 2
    ;;
esac
