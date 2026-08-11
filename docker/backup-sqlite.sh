#!/bin/sh

set -eu

database_path="${RIP_DVD_DATABASE_PATH:-/data/rip-dvd.sqlite}"
backup_directory="${RIP_DVD_BACKUP_DIRECTORY:-/backups}"

if [ ! -f "$database_path" ]; then
  printf 'SQLite database does not exist: %s\n' "$database_path" >&2
  exit 1
fi
if [ ! -d "$backup_directory" ] || [ ! -w "$backup_directory" ]; then
  printf 'Backup directory is not writable: %s\n' "$backup_directory" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_token="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
test -n "$run_token"
backup_path="$backup_directory/rip-dvd-$timestamp-$run_token.sqlite"
partial_path="$backup_path.partial"

case "$partial_path" in
  *"'"*)
    printf 'Backup path contains an unsupported quote: %s\n' "$partial_path" >&2
    exit 1
    ;;
esac

cleanup_partial() {
  if [ -n "${partial_path:-}" ]; then
    rm -f -- "$partial_path" "$partial_path-wal" "$partial_path-shm"
  fi
}
trap cleanup_partial EXIT HUP INT TERM

umask 077
sqlite3 "$database_path" \
  ".timeout 30000" \
  ".backup '$partial_path'"

integrity="$(sqlite3 "$partial_path" 'PRAGMA integrity_check;')"
if [ "$integrity" != ok ]; then
  printf 'SQLite backup integrity check failed: %s\n' "$integrity" >&2
  exit 1
fi

rm -f -- "$partial_path-wal" "$partial_path-shm"
chmod 0600 "$partial_path"
sync -f "$partial_path" 2>/dev/null || true
mv "$partial_path" "$backup_path"
partial_path=
sync -f "$backup_directory" 2>/dev/null || true
printf 'SQLite backup written to %s\n' "$backup_path"
