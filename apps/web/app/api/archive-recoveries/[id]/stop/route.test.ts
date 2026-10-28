import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { ArchiveRecoveryStopOperationId } from "@rip-dvd/data-access";

import {
  createOperatorWorkflowFixture,
  markArchiveWithDvdRecoveryEvidence,
  seedCatalogReviewForReadFixture,
} from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDvdDiscVerificationFixture } from "../../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import {
  createDvdRecoveryStopRoute,
} from "./route.js";
import { createOperationsResponse } from "../../../operations/route.js";

import { notificationWorkflow } from "../../../../../../operator-cli/src/notification-workflow.test-support.js";
import { handleNotifications } from "../../../notifications/route.js";

const fixtures: Array<ReturnType<typeof createOperatorWorkflowFixture>> = [];

afterEach(() => {
  vi.unstubAllEnvs();
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
  await notificationWorkflow(fixture);
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

    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    const stopping = access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )!;
    access.archiveRecoveryWork.completeStop({
      archiveRecoveryId: stopping.id,
      attemptId: stopping.attemptId,
      stopOperationId: stopping.stopOperationId!,
    });
    const deliveries = await fixture.run(["notifications", "deliveries"]);
    expect(deliveries.result).toMatchObject({ deliveries: [
      { status: "queued" }, { status: "queued" },
    ] });
    const webDeliveries = await handleNotifications(new Request(
      "http://localhost:3000/api/notifications?action=deliveries",
    ), () => access);
    expect(await webDeliveries.json()).toEqual(deliveries.result);
    const webStatus = await createOperationsResponse(
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
    const artifactWeb = await createOperationsResponse(
      access,
      new Request(
        `http://localhost:3000/api/operations?kind=original-disc-archives&id=${seeded.archive.id}`,
      ),
      fixture.originalsLibraryPath,
    );
    const artifactCli = await fixture.run([
      "inspect",
      "original-disc-archives",
      seeded.archive.id,
    ]);
    expect(artifactCli.result).toEqual(await artifactWeb.json());
    expect(artifactCli.result).toMatchObject({
      item: { archiveArtifact: { recovery: { state: "stopped" } } },
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

it("retains the Stop operation identity through a terminal fault", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const mutationKey = "00000000-0000-4000-8000-000000000492";
  const access = fixture.openAccess();
  try {
    const submitted = await createDvdRecoveryStopRoute(
      request(seeded.recoveryId, mutationKey, seeded.attemptId),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const receipt = await submitted.json() as {
      archiveRecovery: { stopRequestedAt: string };
      operation: { operationId: ArchiveRecoveryStopOperationId };
    };
    access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
      stopOperationId: receipt.operation.operationId,
      faultCode: "STORAGE_UNSUPPORTED",
    });

    const webStatus = await createOperationsResponse(
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
    expect(cliStatus.result).toEqual(await webStatus.json());
    expect(cliStatus.result).toMatchObject({
      item: {
        status: "faulted",
        recoveryStatus: "faulted",
        stopOperationId: receipt.operation.operationId,
        stopRequestedAt: receipt.archiveRecovery.stopRequestedAt,
        faultCode: "STORAGE_UNSUPPORTED",
      },
    });

    const waited = await fixture.run([
      "wait",
      "archive-recoveries",
      seeded.recoveryId,
      "--timeout-ms",
      "0",
    ]);
    expect(waited).toMatchObject({
      exitCode: 0,
      result: {
        outcome: "settled",
        current: {
          status: "faulted",
          stopOperationId: receipt.operation.operationId,
          stopRequestedAt: receipt.archiveRecovery.stopRequestedAt,
        },
      },
    });
  } finally {
    access.close();
  }
});

it("reports queued Encode ownership through Stop web, CLI, and availability", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const catalog = seedCatalogReviewForReadFixture(fixture);
  const preparation = fixture.openAccess();
  preparation.catalog.completeCatalogReview(
    catalog.archive.id,
    preparation.catalog.listOriginalDiscArchives({
      ids: [catalog.archive.id],
    })[0]!.updatedAt,
    "reviewed_with_selections",
  );
  const profile = preparation.encodingProfiles.list({
    mediaDomain: "dvd_video",
    activeOnly: true,
  })[0]!;
  const queued = preparation.encodeJobs.enqueue({
    discSelectionId: catalog.correctedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(fixture.mediaLibraryPath, "stop-conflict.mkv"),
  });
  preparation.close();
  const recoveryId = "synthetic-stop-encode-conflict";
  const attemptId = `${recoveryId}:attempt:1`;
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    catalog.archive.id,
    "synthetic-stop-encode-conflict",
    { archiveRecovery: { id: recoveryId } },
  );

  const access = fixture.openAccess();
  try {
    const mutationKey = "00000000-0000-4000-8000-000000000488";
    const web = await createDvdRecoveryStopRoute(
      request(recoveryId, mutationKey, attemptId),
      recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cli = await fixture.run([
      "archive-recovery",
      "stop",
      recoveryId,
      "--key",
      mutationKey,
      "--attempt-id",
      attemptId,
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "ENCODE_WORK_CONFLICT",
        blockingReasons: [{ code: "ENCODE_WORK_CONFLICT" }],
        current: {
          archiveRecovery: {
            id: recoveryId,
            originalDiscArchiveId: catalog.archive.id,
            work: null,
          },
          encodeJobs: [{ id: queued.id, status: "queued" }],
        },
      },
    });

    const webStatus = await createOperationsResponse(
      access,
      new Request(
        `http://localhost:3000/api/operations?kind=archive-recoveries&id=${recoveryId}`,
      ),
      fixture.originalsLibraryPath,
    );
    const cliStatus = await fixture.run([
      "inspect",
      "archive-recoveries",
      recoveryId,
    ]);
    expect(cliStatus.result).toEqual(await webStatus.json());
    expect(cliStatus.result).toMatchObject({
      item: {
        availableActions: expect.arrayContaining([
          expect.objectContaining({
            name: "stop",
            available: false,
            blockingReasons: [expect.objectContaining({
              code: "ENCODE_WORK_CONFLICT",
              current: expect.objectContaining({
                encodeJobs: [{ id: queued.id, status: "queued" }],
              }),
            })],
          }),
        ]),
      },
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
