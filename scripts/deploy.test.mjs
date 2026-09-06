import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyReview, sanitizeText } from "./deploy.mjs";

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
});

describe("deployment output privacy", () => {
  it("redacts secrets, private media paths, credentials, and private keys", () => {
    const sanitized = sanitizeText(
      [
        "TOKEN=plain-secret",
        "https://user:password@example.test/path",
        "/media/movies/Private Title/movie.mkv",
        "/mnt/sandisk/rip-dvd/originals/private.iso",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "secret-body",
        "-----END OPENSSH PRIVATE KEY-----",
      ].join("\n"),
    );

    assert.doesNotMatch(sanitized, /plain-secret|password|Private Title|private\.iso|secret-body/u);
    assert.match(sanitized, /TOKEN=\[REDACTED\]/u);
    assert.match(sanitized, /\[REDACTED_MEDIA_PATH\]/u);
    assert.match(sanitized, /\[REDACTED PRIVATE KEY\]/u);
  });
});
