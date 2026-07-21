#!/bin/sh

set -eu

project_name="${COMPOSE_PROJECT_NAME:-rip-dvd-worker-smoke-$$}"

compose() {
  RIP_DVD_MEDIA_LIBRARY_HOST_PATH=rip-dvd-media \
    RIP_DVD_ORIGINALS_LIBRARY_HOST_PATH=rip-dvd-originals \
    docker compose --project-name "$project_name" "$@"
}

archive_output="$(compose run --rm --no-deps archive-worker sh -eu -c '
  test "$(id -u)" -eq 1000
  test -w /data
  test -w /media/originals
  marker=/media/originals/.rip-dvd-archive-write-smoke
  : > "$marker"
  rm "$marker"
  node apps/archive-worker/dist/index.js &
  worker_pid=$!
  sleep 1
  kill -TERM "$worker_pid"
  wait "$worker_pid"
')"
printf '%s\n' "$archive_output"
printf '%s\n' "$archive_output" | grep -F "Archive worker ready" >/dev/null

encode_output="$(compose run --rm --no-deps encode-worker sh -eu -c '
  test "$(id -u)" -eq 1000
  test -w /data
  test -w /media/movies
  marker=/media/movies/.rip-dvd-encode-write-smoke
  : > "$marker"
  rm "$marker"
  node apps/encode-worker/dist/index.js &
  worker_pid=$!
  sleep 1
  kill -TERM "$worker_pid"
  wait "$worker_pid"
')"
printf '%s\n' "$encode_output"
printf '%s\n' "$encode_output" | grep -F "Encode worker ready" >/dev/null

printf 'Worker smoke test passed as UID 1000 using Compose project %s.\n' "$project_name"
printf 'Named volumes were retained for non-destructive inspection.\n'
