import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("canonical preview export publishes caller bytes across filesystems without a caller bind mount", { skip: process.platform !== "linux" || !existsSync("/dev/shm") }, () => {
  const root = mkdtempSync(join(tmpdir(), "preview-caller-"));
  const staging = mkdtempSync("/dev/shm/preview-other-filesystem-");
  try {
    assert.notEqual(statSync(root).dev, statSync(staging).dev);
    const bin = join(root, "bin"); mkdirSync(bin);
    const source = join(root, "remote.mkv");
    const expected = Buffer.from([...Buffer.from("synthetic canonical service bytes"), 0, 1, 2]); writeFileSync(source, expected);
    const docker = join(bin, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
import { copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'compose') {
  if (args.includes('--volume')) process.exit(9);
  const environment = args[args.indexOf('--env') + 1];
  const path = environment.slice('RIP_DVD_EXPORT_CALLER_PATH='.length);
  process.stdout.write(JSON.stringify({ artifactIdentity: 'damage-preview-v1.synthetic.0', mediaType: 'video/x-matroska', path, sizeBytes: ${expected.length}, provenance: { fixture: 'synthetic-service' } }));
} else if (args[0] === 'cp') copyFileSync(process.env.PREVIEW_TEST_SERVICE_FILE, args[2]);
else if (args[0] !== 'rm') process.exit(8);
`);
    chmodSync(docker, 0o755);
    const destination = join(root, "caller selected.mkv");
    const result = spawnSync(resolve("rip-dvd"), ["damage-preview", "export", "damage-preview-v1.synthetic.0", "--destination", destination], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: staging, PREVIEW_TEST_SERVICE_FILE: source },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).path, destination);
    assert.deepEqual(readFileSync(destination), expected);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".rip-dvd-preview-export")), []);
    const duplicate = spawnSync(resolve("rip-dvd"), ["damage-preview", "export", "damage-preview-v1.synthetic.0", "--destination", destination], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(duplicate.status, 2);
    assert.equal(JSON.parse(duplicate.stdout).error.code, "EXPORT_DESTINATION_EXISTS");
    assert.deepEqual(readFileSync(destination), expected);
    const invalid = spawnSync(resolve("rip-dvd"), ["damage-preview", "export", "damage-preview-v1.synthetic.0", "--destination", join(root, "missing-parent", "preview.mkv")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stdout).error.code, "EXPORT_DESTINATION_UNAVAILABLE");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); }
});
