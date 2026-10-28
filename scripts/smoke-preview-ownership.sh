#!/bin/sh
set -eu
: "${RIP_DVD_PREVIEW_TEST_IMAGE:?Build the current worker-runtime source and set RIP_DVD_PREVIEW_TEST_IMAGE}"
namespace="rip-dvd-preview-ownership-$$"
volume="$namespace-data"
cleanup() {
  docker rm --force "$namespace-owner" "$namespace-first" "$namespace-second" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker volume create "$volume" >/dev/null
docker run --rm --interactive --user 0:0 --workdir /app --volume "$volume:/shared" --entrypoint node "$RIP_DVD_PREVIEW_TEST_IMAGE" --input-type=module <<'JAVASCRIPT'
import { writeFileSync } from 'node:fs';
import { createArchiveImageOwnership, inspectLinuxStorage } from './packages/worker-runtime/dist/index.js';
if (inspectLinuxStorage('/shared').filesystemType !== 'ext') throw new Error('This smoke requires the declared local ext storage provider');
const ownership = createArchiveImageOwnership({ authorityRootPath: '/shared' });
writeFileSync('/shared/source.iso', Buffer.alloc(2048));
await ownership.withInitialPublicationWriter({ archiveId: 'synthetic-preview-namespace', imagePath: '/shared/source.iso', originalsLibraryPath: '/shared', signal: new AbortController().signal, async task() {} });
writeFileSync('/shared/run.mjs', `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireKernelProcessLock, inspectKernelProcessLock, createArchiveImageOwnership } from '/app/packages/worker-runtime/dist/index.js';
const role = process.argv[2];
const worker = role === 'owner' ? acquireKernelProcessLock('/shared/workers/execution.lock') : null;
if (role !== 'owner' && inspectKernelProcessLock('/shared/workers/execution.lock') !== 'held') throw new Error('Other PID namespace lost worker liveness');
const ownership = createArchiveImageOwnership({ authorityRootPath: '/shared' });
await ownership.withConsistentRead({ archiveId: 'synthetic-preview-namespace', imagePath: '/shared/source.iso', originalsLibraryPath: '/shared', signal: new AbortController().signal,
  ...(role === 'owner' ? { previewRead: { onContention(urgent, waiting) { if (waiting) writeFileSync('/shared/contention', 'waiting'); } } } : {}),
  async task() { writeFileSync('/shared/' + role + '.acquired', String(process.pid)); while (!existsSync('/shared/' + role + '.release')) await delay(10); }
});
worker?.release();
`);
JAVASCRIPT
start() {
  docker run --detach --user 0:0 --workdir /app --name "$namespace-$1" --volume "$volume:/shared" --entrypoint node "$RIP_DVD_PREVIEW_TEST_IMAGE" /shared/run.mjs "$1" >/dev/null
}
check() {
  docker exec "$namespace-owner" node --input-type=module -e "$1"
}
wait_check() {
  attempt=0
  until check "$1" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || { docker logs "$namespace-owner"; docker logs "$namespace-first" 2>/dev/null || true; exit 1; }
    sleep 0.1
  done
}
queue_count="import { readdirSync, readFileSync } from 'node:fs'; const p='/shared/.rip-dvd-archive-ownership'; const n=readdirSync(p).find(n=>n.endsWith('.lock.admission')); const q=JSON.parse(readFileSync(p+'/'+n+'/queue.json'));"
start owner
wait_check "import{existsSync}from'node:fs';if(!existsSync('/shared/owner.acquired'))process.exit(1)"
start first
wait_check "$queue_count if(q.length!==2)process.exit(1)"
start second
wait_check "$queue_count if(q.length!==3)process.exit(1)"
wait_check "import{existsSync}from'node:fs';if(!existsSync('/shared/contention')||existsSync('/shared/first.acquired')||existsSync('/shared/second.acquired'))process.exit(1)"
check "import{writeFileSync}from'node:fs';writeFileSync('/shared/owner.release','release')"
[ "$(docker wait "$namespace-owner")" -eq 0 ]
# The owner container has exited; use the first waiter for subsequent probes.
waiter_attempt=0
until docker exec "$namespace-first" node --input-type=module -e "import{existsSync}from'node:fs';if(!existsSync('/shared/first.acquired')||existsSync('/shared/second.acquired'))process.exit(1)"; do
  waiter_attempt=$((waiter_attempt + 1)); [ "$waiter_attempt" -lt 100 ]; sleep 0.1
done
docker exec "$namespace-first" node --input-type=module -e "import{writeFileSync}from'node:fs';writeFileSync('/shared/first.release','release')"
[ "$(docker wait "$namespace-first")" -eq 0 ]
docker exec "$namespace-second" node --input-type=module -e "import{writeFileSync}from'node:fs';writeFileSync('/shared/second.release','release')"
[ "$(docker wait "$namespace-second")" -eq 0 ]
printf 'Preview ownership, worker liveness, contention and FIFO passed across container PID namespaces.\n'
