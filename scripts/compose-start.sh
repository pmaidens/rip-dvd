#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

compose_environment="$(docker compose config --environment)"
block_io_weights_enabled="$(
  printf '%s\n' "$compose_environment" |
    sed -n 's/^RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS=//p'
)"
block_io_weights_enabled="${block_io_weights_enabled:-0}"
case "$block_io_weights_enabled" in
  0|1) ;;
  *)
    printf 'RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS must be 0 or 1\n' >&2
    exit 1
    ;;
esac

sh "$script_directory/compose-migrate.sh"

case "$block_io_weights_enabled" in
  0)
    exec docker compose up --detach --no-build web archive-worker encode-worker
    ;;
  1)
    if [ -f compose.override.yaml ]; then
      exec docker compose \
        --file compose.yaml \
        --file compose.override.yaml \
        --file compose.linux-priority.yaml \
        up --detach --no-build web archive-worker encode-worker
    fi
    exec docker compose \
      --file compose.yaml \
      --file compose.linux-priority.yaml \
      up --detach --no-build web archive-worker encode-worker
    ;;
esac
