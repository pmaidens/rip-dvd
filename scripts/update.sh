#!/bin/sh

set -eu

snapshot_marker="--rip-dvd-update-snapshot"

if [ "${1:-}" != "$snapshot_marker" ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--target" ]; then
    printf 'Usage: scripts/update.sh --target REVIEWED_FULL_SHA\n' >&2
    exit 2
  fi
  target_commit=$2
  case "$target_commit" in
    *[!0-9a-f]*|'')
      printf 'The deployment target must be a lowercase full Git SHA.\n' >&2
      exit 2
      ;;
  esac
  if [ "${#target_commit}" -ne 40 ]; then
    printf 'The deployment target must be a lowercase full Git SHA.\n' >&2
    exit 2
  fi
  script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd -P)"
  snapshot="$(mktemp "${TMPDIR:-/tmp}/rip-dvd-update.XXXXXX")"
  cp "$0" "$snapshot"
  exec sh "$snapshot" "$snapshot_marker" "$repository_root" "$snapshot" "$target_commit"
fi

if [ "$#" -ne 4 ]; then
  printf 'Usage: scripts/update.sh --target REVIEWED_FULL_SHA\n' >&2
  exit 2
fi

repository_root=$2
snapshot=$3
target_commit=$4
stage_file=${RIP_DVD_UPDATE_STAGE_FILE:-}
result_file=${RIP_DVD_UPDATE_RESULT_FILE:-}
owns_controller_lock=0
controller_lock=""

cleanup() {
  if [ "$owns_controller_lock" -eq 1 ]; then
    rm -f "$controller_lock/owner.json"
    rmdir "$controller_lock" 2>/dev/null || true
  fi
  rm -f "$snapshot"
}
trap cleanup 0
trap 'cleanup; exit 1' HUP INT TERM

set_stage() {
  if [ -n "$stage_file" ]; then
    printf '%s\n' "$1" > "$stage_file"
  fi
}

cd "$repository_root"

for required_command in git docker flock; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Required update tool is unavailable: %s\n' "$required_command" >&2
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

if [ "${RIP_DVD_CONTROLLER_LOCK_HELD:-0}" != 1 ]; then
  controller_state="$(git rev-parse --git-path rip-dvd-deployment)"
  case "$controller_state" in
    /*) ;;
    *) controller_state="$repository_root/$controller_state" ;;
  esac
  mkdir -p "$controller_state"
  controller_lock="$controller_state/run.lock"
  if ! mkdir "$controller_lock" 2>/dev/null; then
    printf 'Another rip-dvd deployment controller is running.\n' >&2
    exit 1
  fi
  owns_controller_lock=1
  printf '{"pid":%s,"source":"scripts/update.sh"}\n' "$$" > "$controller_lock/owner.json"
fi

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  printf 'Refusing to update a checkout with local changes.\n' >&2
  printf 'Preserve the local files and inspect them before retrying.\n' >&2
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

if ! git cat-file -e "$target_commit^{commit}" 2>/dev/null; then
  printf 'The reviewed deployment commit is unavailable locally: %s\n' "$target_commit" >&2
  exit 1
fi

previous_commit="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$previous_commit" "$target_commit"; then
  printf 'The reviewed target is not a fast-forward from HEAD.\n' >&2
  exit 1
fi

printf 'Updating rip-dvd on branch %s from %s to reviewed commit %s.\n' \
  "$branch" "$upstream" "$target_commit"
set_stage backup
printf 'Creating and verifying a pre-update database backup...\n'
backup_output="$(sh "$repository_root/scripts/compose-backup.sh")"
printf '%s\n' "$backup_output"
backup_filename="$(
  printf '%s\n' "$backup_output" |
    sed -n 's|^SQLite backup written to /backups/\([^/[:space:]]*\.sqlite\)$|\1|p'
)"
case "$backup_filename" in
  ''|*/*|*[!A-Za-z0-9._-]*)
    printf 'The backup command did not report one safe backup filename.\n' >&2
    exit 1
    ;;
esac
backup_host_path="$(
  docker compose config --environment |
    sed -n 's/^RIP_DVD_BACKUP_HOST_PATH=//p'
)"
backup_host_path=${backup_host_path:-$repository_root/backups}
case "$backup_host_path" in
  /*) ;;
  *) backup_host_path="$repository_root/$backup_host_path" ;;
esac
if [ ! -s "$backup_host_path/$backup_filename" ]; then
  printf 'The reported backup file is missing or empty.\n' >&2
  exit 1
fi
backup_size="$(stat -c %s "$backup_host_path/$backup_filename")"
printf 'Verified SQLite backup: %s (%s bytes)\n' \
  "$backup_filename" "$backup_size"

set_stage checkout
printf 'Fast-forwarding to the reviewed commit without fetching...\n'
git merge --ff-only "$target_commit"
current_commit="$(git rev-parse HEAD)"
if [ "$current_commit" != "$target_commit" ]; then
  printf 'Exact-commit enforcement failed after fast-forward.\n' >&2
  exit 1
fi

set_stage build
printf 'Building deployment images sequentially while current services remain running...\n'
sh "$repository_root/scripts/compose-build.sh"

set_stage migration
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
        healthy) break ;;
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

set_stage verification
printf 'Verifying the updated services...\n'
if ! verify_updated_services; then
  printf 'Update verification failed; stopping all runtime services.\n' >&2
  if ! sh "$repository_root/scripts/compose-stop.sh"; then
    printf 'ERROR: runtime cleanup also failed; inspect docker compose ps immediately.\n' >&2
  fi
  exit 1
fi

set_stage complete
if [ -n "$result_file" ]; then
  result_temporary="$result_file.tmp.$$"
  umask 077
  printf '{"schemaVersion":1,"backup":{"filename":"%s","sizeBytes":%s},"migrationsCurrent":true}\n' \
    "$backup_filename" "$backup_size" > "$result_temporary"
  mv "$result_temporary" "$result_file"
fi
printf 'rip-dvd update complete: %s -> %s\n' "$previous_commit" "$current_commit"
