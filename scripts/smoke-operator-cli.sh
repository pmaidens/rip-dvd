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
# Fixture writes must never inherit an operator's bind mounts or local overlays.
export COMPOSE_FILE="$repository_root/compose.yaml"
export RIP_DVD_MEDIA_LIBRARY_HOST_PATH=rip-dvd-media
export RIP_DVD_ORIGINALS_LIBRARY_HOST_PATH=rip-dvd-originals
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
failed_inspection="$(invoke encode-output inspect \
  encode-output-v1.failed.00000000-0000-4000-8000-000000000000 \
  2>"$temporary_directory/failed-inspection.stderr")"
failed_inspection_status=$?
set -e
[ "$failed_inspection_status" -eq 2 ]
printf '%s\n' "$failed_inspection" | assert_json_fields 'error.code=ENCODE_OUTPUT_NOT_FOUND'
set +e
keep_preflight="$(invoke encode-output keep-preflight \
  encode-output-v1.failed.00000000-0000-4000-8000-000000000000 \
  2>"$temporary_directory/keep-preflight.stderr")"
keep_preflight_status=$?
set -e
[ "$keep_preflight_status" -eq 2 ]
printf '%s\n' "$keep_preflight" | assert_json_fields 'error.code=ENCODE_OUTPUT_NOT_FOUND'
set +e
keep_output="$(invoke encode-output keep \
  encode-output-v1.failed.00000000-0000-4000-8000-000000000000 \
  --key synthetic-smoke-keep \
  --json '{"validationIdentity":"00000000-0000-4000-8000-000000000000","previewToken":"encode-output-keep-preview-v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","acknowledged":true}' \
  2>"$temporary_directory/keep.stderr")"
keep_status=$?
set -e
[ "$keep_status" -eq 2 ]
printf '%s\n' "$keep_output" | assert_json_fields 'error.code=OUTPUT_AUTHORITY_CHANGED' 'error.current=null'
set +e
preview_output="$(invoke damage-preview availability synthetic-missing-archive \
  2>"$temporary_directory/preview.stderr")"
preview_status=$?
set -e
[ "$preview_status" -eq 2 ]
printf '%s\n' "$preview_output" | assert_json_fields 'error.code=NOT_FOUND'

for action in delete cleanup; do
  set +e
  removal_output="$(invoke damage-preview "$action" synthetic-missing-request \
    --key "synthetic-smoke-$action" --json '{"mediaToken":"synthetic-reviewed-media"}' \
    2>"$temporary_directory/preview-removal.stderr")"
  removal_status=$?
  set -e
  [ "$removal_status" -eq 2 ]
  printf '%s\n' "$removal_output" | assert_json_fields 'error.code=NOT_FOUND'
