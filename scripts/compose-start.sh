#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
cd "$repository_root"

hardware_identity_config=".local/optical-drives.json"
if [ -f "$hardware_identity_config" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'Node.js is required to resolve configured optical-drive identities.\n' >&2
    exit 1
  fi
  printf 'Resolving configured optical-drive identities before startup...\n'
  node "$script_directory/optical-drive-mapping.mjs" \
    --config "$hardware_identity_config" \
    --output compose.override.yaml
fi

compose_environment="$(docker compose config --environment)"

web_bind_address="$(
  printf '%s\n' "$compose_environment" |
    sed -n 's/^RIP_DVD_WEB_BIND_ADDRESS=//p'
)"
web_bind_address="${web_bind_address:-127.0.0.1}"
web_port="$(
  printf '%s\n' "$compose_environment" |
    sed -n 's/^RIP_DVD_WEB_PORT=//p'
)"
web_port="${web_port:-3000}"
web_trusted_origin="$(
  printf '%s\n' "$compose_environment" |
    sed -n 's/^RIP_DVD_WEB_TRUSTED_ORIGIN=//p'
)"
web_trusted_origin="${web_trusted_origin:-http://localhost:$web_port}"

normalized_trusted_origin="$(
  printf '%s' "$web_trusted_origin" | tr '[:upper:]' '[:lower:]'
)"
case "$normalized_trusted_origin" in
  http://*) trusted_origin_authority="${normalized_trusted_origin#http://}" ;;
  https://*) trusted_origin_authority="${normalized_trusted_origin#https://}" ;;
  *) trusted_origin_authority= ;;
esac
trusted_origin_authority="${trusted_origin_authority%%/*}"

case "$web_bind_address" in
  127.0.0.1|localhost|::1) ;;
  *)
    case "$trusted_origin_authority" in
      localhost|localhost:*|127.0.0.1|127.0.0.1:*|'[::1]'|'[::1]':*)
        printf '%s\n' \
          "RIP_DVD_WEB_BIND_ADDRESS exposes the dashboard beyond loopback ($web_bind_address), but RIP_DVD_WEB_TRUSTED_ORIGIN is loopback-only ($web_trusted_origin)." \
          'RIP_DVD_WEB_TRUSTED_ORIGIN must use the browser-facing origin before runtime services can start.' >&2
        exit 1
        ;;
    esac
    ;;
esac

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

start_runtime_services() {
  case "$block_io_weights_enabled" in
    0)
      docker compose up --detach --no-build web archive-worker encode-worker
      ;;
    1)
      if [ -f compose.override.yaml ]; then
        docker compose \
          --file compose.yaml \
          --file compose.override.yaml \
          --file compose.linux-priority.yaml \
          up --detach --no-build web archive-worker encode-worker
      else
        docker compose \
          --file compose.yaml \
          --file compose.linux-priority.yaml \
          up --detach --no-build web archive-worker encode-worker
      fi
      ;;
  esac
}

if start_runtime_services; then
  exit 0
else
  start_status=$?
fi

printf 'Runtime startup failed; re-quiescing all runtime services before exiting.\n' >&2
if sh "$script_directory/compose-stop.sh"; then
  printf 'Runtime services are stopped. Correct the startup error, then rerun scripts/compose-start.sh.\n' >&2
else
  printf 'ERROR: runtime cleanup also failed. Run scripts/compose-stop.sh and verify every runtime is stopped before retrying.\n' >&2
fi
exit "$start_status"
