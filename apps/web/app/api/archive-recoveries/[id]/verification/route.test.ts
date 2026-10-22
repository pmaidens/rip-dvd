import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDvdDiscVerificationFixture } from "../../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import {
  createDvdDiscVerificationInspectionRoute,
  createDvdDiscVerificationRoute,
} from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

function request(id: string, body: unknown): Request {
  return new Request(
    `http://localhost:3000/api/archive-recoveries/${id}/verification`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    },
  );
}

it("keeps web inspection and replayed submission equal to the JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const access = fixture.openAccess();
  try {
    const webInspection = await createDvdDiscVerificationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    const cliInspection = await fixture.run([
      "archive-recovery",
      "inspect-verification",
      seeded.recoveryId,
    ]);
    expect(webInspection.status).toBe(200);
    expect(webInspection.headers.get("Cache-Control")).toBe("no-store");
    expect(await webInspection.json()).toEqual(cliInspection.result);

    const mutationKey = "00000000-0000-4000-8000-000000000441";
    const body = {
      mutationKey,
      discInspectionId: seeded.inspection.id,
      checkpointRevision: 1,
      checkpointDigest: seeded.manifest.manifestDigest,
    };
    const webSubmission = await createDvdDiscVerificationRoute(
      request(seeded.recoveryId, body),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cliReplay = await fixture.run([
      "archive-recovery",
      "verify-disc",
      seeded.recoveryId,
      "--key", mutationKey,
      "--disc-inspection-id", seeded.inspection.id,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", seeded.manifest.manifestDigest,
    ]);
    expect(webSubmission.status).toBe(201);
    expect(cliReplay.exitCode).toBe(0);
    expect(await webSubmission.json()).toEqual(cliReplay.result);

    const webConflict = await createDvdDiscVerificationRoute(
      request(seeded.recoveryId, {
        ...body,
        checkpointDigest: "f".repeat(64),
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cliConflict = await fixture.run([
      "archive-recovery", "verify-disc", seeded.recoveryId,
      "--key", mutationKey,
      "--disc-inspection-id", seeded.inspection.id,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", "f".repeat(64),
    ]);
    expect(webConflict.status).toBe(409);
    expect(await webConflict.json()).toEqual(cliConflict.result);
    expect(cliConflict.result).toMatchObject({
      error: { code: "MUTATION_KEY_CONFLICT" },
    });

    const activeMutationKey = "00000000-0000-4000-8000-000000000444";
    const webActive = await createDvdDiscVerificationRoute(
      request(seeded.recoveryId, {
        ...body,
        mutationKey: activeMutationKey,
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cliActive = await fixture.run([
      "archive-recovery",
      "verify-disc",
      seeded.recoveryId,
      "--key", activeMutationKey,
      "--disc-inspection-id", seeded.inspection.id,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", seeded.manifest.manifestDigest,
    ]);
    expect(webActive.status).toBe(409);
    expect(cliActive.exitCode).toBe(2);
    expect(await webActive.json()).toEqual(cliActive.result);
  } finally {
    access.close();
  }
});

it("keeps validation, not-found, and unavailable failures structured", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const access = fixture.openAccess();
  try {
    const missingWeb = await createDvdDiscVerificationInspectionRoute(
      "missing-recovery",
      () => access,
    );
    const missingCli = await fixture.run([
      "archive-recovery",
      "inspect-verification",
      "missing-recovery",
    ]);
    expect(missingWeb.status).toBe(404);
    expect(await missingWeb.json()).toEqual(missingCli.result);

    const invalid = await createDvdDiscVerificationRoute(
      request("missing-recovery", null),
      "missing-recovery",
      () => access,
      () => "http://localhost:3000",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: "INVALID_ARGUMENTS",
        message: "DVD Disc Verification requires the current insertion and checkpoint binding.",
      },
    });

    const missingIdentityWeb = await createDvdDiscVerificationRoute(
      request("missing-recovery", {
        mutationKey: "00000000-0000-4000-8000-000000000449",
        checkpointRevision: 1,
        checkpointDigest: "f".repeat(64),
      }),
      "missing-recovery",
      () => access,
      () => "http://localhost:3000",
    );
    const missingIdentityCli = await fixture.run([
      "archive-recovery",
      "verify-disc",
      "missing-recovery",
      "--key", "00000000-0000-4000-8000-000000000449",
      "--checkpoint-revision", "1",
      "--checkpoint-digest", "f".repeat(64),
    ]);
    expect(missingIdentityWeb.status).toBe(400);
    expect(await missingIdentityWeb.json()).toEqual(missingIdentityCli.result);

    const invalidKeyWeb = await createDvdDiscVerificationRoute(
      request("missing-recovery", {
        mutationKey: "bad",
        discInspectionId: "missing-inspection",
        checkpointRevision: 1,
        checkpointDigest: "f".repeat(64),
      }),
      "missing-recovery",
      () => access,
      () => "http://localhost:3000",
    );
    const invalidKeyCli = await fixture.run([
      "archive-recovery",
      "verify-disc",
      "missing-recovery",
      "--key", "bad",
      "--disc-inspection-id", "missing-inspection",
      "--checkpoint-revision", "1",
      "--checkpoint-digest", "f".repeat(64),
    ]);
    expect(invalidKeyWeb.status).toBe(400);
    expect(await invalidKeyWeb.json()).toEqual(invalidKeyCli.result);

    const wrongContentType = await createDvdDiscVerificationRoute(
      new Request(
        "http://localhost:3000/api/archive-recoveries/missing-recovery/verification",
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: "{}",
        },
      ),
      "missing-recovery",
      () => access,
      () => "http://localhost:3000",
    );
    expect(wrongContentType.status).toBe(415);
    expect(await wrongContentType.json()).toEqual({
      error: {
        code: "JSON_CONTENT_TYPE_REQUIRED",
        message: "JSON content type required.",
      },
    });

    const unavailable = await createDvdDiscVerificationInspectionRoute(
      "unavailable-recovery",
      () => {
        throw new Error("synthetic service failure");
      },
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "DISC_VERIFICATION_UNAVAILABLE",
        message: "DVD Disc Verification is unavailable.",
      },
    });
  } finally {
    access.close();
  }
});

