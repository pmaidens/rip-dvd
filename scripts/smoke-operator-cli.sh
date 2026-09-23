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

invoke() {
  docker compose --project-name "$project_name" --profile maintenance \
    run --rm --no-deps --no-TTY operator-cli "$@"
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

help_output="$(invoke)"
printf '%s\n' "$help_output" | assert_json_fields \
  'schemaVersion=1' 'usage=rip-dvd <command>'

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

printf 'Operator CLI deployment smoke passed.\n'
