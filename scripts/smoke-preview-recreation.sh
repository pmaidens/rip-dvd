#!/bin/sh
set -eu

# Run only after the coordinator grants the heavy lane and supplies current prebuilt images.
: "${RIP_DVD_RECREATION_VALIDATION_IMAGE:?Supply the validated current-source image}"
: "${RIP_DVD_RECREATION_CLI_IMAGE:?Supply the current-source operator-cli image}"
: "${RIP_DVD_RECREATION_WORKER_IMAGE:?Supply the current-source encode-worker image}"
script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/rip-dvd-recreation-smoke.XXXXXX")"
project_name="$(basename "$temporary_directory" | tr '[:upper:].' '[:lower:]-')"
export RIP_DVD_RECREATION_VALIDATION_IMAGE RIP_DVD_RECREATION_CLI_IMAGE RIP_DVD_RECREATION_WORKER_IMAGE
node --input-type=module - "$temporary_directory/compose.json" <<'JAVASCRIPT'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ services: {
  'operator-cli': { image: process.env.RIP_DVD_RECREATION_CLI_IMAGE, pull_policy: 'never' },
  'encode-worker': { image: process.env.RIP_DVD_RECREATION_WORKER_IMAGE, pull_policy: 'never' },
  validation: { image: process.env.RIP_DVD_RECREATION_VALIDATION_IMAGE, pull_policy: 'never', user: '1000:1000', working_dir: '/app/apps/web', network_mode: 'none',
    environment: { RIP_DVD_RECREATION_INSTALLED_FIXTURE: '1', RIP_DVD_DATABASE_PATH: '/data/rip-dvd.sqlite', RIP_DVD_MEDIA_LIBRARY_PATH: '/media/movies', RIP_DVD_ORIGINALS_LIBRARY_PATH: '/media/originals' },
    volumes: ['rip-dvd-data:/data', 'rip-dvd-media:/media/movies', 'rip-dvd-originals:/media/originals'] }
} }), { mode: 0o600 });
JAVASCRIPT
export COMPOSE_PROJECT_NAME="$project_name"
export COMPOSE_FILE="$repository_root/compose.yaml:$temporary_directory/compose.json"
export RIP_DVD_MEDIA_LIBRARY_HOST_PATH=rip-dvd-media
export RIP_DVD_ORIGINALS_LIBRARY_HOST_PATH=rip-dvd-originals
cleanup() {
  # This unique project owns every resource below; no image deletion or global cleanup.
  docker compose --profile maintenance --profile validation down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM
cd "$repository_root"
for image in "$RIP_DVD_RECREATION_VALIDATION_IMAGE" "$RIP_DVD_RECREATION_CLI_IMAGE" "$RIP_DVD_RECREATION_WORKER_IMAGE"; do docker image inspect "$image" >/dev/null; done
./install.sh --bin-dir "$temporary_directory/bin" >/dev/null
installed_cli="$temporary_directory/bin/rip-dvd"
"$installed_cli" health >/dev/null
# The sentinel is created only inside this smoke's owned synthetic volumes.
docker compose run --rm --no-deps --no-TTY --entrypoint node encode-worker --input-type=module <<'JAVASCRIPT'
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './apps/encode-worker/node_modules/@rip-dvd/config/dist/index.js';
const { databasePath, mediaLibraryPath, originalsLibraryPath } = loadConfig();
writeFileSync(join(dirname(databasePath), '.synthetic-recreation-authority.json'), JSON.stringify({ purpose: 'rip-dvd-synthetic-recreation', databasePath, mediaLibraryPath, originalsLibraryPath }), { flag: 'wx', mode: 0o600 });
JAVASCRIPT
docker compose --profile validation run --rm --no-deps --no-TTY validation \
  node /app/node_modules/vitest/vitest.mjs run 'app/api/damage-previews/[id]/recreate/installed-fixture.test.ts' --maxWorkers=1
fixture_path="$temporary_directory/fixture.json"
docker compose run --rm --no-deps --no-TTY --entrypoint node encode-worker --input-type=module -e \
  'import{readFileSync}from"node:fs";process.stdout.write(readFileSync("/data/synthetic-recreation-fixture.json","utf8"))' > "$fixture_path"
request_id="$(node --input-type=module -e 'import{readFileSync}from"node:fs";process.stdout.write(JSON.parse(readFileSync(process.argv[1],"utf8")).id)' "$fixture_path")"
state="$("$installed_cli" damage-preview inspect "$request_id")"
input="$(printf '%s' "$state" | node --input-type=module -e 'let t="";for await(const c of process.stdin)t+=c;process.stdout.write(JSON.stringify({mediaToken:JSON.parse(t).media.token}))')"
accepted="$("$installed_cli" damage-preview delete "$request_id" --key synthetic-installed-roundtrip-delete --json "$input")"
printf '%s' "$accepted" | node --input-type=module -e 'let t="";for await(const c of process.stdin)t+=c;if(JSON.parse(t).media.removal.state!=="pending")process.exit(1)'
docker compose up --no-build --pull never --detach --no-deps encode-worker
attempt=0
while [ "$attempt" -lt 30 ]; do
  state="$("$installed_cli" damage-preview inspect "$request_id")"
  if printf '%s' "$state" | node --input-type=module -e 'let t="";for await(const c of process.stdin)t+=c;if(JSON.parse(t).media.removal.state!=="complete")process.exit(1)'; then break; fi
  attempt=$((attempt + 1)); sleep 1
done
[ "$attempt" -lt 30 ]
docker compose stop --timeout 10 encode-worker
replayed="$("$installed_cli" damage-preview delete "$request_id" --key synthetic-installed-roundtrip-delete --json "$input")"
[ "$accepted" = "$replayed" ]
node scripts/validation/verify-preview-recreation-installed.mjs "$installed_cli" "$fixture_path"
