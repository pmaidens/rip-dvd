#!/bin/sh

set -eu

smoke_mode="${1:-all}"
readiness_attempts=30
run_token="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
test -n "$run_token"
project_name_prefix="${COMPOSE_PROJECT_NAME:-rip-dvd-worker-smoke-$(date -u +%Y%m%d%H%M%S)}"
project_name_base="${project_name_prefix}-${run_token}"
worker_roles="archive encode"

load_worker_descriptor() {
  case "$1" in
    archive)
      worker_service=archive-worker
      worker_writable_path=/media/originals
      worker_ready_message="Archive worker ready"
      worker_shutdown_message="Archive worker received SIGTERM; stopping"
      ;;
    encode)
      worker_service=encode-worker
      worker_writable_path=/media/movies
      worker_ready_message="Encode worker ready"
      worker_shutdown_message="Encode worker received SIGTERM; stopping"
      ;;
    *)
      printf 'Unknown worker role: %s\n' "$1" >&2
      exit 2
      ;;
  esac
}

compose() {
  RIP_DVD_MEDIA_LIBRARY_HOST_PATH="$media_source" \
    RIP_DVD_ORIGINALS_LIBRARY_HOST_PATH="$originals_source" \
    docker compose --project-name "$project_name" "$@"
}

fail_collision() {
  candidate="$1"
  resource_type="$2"
  printf 'Refusing to reuse Compose project %s: matching %s already exist.\n' \
    "$candidate" "$resource_type" >&2
  exit 1
}

check_project_resource() {
  candidate="$1"
  resource_type="$2"
  shift 2

  if ! matches="$("$@")"; then
    printf 'Could not inspect Docker %s for Compose project %s; refusing to continue.\n' \
      "$resource_type" "$candidate" >&2
    exit 1
  fi
  if [ -n "$matches" ]; then
    fail_collision "$candidate" "$resource_type"
  fi
}

preflight_project() {
  candidate="$1"

  check_project_resource "$candidate" containers \
    docker ps --all --quiet --filter label=com.docker.compose.project="$candidate"
  check_project_resource "$candidate" volumes \
    docker volume ls --quiet --filter label=com.docker.compose.project="$candidate"
  check_project_resource "$candidate" networks \
    docker network ls --quiet --filter label=com.docker.compose.project="$candidate"

  for service in web archive-worker encode-worker
  do
    check_project_resource "$candidate" containers \
      docker ps --all --quiet --filter name=^/"${candidate}-${service}-[0-9][0-9]*"$
  done

  for volume in rip-dvd-data rip-dvd-media rip-dvd-originals
  do
    check_project_resource "$candidate" volumes \
      docker volume ls --quiet --filter name=^"${candidate}_${volume}"$
  done

  check_project_resource "$candidate" networks \
    docker network ls --quiet --filter name=^"${candidate}_default"$

  for service in web archive-worker encode-worker
  do
    check_project_resource "$candidate" images \
      docker image ls --quiet "${candidate}-${service}"
  done
}

probe_worker_write() {
  service="$1"
  writable_path="$2"
  marker_name="$3"

  compose run --rm --no-deps "$service" sh -eu -c '
    test "$(id -u)" -eq 1000
    test -w /data
    test -w "$1"
    marker="$1/$2"
    test ! -e "$marker"
    : > "$marker"
    rm "$marker"
  ' smoke-write-probe "$writable_path" "$marker_name"
}

wait_for_ready() {
  service="$1"
  ready_message="$2"
  attempt=0

  while [ "$attempt" -lt "$readiness_attempts" ]; do
    logs="$(compose logs --no-color "$service" 2>&1 || true)"
    if printf '%s\n' "$logs" | grep -F "$ready_message" >/dev/null; then
      return
    fi

    container_id="$(compose ps --all --quiet "$service")"
    if [ -n "$container_id" ] && \
      [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" != true ]; then
      printf '%s\n' "$logs" >&2
      printf '%s exited before reporting readiness.\n' "$service" >&2
      exit 1
    fi

    attempt=$((attempt + 1))
    sleep 1
  done

  printf '%s\n' "$logs" >&2
  printf 'Timed out waiting for %s after %s seconds.\n' \
    "$service" "$readiness_attempts" >&2
  exit 1
}

smoke_worker() (
  load_worker_descriptor "$1"
  service="$worker_service"
  writable_path="$worker_writable_path"
  ready_message="$worker_ready_message"
  shutdown_message="$worker_shutdown_message"
  marker_name=".rip-dvd-${service}-write-smoke-${run_token}"

  probe_worker_write "$service" "$writable_path" "$marker_name"

  # No command override: this must exercise the CMD configured in the image.
  compose up --detach --no-deps "$service"
  wait_for_ready "$service" "$ready_message"
  compose stop --timeout 10 "$service"

  container_id="$(compose ps --all --quiet "$service")"
  logs="$(compose logs --no-color "$service")"
  printf '%s\n' "$logs"

  printf '%s\n' "$logs" | grep -F "$ready_message" >/dev/null
  printf '%s\n' "$logs" | grep -F "$shutdown_message" >/dev/null
  test -n "$container_id"
  test "$(docker inspect --format '{{.State.ExitCode}}' "$container_id")" -eq 0
)

smoke_workers() {
  for worker_role in $worker_roles
  do
    smoke_worker "$worker_role"
  done

  printf 'Worker smoke test passed as UID 1000 using Compose project %s.\n' "$project_name"
}

smoke_named_volumes() {
  project_name="${project_name_base}-named"
  media_source=rip-dvd-media
  originals_source=rip-dvd-originals

  smoke_workers
  printf 'Named volumes and worker containers were retained for non-destructive inspection.\n'
}

smoke_bind_mounts() {
  project_name="${project_name_base}-bind"
  bind_root="$(mktemp -d "${TMPDIR:-/tmp}/rip-dvd-worker-bind-smoke.XXXXXX")"
  media_source="$bind_root/media"
  originals_source="$bind_root/originals"
  mkdir -p "$media_source" "$originals_source"

  compose run --rm --no-deps --user root archive-worker \
    sh -eu -c 'chown 1000:1000 /media/originals && chmod 0775 /media/originals'
  compose run --rm --no-deps --user root encode-worker \
    sh -eu -c 'chown 1000:1000 /media/movies && chmod 0775 /media/movies'

  smoke_workers
  printf 'Compose volumes, worker containers, and UID-1000 bind sources were retained at %s.\n' "$bind_root"
}

case "$smoke_mode" in
  all)
    preflight_project "${project_name_base}-named"
    preflight_project "${project_name_base}-bind"
    smoke_named_volumes
    smoke_bind_mounts
    ;;
  bind)
    preflight_project "${project_name_base}-bind"
    smoke_bind_mounts
    ;;
  named)
    preflight_project "${project_name_base}-named"
    smoke_named_volumes
    ;;
  *)
    printf 'Usage: %s [all|bind|named]\n' "$0" >&2
    exit 2
    ;;
esac