done

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
const record = { id, originalDiscArchiveId: archive.id, status: 'complete', preflightToken: 'synthetic-reviewed-token', selectionJson: JSON.stringify(selection), reviewJson: JSON.stringify({ reviewedRequest: { ...selection, originalDiscArchiveId: archive.id, archive: { fingerprint: archive.fingerprint, path: archive.archivePath, catalogRevision: archive.updatedAt.toISOString() }, recovery: null, title: null, sourceTitle: null, encodingProfile: null, checkpoint }, clips: [selection.playbackRange] }), workerId: null, cancellationRequested: false, reason: null, progress: { completedClips: 1, totalClips: 1, percent: 100 }, commands: [], toolVersions: { ffmpeg: 'synthetic-smoke' }, deviations: [], artifacts: [{ identity, path, sizeBytes: bytes.length, sha256, mediaType: 'video/x-matroska', coverage: selection.playbackRange, durationMilliseconds: 1000 }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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

# The writer role authors one synthetic current failure in this project's own
# media volume. The CLI keeps its production read-only media mount throughout.
docker compose --project-name "$project_name" --profile maintenance build encode-worker
encode_fixture="$(docker compose --project-name "$project_name" --profile maintenance run --rm --no-deps --no-TTY \
  --user 0:0 --env RIP_DVD_SYNTHETIC_KEEP_FIXTURE=1 --entrypoint node encode-worker --input-type=module <<'JAVASCRIPT'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chownSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLegacySidecarDataAccess } from './apps/encode-worker/node_modules/@rip-dvd/data-access/dist/legacy-sidecars.js';
import { encodeOutputFilesystemIdentity } from './apps/encode-worker/node_modules/@rip-dvd/data-access/dist/index.js';
import { loadConfig } from './apps/encode-worker/node_modules/@rip-dvd/config/dist/index.js';
assert.equal(process.env.RIP_DVD_SYNTHETIC_KEEP_FIXTURE, '1');
const config = loadConfig();
assert.equal(config.mediaLibraryPath, '/media/movies');
// A CLI-first empty named volume can begin root-owned. Prepare only this
// isolated volume root, then author all fixture evidence as the runtime user.
chownSync(config.mediaLibraryPath, 1000, 1000);
process.setgid(1000); process.setuid(1000);
assert.equal(process.getuid(), 1000);
const access = createLegacySidecarDataAccess(config);
try {
  const drive = access.catalog.upsertOpticalDrive({ devicePath: '/dev/synthetic-installed-keep', isPresent: true });
  const fingerprint = 'sha256:' + 'c'.repeat(64);
  const disc = access.catalog.registerDetectedDisc({ opticalDriveId: drive.id, discKind: 'dvd', fingerprint,
    volumeLabel: 'SYNTHETIC_INSTALLED_KEEP', scanData: { schemaVersion: 2, contentId: fingerprint,
      titles: [{ number: 1, durationSeconds: 500, chapters: 1, audioStreams: [], subtitles: [] }] } });
  access.catalog.updateDetectedDiscStatus(disc.id, 'scanned');
  access.catalog.updateDetectedDiscStatus(disc.id, 'approved');
  const archive = access.catalog.createOriginalDiscArchive({ detectedDiscId: disc.id, discKind: 'dvd', archiveFormat: 'iso',
    archivePath: '/media/originals/synthetic-installed-keep.iso', fingerprint });
  const item = access.catalog.createMediaItem({ kind: 'movie', title: 'Synthetic installed Keep fixture' });
  const selection = access.catalog.createDiscSelection({ originalDiscArchiveId: archive.id, mediaItemId: item.id,
    sourceIdentity: { kind: 'dvd_title', titleNumber: 1 } });
  access.catalog.completeCatalogReview(archive.id,
    access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0].updatedAt, 'reviewed_with_selections');
  const profile = access.encodingProfiles.create({ key: 'synthetic-installed-keep', displayName: 'Synthetic installed Keep',
    mediaDomain: 'dvd_video', settings: { preset: 'Fast 480p30' } });
  const normalPath = join(config.mediaLibraryPath, 'synthetic-installed-normal.mkv');
  const job = access.encodeJobs.enqueue({ discSelectionId: selection.id, encodingProfileId: profile.id, outputPath: normalPath });
  const claim = access.encodeJobs.claimNext('synthetic-installed-keep-worker');
  assert.equal(claim?.id, job.id);
  const path = join(config.mediaLibraryPath, `synthetic-installed-failed-${claim.claimToken}.mkv`);
  const bytes = Buffer.from('synthetic complete failed encode');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  for (const target of [path, config.mediaLibraryPath]) {
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  const metadata = lstatSync(path);
  access.encodeJobs.retainValidationFailedOutput(claim, { outputPath: path, filesystemIdentity: encodeOutputFilesystemIdentity(metadata),
    changeTimeMs: metadata.ctimeMs, failure: { schemaVersion: 1, reasonCode: 'output_validation_failed', phase: 'validation',
      retryability: 'after_action', diagnostic: 'Synthetic complete output failed duration validation.',
      evidence: { kind: 'duration', expectedSeconds: 500, observedSeconds: 10 } } }, { preserveReplacementAuthority: false });
  const failed = access.encodeJobs.listValidationFailedOutputs(job.id, { limit: 1 })[0];
  assert.equal(access.encodeJobs.find(job.id).status, 'failed'); assert.equal(existsSync(normalPath), false);
  process.stdout.write(JSON.stringify({ identity: `encode-output-v1.failed.${failed.id}`, validationIdentity: failed.id,
    jobId: job.id, sourceIdentity: failed.filesystemIdentity, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
} finally { access.close(); }
JAVASCRIPT
)"
encode_mount_proof="$(docker compose --project-name "$project_name" --profile maintenance run --rm --no-deps --no-TTY \
  --env RIP_DVD_SYNTHETIC_KEEP_FIXTURE=1 --entrypoint node operator-cli --input-type=module <<'JAVASCRIPT'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './apps/operator-cli/node_modules/@rip-dvd/config/dist/index.js';
assert.equal(process.env.RIP_DVD_SYNTHETIC_KEEP_FIXTURE, '1'); assert.equal(process.getuid(), 1000);
const config = loadConfig(), suffix = randomUUID();
const mediaProbe = join(config.mediaLibraryPath, `.synthetic-keep-ro-${suffix}`);
let code;
try { writeFileSync(mediaProbe, 'synthetic', { flag: 'wx', mode: 0o600 }); unlinkSync(mediaProbe); }
catch (error) { code = error.code; }
assert.equal(code, 'EROFS');
const dataProbe = join(dirname(config.databasePath), `.synthetic-keep-rw-${suffix}`);
writeFileSync(dataProbe, 'synthetic', { flag: 'wx', mode: 0o600 }); unlinkSync(dataProbe);
process.stdout.write(JSON.stringify({ readOnlyMedia: true, writableData: true, effectiveUid: process.getuid() }));
JAVASCRIPT
)"
printf '%s\n' "$encode_mount_proof" | assert_json_fields 'readOnlyMedia=true' 'writableData=true' 'effectiveUid=1000'
encode_identity="$(printf '%s' "$encode_fixture" | node --input-type=module -e 'let t="";for await(const c of process.stdin)t+=c;process.stdout.write(JSON.parse(t).identity)')"
encode_inspected="$(invoke encode-output inspect "$encode_identity")"
printf '%s\n' "$encode_inspected" | assert_json_fields \
  "artifact.identity=$encode_identity" 'artifact.state=validation_failed' 'artifact.encodeJob.status=failed' 'operatorInspection.status=not_acknowledged'
encode_preview="$(invoke encode-output keep-preflight "$encode_identity")"
encode_review="$(node --input-type=module - "$encode_fixture" "$encode_preview" <<'JAVASCRIPT'
import assert from 'node:assert/strict';
const expected = JSON.parse(process.argv[2]), preview = JSON.parse(process.argv[3]);
assert.equal(preview.eligible, true); assert.deepEqual(preview.blockers, []);
assert.equal(preview.current.artifactIdentity, expected.identity);
assert.equal(preview.current.validationIdentity, expected.validationIdentity);
assert.equal(preview.current.fileIdentity, expected.sourceIdentity);
assert.equal(preview.completeWrite.sha256, expected.sha256);
assert.equal(preview.normalDestination.status, 'absent'); assert.equal(preview.normalDestination.normalOutput, null);
process.stdout.write(JSON.stringify({ validationIdentity: expected.validationIdentity, previewToken: preview.previewToken, acknowledged: true }));
JAVASCRIPT
)"
encode_kept="$(invoke encode-output keep "$encode_identity" --key synthetic-installed-keep --json "$encode_review")"
encode_replay="$(invoke encode-output keep "$encode_identity" --key synthetic-installed-keep --json "$encode_review")"
node --input-type=module - "$encode_kept" "$encode_replay" "$encode_fixture" <<'JAVASCRIPT'
import assert from 'node:assert/strict';
const kept = JSON.parse(process.argv[2]), replay = JSON.parse(process.argv[3]), expected = JSON.parse(process.argv[4]);
assert.deepEqual(replay, kept); assert.equal(kept.kept.artifactIdentity, expected.identity);
assert.equal(kept.kept.validationIdentity, expected.validationIdentity);
JAVASCRIPT
encode_stale_review="$(printf '%s' "$encode_review" | node --input-type=module -e 'let t="";for await(const c of process.stdin)t+=c;process.stdout.write(JSON.stringify({...JSON.parse(t),validationIdentity:"00000000-0000-4000-8000-000000000000"}))')"
set +e
encode_stale="$(invoke encode-output keep "$encode_identity" --key synthetic-installed-stale --json "$encode_stale_review")"
encode_stale_status=$?
set -e
[ "$encode_stale_status" -eq 2 ]
printf '%s\n' "$encode_stale" | assert_json_fields 'error.code=OUTPUT_VALIDATION_CHANGED'
encode_export="$(invoke encode-output export "$encode_identity" --destination "$temporary_directory/caller-encode.mkv")"
node --input-type=module - "$temporary_directory/caller-encode.mkv" "$encode_fixture" "$encode_export" <<'JAVASCRIPT'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
const expected = JSON.parse(process.argv[3]), exported = JSON.parse(process.argv[4]);
const bytes = readFileSync(process.argv[2]);
assert.equal(exported.artifact.identity, expected.identity); assert.equal(exported.artifact.type, 'canonical_encode_output');
assert.equal(exported.artifact.state, 'validation_failed'); assert.equal(exported.destination, process.argv[2]);
assert.equal(exported.provenance.encodeJobId, expected.jobId); assert.equal(exported.byteSize, expected.byteSize);
assert.equal(exported.sourceIdentity, expected.sourceIdentity);
assert.equal(bytes.length, expected.byteSize); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
assert.equal(statSync(process.argv[2]).mode & 0o777, 0o600);
JAVASCRIPT
encode_after="$(invoke encode-output inspect "$encode_identity")"
node --input-type=module - "$encode_after" "$encode_kept" <<'JAVASCRIPT'
import assert from 'node:assert/strict';
const inspected = JSON.parse(process.argv[2]), kept = JSON.parse(process.argv[3]);
assert.equal(inspected.kept.id, kept.kept.id); assert.equal(inspected.artifact.encodeJob.status, 'failed');
assert.equal(inspected.operatorInspection.status, 'not_acknowledged'); assert.deepEqual(inspected.operatorInspection.receipts, []);
JAVASCRIPT
printf 'Installed CLI Keep, replay, stale rejection and canonical caller export passed.\n'
