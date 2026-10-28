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

claim_inventory="$(invoke inspect encode-jobs)"
printf '%s\n' "$claim_inventory" | assert_json_fields 'schemaVersion=1' 'kind=encode-jobs' 'items.length=0'

readiness_help="$(invoke help encode-readiness)"
printf '%s\n' "$readiness_help" | assert_json_fields 'schemaVersion=1'
readiness_choices="$(invoke encode-readiness)"
printf '%s\n' "$readiness_choices" | assert_json_fields 'schemaVersion=1' 'page.offset=0'
set +e
readiness_missing="$(invoke encode-readiness synthetic-missing-archive 2>"$temporary_directory/readiness.stderr")"
readiness_status=$?
set -e
[ "$readiness_status" -eq 2 ]
printf '%s\n' "$readiness_missing" | assert_json_fields 'error.code=NOT_FOUND'

preview_help="$(invoke help damage-preview)"
printf '%s\n' "$preview_help" | assert_json_fields 'schemaVersion=1'

receipt_help="$(invoke help encode-output)"
printf '%s\n' "$receipt_help" | assert_json_fields 'schemaVersion=1'
set +e
interval_output="$(invoke encode-output intervals \
  encode-output-v1.published.00000000-0000-4000-8000-000000000000 \
  --json '{"assessmentIdentity":"synthetic-assessment","titleIdentityObservationId":"synthetic-observation","intervalIndexes":[0]}' \
  2>"$temporary_directory/interval.stderr")"
interval_status=$?
set -e
[ "$interval_status" -eq 2 ]
printf '%s\n' "$interval_output" | assert_json_fields 'error.code=ENCODE_OUTPUT_NOT_FOUND'
set +e
receipt_output="$(invoke encode-output acknowledge-inspection \
  encode-output-v1.published.00000000-0000-4000-8000-000000000000 \
  --key synthetic-smoke-inspection-receipt \
  --json '{"acknowledged":true,"reviewToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  2>"$temporary_directory/receipt.stderr")"
receipt_status=$?
set -e
[ "$receipt_status" -eq 2 ]
printf '%s\n' "$receipt_output" | assert_json_fields 'error.code=OUTPUT_AUTHORITY_CHANGED'
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

