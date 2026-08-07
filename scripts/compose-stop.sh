#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

# Stop is intentionally non-destructive: it keeps containers, networks, and
# every persistent volume available for restart and operator inspection.
exec docker compose stop --timeout 30 archive-worker encode-worker web
