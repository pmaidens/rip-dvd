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
    const webInspection = createDvdDiscVerificationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    const cliInspection = await fixture.run([
      "inspect-verification",
      "--archive-recovery-id",
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
      "verify-disc",
      "--key", mutationKey,
      "--archive-recovery-id", seeded.recoveryId,
      "--disc-inspection-id", seeded.inspection.id,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", seeded.manifest.manifestDigest,
    ]);
    expect(webSubmission.status).toBe(201);
    expect(cliReplay.exitCode).toBe(0);
    expect(await webSubmission.json()).toEqual(cliReplay.result);
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
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "DISC_CHECKPOINT_CHANGED",
        message: "DISC_CHECKPOINT_CHANGED",
      },
    });
  } finally {
    access.close();
  }
});
