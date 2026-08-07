#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

compose_environment="$(docker compose config --environment)"
backup_host_path="$(
  printf '%s\n' "$compose_environment" |
    sed -n 's/^RIP_DVD_BACKUP_HOST_PATH=//p'
)"
backup_host_path="${backup_host_path:-$repository_root/backups}"
case "$backup_host_path" in
  /*) ;;
  *) backup_host_path="$repository_root/$backup_host_path" ;;
esac
mkdir -p "$backup_host_path"
backup_host_path="$(CDPATH= cd -- "$backup_host_path" && pwd -P)"
export RIP_DVD_BACKUP_HOST_PATH="$backup_host_path"

exec docker compose --profile maintenance run --rm --no-deps backup
