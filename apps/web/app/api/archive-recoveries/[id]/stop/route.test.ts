import { afterEach, expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDvdDiscVerificationFixture } from "../../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import {
  createDvdRecoveryStopRoute,
} from "./route.js";

const fixtures: Array<ReturnType<typeof createOperatorWorkflowFixture>> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function request(
  recoveryId: string,
  mutationKey: string,
  attemptId: string,
) {
  return new Request(
    `http://localhost:3000/api/archive-recoveries/${recoveryId}/stop`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ mutationKey, attemptId }),
    },
  );
}

it("offers the same attempt-bound durable Stop through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const mutationKey = "00000000-0000-4000-8000-000000000440";

  const access = fixture.openAccess();
  try {
    const web = await createDvdRecoveryStopRoute(
      request(seeded.recoveryId, mutationKey, seeded.attemptId),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cli = await fixture.run([
      "archive-recovery",
      "stop",
      seeded.recoveryId,
      "--key",
      mutationKey,
      "--attempt-id",
      seeded.attemptId,
    ]);

    expect(web.status).toBe(202);
    expect(cli.exitCode).toBe(0);
    expect(await web.json()).toEqual(cli.result);
    expect(cli.result).toMatchObject({
      archiveRecovery: {
        id: seeded.recoveryId,
        attemptId: seeded.attemptId,
        status: "stopping",
      },
      operation: {
        kind: "archive-recoveries",
        id: seeded.recoveryId,
        status: "stopping",
      },
    });
    const competing = await createDvdRecoveryStopRoute(
      request(
        seeded.recoveryId,
        "00000000-0000-4000-8000-000000000453",
        seeded.attemptId,
      ),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({
      error: { code: "RECOVERY_STOP_REJECTED" },
    });
  } finally {
    access.close();
  }
});

it("rejects a stale Stop attempt without changing the current attempt", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const access = fixture.openAccess();
  try {
    const response = await createDvdRecoveryStopRoute(
      request(
        seeded.recoveryId,
        "00000000-0000-4000-8000-000000000441",
        "stale-recovery-attempt",
      ),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "STALE_RECOVERY_ATTEMPT",
        message: "Archive Recovery attempt is stale.",
        currentIdentities: {
          archiveRecoveryId: seeded.recoveryId,
          attemptId: seeded.attemptId,
        },
      },
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible" });
  } finally {
    access.close();
  }
});