# Author canonical synthetic media inside the service namespace, then export
# through the installed caller wrapper. No caller directory is bind-mounted.
preview_fixture="$(docker compose --project-name "$project_name" --profile maintenance run --rm --no-deps --no-TTY --entrypoint node operator-cli --input-type=module <<'JAVASCRIPT'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createLegacySidecarDataAccess } from './apps/operator-cli/node_modules/@rip-dvd/data-access/dist/legacy-sidecars.js';
import { loadConfig } from './apps/operator-cli/node_modules/@rip-dvd/config/dist/index.js';
const config = loadConfig();
const access = createLegacySidecarDataAccess({ databasePath: config.databasePath });
const drive = access.catalog.upsertOpticalDrive({ devicePath: '/dev/synthetic-preview-export', isPresent: true });
const disc = access.catalog.registerDetectedDisc({ opticalDriveId: drive.id, discKind: 'dvd', fingerprint: 'sha256:' + 'f'.repeat(64), volumeLabel: 'SYNTHETIC_PREVIEW_EXPORT', scanData: { schemaVersion: 2, contentId: 'sha256:' + 'f'.repeat(64), titles: [{ number: 1, durationSeconds: 1, chapters: 1, audioStreams: [], subtitles: [] }] } });
access.catalog.updateDetectedDiscStatus(disc.id, 'scanned');
access.catalog.updateDetectedDiscStatus(disc.id, 'approved');
const archive = access.catalog.createOriginalDiscArchive({ detectedDiscId: disc.id, discKind: 'dvd', archiveFormat: 'iso', archivePath: '/data/synthetic-preview.iso', fingerprint: disc.fingerprint });
const id = '11111111-2222-4333-8444-555555555555';
const identity = `damage-preview-v1.${id}.0`;
const path = '/data/synthetic-preview-export.mkv';
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=10', '-t', '1', '-c:v', 'ffv1', path], { stdio: 'pipe' });
const bytes = readFileSync(path);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const selection = { mode: 'ordinary_playback', titleIdentityObservationId: 'synthetic-observation', playbackRange: { startMilliseconds: 0, endMilliseconds: 1000 }, streams: { audio: [], subtitles: [] }, encodingProfileId: 'synthetic-profile' };
const checkpoint = { manifestId: 'synthetic-manifest', manifestRevision: 1, manifestDigest: 'f'.repeat(64), publicationDigest: 'f'.repeat(64) };
const record = { id, originalDiscArchiveId: archive.id, status: 'complete', preflightToken: 'synthetic-reviewed-token', selectionJson: JSON.stringify(selection), reviewJson: JSON.stringify({ reviewedRequest: { ...selection, checkpoint }, clips: [selection.playbackRange] }), workerId: null, cancellationRequested: false, reason: null, progress: { completedClips: 1, totalClips: 1, percent: 100 }, commands: [], toolVersions: { ffmpeg: 'synthetic-smoke' }, deviations: [], artifacts: [{ identity, path, sizeBytes: bytes.length, sha256, mediaType: 'video/x-matroska', coverage: selection.playbackRange, durationMilliseconds: 1000 }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const sqlite = new DatabaseSync(config.databasePath);
sqlite.prepare('INSERT INTO damage_previews (id, original_disc_archive_id, status, record, created_at) VALUES (?, ?, ?, ?, ?)').run(id, archive.id, record.status, JSON.stringify(record), Date.now());
sqlite.close(); access.close();
process.stdout.write(JSON.stringify({ identity, sha256, sizeBytes: bytes.length }));
JAVASCRIPT
)"
preview_identity="$(printf '%s' "$preview_fixture" | node -e 'let t="";for await(const c of process.stdin)t+=c;process.stdout.write(JSON.parse(t).identity)' --input-type=module)"
preview_export="$(invoke damage-preview export "$preview_identity" --destination "$temporary_directory/caller-preview.mkv")"
printf '%s\n' "$preview_export" | assert_json_fields \
  "artifactIdentity=$preview_identity" 'mediaType=video/x-matroska' \
  "path=$temporary_directory/caller-preview.mkv" 'preview.generationStatus=complete'
node --input-type=module - "$temporary_directory/caller-preview.mkv" "$preview_fixture" <<'JAVASCRIPT'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const media = readFileSync(process.argv[2]);
const expected = JSON.parse(process.argv[3]);
assert.equal(media.length, expected.sizeBytes);
assert.equal(createHash('sha256').update(media).digest('hex'), expected.sha256);
JAVASCRIPT
printf 'Canonical preview export to the executing caller passed.\n'

set +e
invalid_preview_export="$(invoke damage-preview export "$preview_identity" --destination "$temporary_directory/missing-parent/preview.mkv")"
invalid_preview_status=$?
set -e
[ "$invalid_preview_status" -eq 2 ]
printf '%s\n' "$invalid_preview_export" | assert_json_fields 'error.code=EXPORT_DESTINATION_UNAVAILABLE'

source_enqueue_help="$(invoke help encode-enqueue)"
source_requeue_help="$(invoke help encode-requeue)"
printf '%s\n%s\n' "$source_enqueue_help" "$source_requeue_help" | node --input-type=module -e '
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  for (const line of Buffer.concat(chunks).toString("utf8").trim().split("\n")) {
    const value = JSON.parse(line);
    if (!value.command.inputs.options.includes("--source-decision")) process.exit(1);
  }
'
set +e
invalid_source_decision="$(invoke encode-enqueue --key synthetic-source-decision \
  --disc-selection-id synthetic-selection --encoding-profile-id synthetic-profile \
  --output-path /media/movies/synthetic.mkv --source-decision '{')"
invalid_source_status=$?
set -e
[ "$invalid_source_status" -eq 2 ]
printf '%s\n' "$invalid_source_decision" | assert_json_fields 'error.code=INVALID_ARGUMENTS'
