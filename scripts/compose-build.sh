#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

for build_target in migrate backup web archive-worker encode-worker; do
  printf 'Building deployment image: %s\n' "$build_target"
  docker compose --progress plain --profile maintenance build "$build_target"
done
