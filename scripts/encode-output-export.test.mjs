import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const identity = "encode-output-v1.failed.00000000-0000-4000-8000-000000000001";
const bytes = Buffer.from([...Buffer.from("synthetic canonical encode output"), 0, 1, 2, 255]);

function fixture(family = "encode-output") {
  const artifactIdentity = family === "encode-output" ? identity : "damage-preview-v1.synthetic.0";
  const kind = family === "encode-output" ? "output" : "preview";
  const root = mkdtempSync(join(tmpdir(), "encode-output-caller-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const source = join(root, "remote.mkv"); writeFileSync(source, bytes, { mode: 0o644 }); chmodSync(source, 0o644);
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.EXPORT_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'compose') {
  assert.deepEqual(args.slice(0, 6), ['compose', '--profile', 'maintenance', 'run', '--no-deps', '--no-TTY']);
  assert.equal(args[6], '--name');
  assert.match(args[7], /^rip-dvd-${kind}-export-/);
  assert.equal(args[8], '--label');
  assert.match(args[9], /^rip-dvd.export-owner=owner\.[a-zA-Z0-9]+$/);
  assert.equal(args[10], '--env');
  assert.match(args[11], /^RIP_DVD_EXPORT_CALLER_PATH=/);
  assert.deepEqual(args.slice(12), ['operator-cli', '${family}', 'export', '${artifactIdentity}', '--destination', '/tmp/rip-dvd-${kind}-export.mkv']);
  writeFileSync(process.env.EXPORT_TEST_CONTAINER, args[7]);
  writeFileSync(process.env.EXPORT_TEST_CONTAINER + '.owner', args[9].slice('rip-dvd.export-owner='.length));
  const destination = args[11].slice('RIP_DVD_EXPORT_CALLER_PATH='.length);
  const scenario = process.env.EXPORT_TEST_SCENARIO;
  if (scenario === 'container-name-conflict') process.exit(125);
  if (scenario === 'service-error') { process.stdout.write(JSON.stringify({ error: { code: 'OUTPUT_IDENTITY_CHANGED', message: 'Synthetic changed artifact' } })); process.exit(2); }
  if (scenario === 'service-empty') process.exit(1);
  if (scenario === 'destination-file') writeFileSync(destination, 'synthetic concurrent caller file');
  if (scenario === 'destination-directory') { const { mkdirSync } = await import('node:fs'); mkdirSync(destination); }
  if (scenario === 'destination-symlink') { const { symlinkSync } = await import('node:fs'); symlinkSync(process.env.EXPORT_TEST_SERVICE_FILE, destination); }
  if (process.env.EXPORT_TEST_ALIAS_RACE) {
    const { unlinkSync, symlinkSync } = await import('node:fs');
    unlinkSync(process.env.EXPORT_TEST_ALIAS_RACE); symlinkSync(process.env.EXPORT_TEST_ALIAS_TARGET, process.env.EXPORT_TEST_ALIAS_RACE);
  }
  if (process.env.EXPORT_TEST_PARENT_RACE) {
    const { renameSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    renameSync(dirname(destination), dirname(destination) + '.moved');
    mkdirSync(dirname(destination));
  }
  process.stdout.write(JSON.stringify('${family}' === 'encode-output'
    ? { schemaVersion: 1, artifact: { identity: '${artifactIdentity}', type: 'canonical_encode_output', state: 'validation_failed' }, byteSize: ${bytes.length}, destination, sourceIdentity: 'synthetic-file-identity', provenance: { encodeJobId: 'synthetic-job' } }
    : { artifactIdentity: '${artifactIdentity}', mediaType: 'video/x-matroska', path: destination, sizeBytes: ${bytes.length}, provenance: { fixture: 'synthetic-service' } }));
} else if (args[0] === 'cp') {
  const { readFileSync } = await import('node:fs');
  assert.equal(args.length, 3);
  assert.equal(args[1], '${"a".repeat(64)}:/tmp/rip-dvd-${kind}-export.mkv');
  if (process.env.EXPORT_TEST_SCENARIO === 'copy-failure') { writeFileSync(args[2], 'synthetic partial transfer'); process.exit(9); }
  if (process.env.EXPORT_TEST_SCENARIO === 'copy-symlink') { const { symlinkSync } = await import('node:fs'); symlinkSync(process.env.EXPORT_TEST_SERVICE_FILE, args[2]); }
  else copyFileSync(process.env.EXPORT_TEST_SERVICE_FILE, args[2]);
} else if (args[0] === 'inspect') {
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(args.slice(0, 3), ['inspect', '--format', '{{.Id}}:{{index .Config.Labels "rip-dvd.export-owner"}}']);
  assert.equal(args.length, 4);
  assert.ok([readFileSync(process.env.EXPORT_TEST_CONTAINER, 'utf8'), '${"a".repeat(64)}'].includes(args[3]));
  const owner = process.env.EXPORT_TEST_SCENARIO === 'container-name-conflict' ? 'synthetic-foreign-owner' : readFileSync(process.env.EXPORT_TEST_CONTAINER + '.owner', 'utf8');
  process.stdout.write('${"a".repeat(64)}:' + owner);
} else if (args[0] === 'rm') {
  assert.deepEqual(args, ['rm', '--force', '${"a".repeat(64)}']);
} else { throw new Error('Unexpected Docker test command'); }
`);
  chmodSync(docker, 0o755);
  const realLink = spawnSync("sh", ["-c", "command -v link"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realLink.startsWith("/"));
  const link = join(bin, "link");
  writeFileSync(link, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { renameSync, mkdirSync } from 'node:fs';
const result = spawnSync(${JSON.stringify(realLink)}, process.argv.slice(2), { stdio: 'inherit' });
if (result.status === 0 && process.env.EXPORT_TEST_AFTER_LINK_PARENT) {
  const parent = process.env.EXPORT_TEST_AFTER_LINK_PARENT;
  renameSync(parent, parent + '.moved'); mkdirSync(parent);
}
process.exit(result.status ?? 1);
`);
  chmodSync(link, 0o755);
  return { root, source, destination: join(root, "caller selected.mkv"),
    run(destination, environment = {}) {
      return spawnSync(resolve("rip-dvd"), [family, "export", artifactIdentity, "--destination", destination], {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
          EXPORT_TEST_LOG: join(root, "docker.jsonl"), EXPORT_TEST_CONTAINER: join(root, "container.txt"), EXPORT_TEST_SERVICE_FILE: source, ...environment },
      });
    },
    calls() {
      const path = join(root, "docker.jsonl");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
    stagingNames(directory = root) { return readdirSync(directory).filter((name) => name.startsWith(`.rip-dvd-${kind}-export`)); },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("installed Encode Output export transports canonical bytes and metadata to the caller without a caller bind mount", () => {
  const f = fixture();
  try {
    const result = f.run(f.destination);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.artifact.identity, identity);
    assert.equal(output.destination, f.destination);
    assert.equal(output.byteSize, bytes.length);
    assert.deepEqual(readFileSync(f.destination), bytes);
    assert.equal(createHash("sha256").update(readFileSync(f.destination)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assert.equal(statSync(f.destination).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.root).filter((name) => name.startsWith(".rip-dvd-output-export")), []);
  } finally { f.dispose(); }
});

test("Encode Output transport rejects a replaced destination parent and removes only its own staging data", () => {
  const f = fixture();
  const parent = join(f.root, "exports"); mkdirSync(parent);
  try {
    const destination = join(parent, "canonical.mkv");
    const result = f.run(destination, { EXPORT_TEST_PARENT_RACE: "1" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "EXPORT_TRANSFER_FAILED");
    assert.deepEqual(readdirSync(parent), []);
    assert.deepEqual(readdirSync(parent + ".moved"), []);
  } finally { f.dispose(); }
});

for (const family of ["encode-output", "damage-preview"]) {
  for (const existing of ["file", "directory", "symlink", "dangling-symlink"]) {
    test(`${family} export refuses an existing ${existing} before Docker and preserves it`, () => {
      const f = fixture(family);
      try {
        if (existing === "file") writeFileSync(f.destination, "synthetic existing caller file");
        if (existing === "directory") mkdirSync(f.destination);
        if (existing === "symlink") symlinkSync(f.source, f.destination);
        if (existing === "dangling-symlink") symlinkSync(join(f.root, "missing-target"), f.destination);
        const result = f.run(f.destination);
        assert.equal(result.status, 2);
        assert.equal(JSON.parse(result.stdout).error.code, "EXPORT_DESTINATION_EXISTS");
        assert.deepEqual(f.calls(), []);
        assert.deepEqual(readFileSync(f.source), bytes);
        if (existing.includes("symlink")) assert.equal(lstatSync(f.destination).isSymbolicLink(), true);
        if (existing === "file") assert.equal(readFileSync(f.destination, "utf8"), "synthetic existing caller file");
        if (existing === "directory") assert.deepEqual(readdirSync(f.destination), []);
      } finally { f.dispose(); }
    });
  }
  test(`${family} export refuses a missing parent without invoking Docker`, () => {
    const f = fixture(family);
    try {
      const result = f.run(join(f.root, "missing", "output.mkv"));
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stdout).error.code, "EXPORT_DESTINATION_UNAVAILABLE");
      assert.deepEqual(f.calls(), []);
    } finally { f.dispose(); }
  });
  for (const scenario of ["service-error", "service-empty", "copy-failure", "copy-symlink", "destination-file", "destination-directory", "destination-symlink"]) {
    test(`${family} export handles ${scenario} without clobbering caller data or leaking staging`, () => {
      const f = fixture(family);
      try {
        const result = f.run(f.destination, { EXPORT_TEST_SCENARIO: scenario });
        assert.equal(result.status, scenario === "service-error" ? 2 : 1);
        assert.equal(JSON.parse(result.stdout).error.code, scenario === "service-error" ? "OUTPUT_IDENTITY_CHANGED"
          : scenario === "service-empty" ? "EXPORT_SERVICE_UNAVAILABLE" : "EXPORT_TRANSFER_FAILED");
        assert.deepEqual(f.stagingNames(), []);
        assert.equal(f.calls().at(-1)[0], "rm");
        assert.deepEqual(readFileSync(f.source), bytes);
        assert.equal(statSync(f.source).mode & 0o777, 0o644);
        if (scenario === "destination-file") assert.equal(readFileSync(f.destination, "utf8"), "synthetic concurrent caller file");
        else if (scenario === "destination-directory") assert.deepEqual(readdirSync(f.destination), []);
        else if (scenario === "destination-symlink") assert.equal(lstatSync(f.destination).isSymbolicLink(), true);
        else assert.equal(existsSync(f.destination), false);
      } finally { f.dispose(); }
    });
  }
  test(`${family} export resolves a relative caller destination and preserves its response shape`, () => {
    const f = fixture(family);
    try {
      const relative = "relative caller.mkv";
      const result = f.run(relative);
      assert.equal(result.status, 0, result.stderr);
      const response = JSON.parse(result.stdout);
      assert.equal(response[family === "encode-output" ? "destination" : "path"], join(realpathSync(f.root), relative));
      assert.deepEqual(readFileSync(join(f.root, relative)), bytes);
      assert.equal(statSync(join(f.root, relative)).mode & 0o777, 0o600);
      assert.deepEqual(f.stagingNames(), []);
    } finally { f.dispose(); }
  });
}

for (const family of ["encode-output", "damage-preview"]) {
  test(`${family} export rolls back its own published link if the parent changes during publication`, () => {
    const f = fixture(family);
    const parent = join(f.root, "exports"); mkdirSync(parent);
    try {
      const result = f.run(join(parent, "canonical.mkv"), { EXPORT_TEST_AFTER_LINK_PARENT: parent });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, "EXPORT_TRANSFER_FAILED");
      assert.deepEqual(readdirSync(parent), []);
      assert.deepEqual(readdirSync(parent + ".moved"), []);
      assert.equal(f.calls().at(-1)[0], "rm");
    } finally { f.dispose(); }
  });
}

for (const family of ["encode-output", "damage-preview"]) {
  test(`${family} export rejects a retargeted parent symlink without deleting either directory's data`, () => {
    const f = fixture(family);
    const original = join(f.root, "original"); mkdirSync(original);
    const replacement = join(f.root, "replacement"); mkdirSync(replacement);
    const marker = join(replacement, "unrelated.txt"); writeFileSync(marker, "synthetic unrelated caller data");
    const alias = join(f.root, "parent-alias"); symlinkSync(original, alias);
    try {
      const result = f.run(join(alias, "canonical.mkv"), { EXPORT_TEST_ALIAS_RACE: alias, EXPORT_TEST_ALIAS_TARGET: replacement });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, "EXPORT_TRANSFER_FAILED");
      assert.deepEqual(readdirSync(original), []);
      assert.deepEqual(readdirSync(replacement), ["unrelated.txt"]);
      assert.equal(readFileSync(marker, "utf8"), "synthetic unrelated caller data");
      assert.equal(lstatSync(alias).isSymbolicLink(), true);
    } finally { f.dispose(); }
  });
}

for (const family of ["encode-output", "damage-preview"]) {
  test(`${family} transport never removes an existing container when its generated name conflicts`, () => {
    const f = fixture(family);
    try {
      const result = f.run(f.destination, { EXPORT_TEST_SCENARIO: "container-name-conflict" });
      assert.equal(result.status, 125);
      assert.equal(JSON.parse(result.stdout).error.code, "EXPORT_SERVICE_UNAVAILABLE");
      assert.equal(f.calls().some((args) => args[0] === "rm"), false);
      assert.equal(existsSync(f.destination), false);
      assert.deepEqual(f.stagingNames(), []);
    } finally { f.dispose(); }
  });
}
