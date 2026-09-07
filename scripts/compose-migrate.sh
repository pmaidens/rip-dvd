#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

# Schema migrations can rebuild tables. Stop every runtime that shares SQLite
# before applying DDL; compose-stop preserves containers, networks, and volumes.
if [ -n "${RIP_DVD_UPDATE_STAGE_FILE:-}" ]; then
  printf 'quiescing\n' > "$RIP_DVD_UPDATE_STAGE_FILE"
fi
sh "$script_directory/compose-stop.sh"
if [ -n "${RIP_DVD_UPDATE_STAGE_FILE:-}" ]; then
  printf 'migration\n' > "$RIP_DVD_UPDATE_STAGE_FILE"
fi

exec docker compose --profile maintenance run --rm --no-deps migrate
