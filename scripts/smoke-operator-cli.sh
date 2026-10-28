#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
project_name="rip-dvd-cli-smoke-$$"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/rip-dvd-cli-smoke.XXXXXX")"

cleanup() {
  docker compose --project-name "$project_name" --profile maintenance \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

cd "$repository_root"
export COMPOSE_PROJECT_NAME="$project_name"
./install.sh --bin-dir "$temporary_directory/bin" >/dev/null
installed_cli="$temporary_directory/bin/rip-dvd"

invoke() {
  "$installed_cli" "$@"
}

assert_json_fields() {
  node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const value = JSON.parse(text);
    for (const assertion of process.argv.slice(1)) {
      const separator = assertion.indexOf("=");
      const path = assertion.slice(0, separator).split(".");
      const expected = assertion.slice(separator + 1);
      const actual = path.reduce((current, part) => current?.[part], value);
      if (String(actual) !== expected) process.exit(1);
    }
  ' "$@"
}

docker compose --project-name "$project_name" --profile maintenance build operator-cli
docker compose --project-name "$project_name" --profile maintenance run --rm \
  --entrypoint ffprobe operator-cli -version >/dev/null

notification_status="$(invoke notifications status)"
printf '%s\n' "$notification_status" | assert_json_fields \
  'schemaVersion=1' 'configured=false'
notification_deliveries="$(invoke notifications deliveries --limit 1)"
printf '%s\n' "$notification_deliveries" | assert_json_fields 'schemaVersion=1'

help_output="$(invoke)"
printf '%s\n' "$help_output" | assert_json_fields \
  'schemaVersion=1' 'usage=rip-dvd <command>'

preview_help="$(invoke help damage-preview)"
printf '%s\n' "$preview_help" | assert_json_fields 'schemaVersion=1'
set +e
preview_output="$(invoke damage-preview availability synthetic-missing-archive \
  2>"$temporary_directory/preview.stderr")"
preview_status=$?
set -e
[ "$preview_status" -eq 2 ]
printf '%s\n' "$preview_output" | assert_json_fields 'error.code=NOT_FOUND'

set +e
verification_output="$(invoke archive-recovery inspect-verification \
  synthetic-missing-recovery \
  2>"$temporary_directory/verification.stderr")"
verification_status=$?
set -e
[ "$verification_status" -eq 2 ]
printf '%s\n' "$verification_output" | assert_json_fields \
  'error.code=NOT_FOUND'

set +e
confirmation_output="$(invoke archive-recovery preview-disc-confirmation \
  synthetic-missing-recovery \
  2>"$temporary_directory/confirmation.stderr")"
confirmation_status=$?
set -e
[ "$confirmation_status" -eq 2 ]
printf '%s\n' "$confirmation_output" | assert_json_fields \
  'error.code=NOT_FOUND'

set +e
reconciliation_output="$(invoke archive-recovery inspect-reconciliation \
  synthetic-missing-recovery \
  2>"$temporary_directory/reconciliation.stderr")"
reconciliation_status=$?
set -e
[ "$reconciliation_status" -eq 2 ]
printf '%s\n' "$reconciliation_output" | assert_json_fields \
  'error.code=NOT_FOUND'

set +e
stop_output="$(invoke archive-recovery stop \
  synthetic-missing-recovery \
  --key synthetic-smoke-recovery-stop-key \
  --attempt-id synthetic-missing-attempt \
  2>"$temporary_directory/recovery-stop.stderr")"
stop_status=$?
set -e
[ "$stop_status" -eq 2 ]
printf '%s\n' "$stop_output" | assert_json_fields \
  'error.code=NOT_FOUND'

set +e
resume_output="$(invoke archive-recovery resume \
  synthetic-missing-recovery \
  --key synthetic-smoke-recovery-resume-key \
  --attempt-id synthetic-missing-attempt \
  --checkpoint-revision 1 \
  --checkpoint-digest 0000000000000000000000000000000000000000000000000000000000000000 \
  --speed-mode low \
  2>"$temporary_directory/recovery-resume.stderr")"
resume_status=$?
set -e
[ "$resume_status" -eq 2 ]
printf '%s\n' "$resume_output" | assert_json_fields \
  'error.code=NOT_FOUND'

recovery_inventory="$(invoke inspect archive-recoveries)"
printf '%s\n' "$recovery_inventory" | assert_json_fields \
  'schemaVersion=1' 'kind=archive-recoveries'

set +e
ranges_output="$(invoke archive-recovery ranges \
  synthetic-missing-recovery \
  2>"$temporary_directory/recovery-ranges.stderr")"
ranges_status=$?
set -e
[ "$ranges_status" -eq 2 ]
printf '%s\n' "$ranges_output" | assert_json_fields \
  'error.code=NOT_FOUND'

set +e
missing_key_output="$(invoke submit-archive-audit 2>"$temporary_directory/missing-key.stderr")"
missing_key_status=$?
set -e
[ "$missing_key_status" -eq 2 ]
printf '%s\n' "$missing_key_output" | assert_json_fields \
  'error.code=INVALID_MUTATION_KEY'

set +e
malformed_output="$({
  invoke media-item create --key synthetic-smoke-malformed-key --json '{'
} 2>"$temporary_directory/malformed.stderr")"
malformed_status=$?
set -e
[ "$malformed_status" -eq 2 ]
printf '%s\n' "$malformed_output" | assert_json_fields \
  'error.code=INVALID_ARGUMENTS'

