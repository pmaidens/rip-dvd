import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { classifyReview, sanitizeText } from "./deploy.mjs";
import { buildReviewBundle } from "./deploy-review.mjs";
import { acquireLock, emitResult } from "./deploy-state.mjs";
import { createStreamSanitizer, runCheckedSync } from "./deploy-support.mjs";

describe("deployment review classifier", () => {
  it("requires review for migrations and schema changes without migrations", () => {
    assert.deepEqual(
      classifyReview(
        [{ status: "M", path: "packages/data-access/drizzle/0021_state.sql" }],
        "",
      ),
      ["migration"],
    );
    assert.deepEqual(
      classifyReview(
        [{ status: "M", path: "packages/data-access/src/schema.ts" }],
        "",
      ),
      ["schema_without_migration"],
    );
  });

  it("classifies Compose hardware, volume, and required environment changes", () => {
    const reasons = classifyReview(
      [{ status: "M", path: "compose.yaml" }],
      [
        "+    devices:",
        "+      - /dev/sr1:/dev/sr1:r",
        "+    volumes:",
        "+      - archive:/media/originals",
        "+    API_TOKEN: ${API_TOKEN:?required}",
      ].join("\n"),
    );

    assert.deepEqual(reasons, [
      "compose_change",
      "compose_volumes_or_devices",
      "optical_drive_identity_policy",
      "required_environment",
    ]);
  });

  it("classifies build, dependency, deployment, and drive policy changes", () => {
    const reasons = classifyReview(
      [
        { status: "M", path: "docker/runtime.Dockerfile" },
        { status: "M", path: "pnpm-lock.yaml" },
        { status: "M", path: "scripts/update.sh" },
        { status: "M", path: "scripts/optical-drive-mapping.mjs" },
      ],
      "",
    );

    assert.deepEqual(reasons, [
      "dependency_lockfile",
      "deployment_or_recovery",
      "dockerfile",
      "optical_drive_identity_policy",
    ]);
  });

  it("classifies runtime configuration loader changes", () => {
    assert.deepEqual(
      classifyReview(
        [{ status: "M", path: "packages/config/src/index.ts" }],
        '+const value = requiredValue(environment, "NEW_REQUIRED");',
      ),
      ["required_environment"],
    );
  });

  it("classifies Docker build-control inputs", () => {
    const files = [
      { status: "M", path: "package.json" },
      { status: "M", path: "apps/web/package.json" },
      { status: "M", path: "pnpm-workspace.yaml" },
      { status: "M", path: ".node-version" },
      { status: "M", path: "tsconfig.base.json" },
    ];

    assert.deepEqual(classifyReview(files, ""), ["docker_build_input"]);
  });

  it("keeps the persisted review bundle within its byte limit", () => {
    const longName = "x".repeat(1100);
    const files = Array.from(
      { length: 50 },
      (_, index) => ({ status: "M", path: `apps/web/${index}-${longName}.ts` }),
    );
    const commits = Array.from(
      { length: 20 },
      (_, index) => ({ sha: String(index).padStart(40, "0"), subject: longName }),
    );

    const bundle = buildReviewBundle("1".repeat(40), "2".repeat(40), commits, files, "");

    assert.ok(Buffer.byteLength(`${JSON.stringify(bundle, null, 2)}\n`) <= 48 * 1024);
    assert.equal(bundle.reviewRequired, true);
    assert.ok(bundle.reasons.includes("review_bundle_limit_exceeded"));
    assert.equal(bundle.limits.exceeded.representation, true);
  });

  it("marks incomplete Git inventory for mandatory review", () => {
    const bundle = buildReviewBundle(
      "1".repeat(40),
      "2".repeat(40),
      [],
      [],
      "",
      { inventoryIncomplete: true },
    );
    assert.equal(bundle.reviewRequired, true);
    assert.ok(bundle.reasons.includes("git_inventory_incomplete"));

    const result = runCheckedSync(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(1_100_000))",
    ]);
    assert.equal(result.stdoutTruncated, true);
  });

  it("redacts multiword secrets from review bundles", () => {
    const bundle = buildReviewBundle(
      "1".repeat(40),
      "2".repeat(40),
      [],
      [{ status: "M", path: "package.json" }],
      "+password: correct horse battery staple\n",
    );

    assert.ok(bundle.reasons.includes("docker_build_input"));
    assert.doesNotMatch(bundle.relevantDiff, /correct horse|battery staple/u);
  });
});