it("rejects a stale checkpoint with a stable machine-readable reason", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const access = fixture.openAccess();
  try {
    const response = await createDvdDiscVerificationRoute(
      request(seeded.recoveryId, {
        mutationKey: "00000000-0000-4000-8000-000000000442",
        discInspectionId: seeded.inspection.id,
        checkpointRevision: 1,
        checkpointDigest: "f".repeat(64),
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cliResponse = await fixture.run([
      "archive-recovery", "verify-disc", seeded.recoveryId,
      "--key", "00000000-0000-4000-8000-000000000442",
      "--disc-inspection-id", seeded.inspection.id,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", "f".repeat(64),
    ]);
    expect(response.status).toBe(409);
    const responseBody = await response.json();
    expect(responseBody).toEqual(cliResponse.result);
    expect(responseBody).toEqual({
      error: {
        code: "DISC_CHECKPOINT_CHANGED",
        message: "DISC_CHECKPOINT_CHANGED",
        reasons: [{
          code: "DISC_CHECKPOINT_CHANGED",
          message: "DISC_CHECKPOINT_CHANGED",
        }],
        currentIdentities: {
          checkpoint: {
            revision: 1,
            digest: seeded.manifest.manifestDigest,
          },
          insertion: {
            discInspectionId: seeded.inspection.id,
            detectedDiscId: seeded.sourceDisc.id,
            mediaGeneration: "synthetic-verification-generation",
          },
          insertionCandidates: [{
            discInspectionId: seeded.inspection.id,
            detectedDiscId: seeded.sourceDisc.id,
            mediaGeneration: "synthetic-verification-generation",
          }],
        },
      },
    });
  } finally {
    access.close();
  }
});

it("reports a corrupt current database manifest consistently through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const staleAccess = fixture.openAccess();
  staleAccess.discInspections.clearCurrent({
    opticalDriveId: seeded.sourceDisc.opticalDriveId,
  });
  staleAccess.close();
  const sqlite = new DatabaseSync(fixture.databasePath);
  const guard = sqlite.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'dvd_evidence_manifest_update_guard'
  `).get() as { sql: string };
  sqlite.exec("DROP TRIGGER dvd_evidence_manifest_update_guard");
  sqlite.prepare(`
    UPDATE dvd_archive_evidence_manifests
    SET manifest_digest = ?
    WHERE id = ?
  `).run("f".repeat(64), seeded.manifest.id);
  sqlite.exec(guard.sql);
  sqlite.close();

  const access = fixture.openAccess();
  try {
    const webInspection = await createDvdDiscVerificationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    const webInspectionBody = await webInspection.json();
    const cliInspection = await fixture.run([
      "archive-recovery",
      "inspect-verification",
      seeded.recoveryId,
    ]);
    expect(webInspection.status).toBe(200);
    expect(webInspectionBody).toEqual(cliInspection.result);
    expect(webInspectionBody).toMatchObject({
      checkpoint: null,
      action: {
        available: false,
      },
    });
    expect((webInspectionBody as {
      action: { blockingReasons: Array<{ code: string }> };
    }).action.blockingReasons.map(({ code }) => code)).toEqual([
      "CONSISTENCY_FAULT",
      "DISC_ABSENT",
    ]);

    const body = {
      mutationKey: "00000000-0000-4000-8000-000000000448",
      discInspectionId: seeded.inspection.id,
      checkpointRevision: 1,
      checkpointDigest: seeded.manifest.manifestDigest,
    };
    const webSubmission = await createDvdDiscVerificationRoute(
      request(seeded.recoveryId, body),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cliSubmission = await fixture.run([
      "archive-recovery", "verify-disc", seeded.recoveryId,
      "--key", body.mutationKey,
      "--disc-inspection-id", body.discInspectionId,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", body.checkpointDigest,
    ]);
    expect(webSubmission.status).toBe(409);
    expect(await webSubmission.json()).toMatchObject({
      error: { code: "CONSISTENCY_FAULT" },
    });
    expect(cliSubmission).toMatchObject({
      exitCode: 2,
      result: { error: { code: "CONSISTENCY_FAULT" } },
    });
  } finally {
    access.close();
  }
});
