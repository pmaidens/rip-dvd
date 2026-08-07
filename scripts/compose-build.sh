#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

exec docker compose --profile maintenance build \
  migrate backup web archive-worker encode-worker