describe("deployment output privacy", () => {
  it("redacts secrets, private media paths, credentials, and private keys", () => {
    const sanitized = sanitizeText(
      [
        "TOKEN=plain secret with spaces",
        "PUBLIC_ORIGIN=https://private-host.example",
        '{"token":"json-secret","password":"hunter2"}',
        "Authorization: Bearer bearer-secret",
        "Authorization: Basic basic-secret",
        "password: colon password with spaces",
        "token: colon-token",
        "api-key: colon-api-key",
        "https://user:password@example.test/path",
        "/media/movies/Private Title/movie.mkv",
        "/mnt/sandisk/rip-dvd/originals/private.iso",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "secret-body",
        "-----END OPENSSH PRIVATE KEY-----",
      ].join("\n"),
    );

    assert.doesNotMatch(sanitized, /plain secret|secret with spaces|private-host|json-secret|hunter2|bearer-secret|basic-secret|colon password|password with spaces|colon-token|colon-api-key|Private Title|private\.iso|secret-body/u);
    assert.match(sanitized, /TOKEN=\[REDACTED\]/u);
    assert.match(sanitized, /\[REDACTED_MEDIA_PATH\]/u);
    assert.match(sanitized, /\[REDACTED PRIVATE KEY\]/u);
  });

  it("redacts private keys split across streaming chunks", () => {
    let output = "";
    const sanitizer = createStreamSanitizer((text) => { output += text; });

    sanitizer.write("safe before\n-----BEGIN OPENSSH PRI");
    sanitizer.write("VATE KEY-----\nsecret-");
    sanitizer.write("body\n-----END OPENSSH PRIVATE KEY-----\nsafe after\n");
    sanitizer.flush();

    assert.equal(output, "safe before\n[REDACTED PRIVATE KEY]\nsafe after\n");
  });

  it("redacts colon-delimited credentials split across streaming chunks", () => {
    let output = "";
    const sanitizer = createStreamSanitizer((text) => { output += text; });

    sanitizer.write("password: stream secret with ");
    sanitizer.write("spaces\nAuthorization: Basic basic-secret\n");
    sanitizer.flush();

    assert.doesNotMatch(output, /stream secret|secret with spaces|basic-secret/u);
    assert.match(output, /password: \[REDACTED\]/u);
  });

  it("redacts sensitive structured-result fields", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "rip-dvd-deploy-result-"));
    const previousDirectory = process.env.RIP_DVD_DEPLOY_STATE_DIR;
    process.env.RIP_DVD_DEPLOY_STATE_DIR = directory;
    try {
      emitResult({
        command: "test",
        state: "validation_failure",
        details: {
          password: "structured-password",
          nested: { apiToken: "structured-token" },
        },
      });
      const persisted = readFileSync(resolve(directory, "last-result.json"), "utf8");
      assert.doesNotMatch(persisted, /structured-password|structured-token/u);
      assert.match(persisted, /\[REDACTED\]/u);
    } finally {
      if (previousDirectory === undefined) {
        delete process.env.RIP_DVD_DEPLOY_STATE_DIR;
      } else {
        process.env.RIP_DVD_DEPLOY_STATE_DIR = previousDirectory;
      }
      rmSync(directory, { recursive: true });
    }
  });

  it("redacts private keys and configured paths before truncation", () => {
    const privateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "sensitive-body".repeat(100),
      "-----END OPENSSH PRIVATE KEY-----",
      "/srv/private-library/movie.iso",
    ].join("\n");
    const sanitized = sanitizeText(privateKey, 100, ["/srv/private-library"]);

    assert.doesNotMatch(sanitized, /sensitive-body|\/srv\/private-library/u);
    assert.match(sanitized, /\[REDACTED_MEDIA_PATH\]/u);
  });
});

describe("deployment locking", () => {
  it("does not release a lock whose ownership changed", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "rip-dvd-deploy-lock-"));
    const previousDirectory = process.env.RIP_DVD_DEPLOY_STATE_DIR;
    const previousPath = process.env.PATH;
    const commands = resolve(directory, "commands");
    mkdirSync(commands);
    const flock = resolve(commands, "flock");
    writeFileSync(flock, "#!/bin/sh\nprintf 'RIP_DVD_LOCKED\\n'\ncat >/dev/null\n");
    chmodSync(flock, 0o755);
    process.env.RIP_DVD_DEPLOY_STATE_DIR = directory;
    process.env.PATH = `${commands}:${previousPath}`;
    try {
      const release = await acquireLock("original-run");
      const owner = resolve(directory, "run.lock.owner.json");
      writeFileSync(owner, '{"pid":999999,"runId":"replacement-run"}\n');

      await assert.rejects(release, /ownership changed/u);
      assert.equal(existsSync(owner), true);
    } finally {
      if (previousDirectory === undefined) {
        delete process.env.RIP_DVD_DEPLOY_STATE_DIR;
      } else {
        process.env.RIP_DVD_DEPLOY_STATE_DIR = previousDirectory;
      }
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true });
    }
  });
});
