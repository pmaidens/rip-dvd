import { afterEach, expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDvdDiscVerificationFixture } from "../../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import {
  createDvdRecoveryStopRoute,
} from "./route.js";
import { createOperationsResponse } from "../../../operations/route.js";

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

    const stopping = access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )!;
    access.archiveRecoveryWork.completeStop({
      archiveRecoveryId: stopping.id,
      attemptId: stopping.attemptId,
      stopOperationId: stopping.stopOperationId!,
    });
    const webStatus = createOperationsResponse(
      access,
      new Request(
        `http://localhost:3000/api/operations?kind=archive-recoveries&id=${seeded.recoveryId}`,
      ),
      fixture.originalsLibraryPath,
    );
    const cliStatus = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    expect(webStatus.status).toBe(200);
    expect(cliStatus.result).toEqual(await webStatus.json());
    expect(cliStatus.result).toMatchObject({
      item: {
        status: "stopped",
        availableActions: expect.arrayContaining([
          expect.objectContaining({
            name: "stop",
            blockingReasons: expect.arrayContaining([
              expect.objectContaining({ code: "RECOVERY_STOPPED" }),
            ]),
          }),
        ]),
      },
    });
    expect((await fixture.run([
      "wait",
      "archive-recoveries",
      seeded.recoveryId,
      "--timeout-ms",
      "0",
    ])).result).toMatchObject({
      outcome: "settled",
      current: { status: "stopped" },
    });

    const stoppedWeb = await createDvdRecoveryStopRoute(
      request(
        seeded.recoveryId,
        "00000000-0000-4000-8000-000000000458",
        seeded.attemptId,
      ),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const stoppedCli = await fixture.run([
      "archive-recovery",
      "stop",
      seeded.recoveryId,
      "--key",
      "00000000-0000-4000-8000-000000000459",
      "--attempt-id",
      seeded.attemptId,
    ]);
    expect(stoppedWeb.status).toBe(409);
    expect(stoppedCli.exitCode).toBe(2);
    expect(stoppedCli.result).toEqual(await stoppedWeb.json());
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

    const webResult = await response.json();
    const cli = await fixture.run([
      "archive-recovery",
      "stop",
      seeded.recoveryId,
      "--key",
      "00000000-0000-4000-8000-000000000441",
      "--attempt-id",
      "stale-recovery-attempt",
    ]);
    expect(response.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(webResult);
    expect(webResult).toEqual({
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
