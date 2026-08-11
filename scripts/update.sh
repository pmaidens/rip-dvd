#!/bin/sh

set -eu

snapshot_marker="--rip-dvd-update-snapshot"

if [ "${1:-}" != "$snapshot_marker" ]; then
  if [ "$#" -ne 0 ]; then
    printf 'Usage: scripts/update.sh\n' >&2
    exit 2
  fi
  script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd -P)"
  snapshot="$(mktemp "${TMPDIR:-/tmp}/rip-dvd-update.XXXXXX")"
  cp "$0" "$snapshot"
  exec sh "$snapshot" "$snapshot_marker" "$repository_root" "$snapshot"
fi

if [ "$#" -ne 3 ]; then
  printf 'Usage: scripts/update.sh\n' >&2
  exit 2
fi

repository_root=$2
snapshot=$3

update_lock=""
cleanup() {
  rm -f "$snapshot"
}
trap cleanup 0
trap 'cleanup; exit 1' HUP INT TERM

cd "$repository_root"

for command in git docker flock; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required update tool is unavailable: %s\n' "$command" >&2
    exit 1
  fi
done

actual_repository_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$actual_repository_root" ] ||
  [ "$(CDPATH= cd -- "$actual_repository_root" 2>/dev/null && pwd -P)" != "$repository_root" ]; then
  printf 'Update must run from a rip-dvd Git checkout.\n' >&2
  exit 1
fi

update_lock="$(git rev-parse --git-path rip-dvd-update.lock)"
case "$update_lock" in
  /*) ;;
  *) update_lock="$repository_root/$update_lock" ;;
esac
exec 9>"$update_lock"
if ! flock -n 9; then
  printf 'Another rip-dvd update is already running.\n' >&2
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  printf 'Refusing to update a checkout with local changes.\n' >&2
  printf 'Commit, stash, or remove the changes, then rerun scripts/update.sh.\n' >&2
  exit 1
fi

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [ -z "$branch" ]; then
  printf 'Refusing to update a detached HEAD checkout.\n' >&2
  exit 1
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [ -z "$upstream" ]; then
  printf 'Branch %s has no configured upstream.\n' "$branch" >&2
  exit 1
fi

previous_commit="$(git rev-parse HEAD)"
printf 'Updating rip-dvd on branch %s from %s.\n' "$branch" "$upstream"
printf 'Creating a pre-update database backup...\n'
sh "$repository_root/scripts/compose-backup.sh"

printf 'Fast-forwarding the checkout...\n'
git pull --ff-only
current_commit="$(git rev-parse HEAD)"

printf 'Building deployment images while the current services remain running...\n'
sh "$repository_root/scripts/compose-build.sh"

printf 'Migrating and starting the updated services...\n'
sh "$repository_root/scripts/compose-start.sh"

verify_updated_services() {
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    web_container="$(docker compose ps --quiet web)"
    if [ -n "$web_container" ]; then
      web_status="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "$web_container"
      )"
      case "$web_status" in
        healthy|running) break ;;
        unhealthy|exited|dead)
          printf 'Updated web service entered state: %s\n' "$web_status" >&2
          return 1
          ;;
      esac
    fi
    attempts=$((attempts + 1))
    sleep 1
  done

  if [ "$attempts" -ge 60 ]; then
    printf 'Updated web service did not become healthy within 60 seconds.\n' >&2
    return 1
  fi

  running_services="$(docker compose ps --status running --services)"
  for service in web archive-worker encode-worker; do
    if ! printf '%s\n' "$running_services" | grep -F -x "$service" >/dev/null; then
      printf 'Updated service is not running: %s\n' "$service" >&2
      return 1
    fi
  done
}

printf 'Verifying the updated services...\n'
if ! verify_updated_services; then
  printf 'Update verification failed; stopping all runtime services.\n' >&2
  if ! sh "$repository_root/scripts/compose-stop.sh"; then
    printf 'ERROR: runtime cleanup also failed; inspect docker compose ps immediately.\n' >&2
  fi
  exit 1
fi

printf 'rip-dvd update complete: %s -> %s\n' "$previous_commit" "$current_commit"