set +e
retired_output="$(invoke scan 2>"$temporary_directory/retired.stderr")"
retired_status=$?
set -e
[ "$retired_status" -eq 2 ]
printf '%s\n' "$retired_output" | assert_json_fields \
  'error.code=LEGACY_COMMAND_RETIRED'

printf '%s\n' '{"kind":"movie","title":"Synthetic Smoke Film"}' \
  >"$temporary_directory/media-item.json"
file_input_output="$(invoke media-item create \
  --key synthetic-smoke-file-key \
  --file "$temporary_directory/media-item.json")"
printf '%s\n' "$file_input_output" | assert_json_fields \
  'mediaItem.kind=movie' 'mediaItem.title=Synthetic Smoke Film'

audit_output="$(invoke submit-archive-audit \
  --key synthetic-smoke-archive-audit-key --limit 1)"
audit_id="$(printf '%s\n' "$audit_output" | node --input-type=module -e '
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value.archiveAuditRun?.status !== "queued") process.exit(1);
  process.stdout.write(value.archiveAuditRun.id);
')"
status_output="$(invoke inspect archive-audits "$audit_id")"
printf '%s\n' "$status_output" | assert_json_fields \
  "item.id=$audit_id" 'item.status=queued'

[ -z "$(docker compose --project-name "$project_name" ps --quiet web)" ]

# The independently managed dispatcher must include its runtime dependencies,
# migrate the same SQLite volume, and stop gracefully with no web container.
docker compose --project-name "$project_name" build notification-worker
docker compose --project-name "$project_name" up --detach --no-deps notification-worker
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker compose --project-name "$project_name" logs --no-color notification-worker 2>&1 \
    | grep -F 'Notification dispatcher started' >/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$attempt" -lt 30 ]
docker compose --project-name "$project_name" stop --timeout 10 notification-worker
dispatcher_id="$(docker compose --project-name "$project_name" ps --all --quiet notification-worker)"
[ "$(docker inspect --format '{{.State.ExitCode}}' "$dispatcher_id")" -eq 0 ]
docker compose --project-name "$project_name" logs --no-color notification-worker 2>&1 \
  | grep -F 'Notification worker received SIGTERM; stopping' >/dev/null

printf 'Operator CLI and notification dispatcher deployment smoke passed.\n'
