import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";
import type { ArchiveRecoveryId } from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { defaultArchiveImageOwnership } from "@rip-dvd/worker-runtime";

import { pollDvdRecoveryReconciliation } from "../../../../../../archive-worker/src/dvd-recovery-reconciliation-worker.js";
import { seedCommittedArchiveEvidence } from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
  markArchiveWithDvdRecoveryEvidence,
} from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import {
  createDvdRecoveryReconciliationInspectionRoute,
  createDvdRecoveryReconciliationRoute,
} from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

async function seedRecovery(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
) {
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const recoveryId = `${saved.archive.id}:recovery`;
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.prepare(`UPDATE original_disc_archives SET
      integrity = 'incomplete_read', integrity_evidence_revision = 1,
      integrity_policy_version = 'dvd-recovery-evidence-v1',
      bad_sector_count = 1, bad_area_count = 1,
      bad_sector_ranges = '[{"startLba":10,"sectorCount":1}]'
      WHERE id = ?`).run(saved.archive.id);
    database.prepare(`INSERT INTO archive_recoveries (
      id, original_disc_archive_id, attempt_id, attempt_ordinal, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'eligible', 1, 1)`).run(
      recoveryId,
      saved.archive.id,
      `${recoveryId}:attempt:1`,
    );
  } finally {
    database.close();
  }
  return { ...saved, recoveryId };
}

function request(id: string, mutationKey: string): Request {
  return new Request(
    `http://localhost:3000/api/archive-recoveries/${id}/reconciliation`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ mutationKey }),
    },
  );
}

it("keeps web and JSON CLI submission, progress, replay, and evidence equal", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const mutationKey = "00000000-0000-4000-8000-000000000438";
  try {
    access.archiveRecoveryWork.claim(
      seeded.recoveryId as ArchiveRecoveryId,
      "interrupted-recovery-worker",
    );
    const webInspection = await createDvdRecoveryReconciliationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    const cliInspection = await fixture.run([
      "archive-recovery",
      "inspect-reconciliation",
      seeded.recoveryId,
    ]);
    expect(webInspection.status).toBe(200);
    expect(await webInspection.json()).toEqual(cliInspection.result);

    const submitted = await createDvdRecoveryReconciliationRoute(
      request(seeded.recoveryId, mutationKey),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const replay = await fixture.run([
      "archive-recovery",
      "reconcile",
      seeded.recoveryId,
      "--key",
      mutationKey,
    ]);
    expect(submitted.status).toBe(201);
    expect(replay.exitCode).toBe(0);
    expect(await submitted.json()).toEqual(replay.result);
    expect(replay.result).toMatchObject({
      reconciliation: { status: "queued", phase: "queued" },
    });

    await expect(pollDvdRecoveryReconciliation({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      workerExecutionId: "synthetic-reconciliation-worker",
    })).resolves.toBe(true);

    const completedWeb = await createDvdRecoveryReconciliationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    const completedCli = await fixture.run([
      "archive-recovery",
      "inspect-reconciliation",
      seeded.recoveryId,
    ]);
    expect(await completedWeb.json()).toEqual(completedCli.result);
    expect(completedCli.result).toMatchObject({
      reconciliation: {
        status: "completed",
        phase: "completed",
        outcome: "already_consistent",
        evidence: {
          authoritativeCheckpoint: { revision: 1 },
          databaseProjectionBefore: { revision: 1 },
          databaseProjectionAfter: { revision: 1 },
          journal: "absent",
          uncommittedManifest: "absent",
        },
      },
    });
    expect(access.catalog.findArchiveRecoveryById(
      seeded.recoveryId as ArchiveRecoveryId,
    )?.work).toBeNull();
    const resumedRecovery = access.archiveRecoveryWork.claim(
      seeded.recoveryId as ArchiveRecoveryId,
      "replacement-recovery-worker",
    );
    expect(resumedRecovery.status).toBe("claimed");
    access.archiveRecoveryWork.release(resumedRecovery);
    const completedReplay = await fixture.run([
      "archive-recovery",
      "reconcile",
      seeded.recoveryId,
      "--key",
      mutationKey,
    ]);
    expect(completedReplay.result).toMatchObject({
      reconciliation: { status: "completed", outcome: "already_consistent" },
    });
    const genericInspection = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    expect(genericInspection.result).toMatchObject({
      item: {
        id: seeded.recoveryId,
        status: "completed",
        recoveryStatus: "eligible",
        reconciliation: { status: "completed" },
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
        current: { status: "completed" },
      },
    });
  } finally {
    access.close();
  }
});

it("keeps wait pending for reconciliation after a faulted Stop", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const recoveryId = seeded.recoveryId as ArchiveRecoveryId;
  try {
    const recovery = access.catalog.findArchiveRecoveryById(recoveryId)!;
    const stop = access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000490",
      archiveRecoveryId: recoveryId,
      attemptId: recovery.attemptId,
    });
    access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: recoveryId,
      attemptId: recovery.attemptId,
      stopOperationId: stop.stopOperationId,
      faultCode: "STORAGE_UNSUPPORTED",
    });

    const submitted = await fixture.run([
      "archive-recovery",
      "reconcile",
      recoveryId,
      "--key",
      "00000000-0000-4000-8000-000000000491",
    ]);
    expect(submitted.result).toMatchObject({
      reconciliation: { status: "queued" },
    });
    const queued = await fixture.run([
      "wait",
      "archive-recoveries",
      recoveryId,
      "--timeout-ms",
      "0",
    ]);
    expect(queued).toMatchObject({
      exitCode: 3,
      result: {
        outcome: "timeout",
        current: {
          status: "queued",
          recoveryStatus: "faulted",
          reconciliation: { status: "queued" },
        },
      },
    });

    expect(access.dvdRecoveryReconciliations.claimNext(
      "synthetic-faulted-stop-reconciliation-worker",
    )).toMatchObject({ status: "running" });
    const running = await fixture.run([
      "wait",
      "archive-recoveries",
      recoveryId,
      "--timeout-ms",
      "0",
    ]);
    expect(running).toMatchObject({
      exitCode: 3,
      result: {
        outcome: "timeout",
        current: {
          status: "running",
          recoveryStatus: "faulted",
          reconciliation: { status: "running" },
        },
      },
    });
  } finally {
    access.close();
  }
});

async function expectReconciliationBlockedWhileWorkRetained(
  recoveryStatus: "eligible" | "paused",
) {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const recoveryId = seeded.recoveryId as ArchiveRecoveryId;
  try {
    access.archiveRecoveryWork.request(recoveryId);
    const database = new DatabaseSync(fixture.databasePath);
    if (recoveryStatus === "paused") {
      database.prepare(`UPDATE archive_recovery_work SET
        pass_started_at = 1, pass_initial_unrecovered_sector_count = 1,
        pass_cursor_lba = 10
        WHERE archive_recovery_id = ?`).run(recoveryId);
      database.prepare(`UPDATE archive_recoveries SET
        status = 'paused', pause_reason = 'no_progress'
        WHERE id = ?`).run(recoveryId);
    } else {
      database.prepare(`UPDATE archive_recovery_work
        SET pass_number = 2, pass_direction = 'reverse'
        WHERE archive_recovery_id = ?`).run(recoveryId);
    }
    database.close();

    const inspection = await createDvdRecoveryReconciliationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    expect(await inspection.json()).toMatchObject({
      action: {
        available: false,
        blockingReasons: [{ code: "RECOVERY_PASS_ACTIVE" }],
      },
    });
    const genericInspection = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    expect(genericInspection.result).toMatchObject({
      item: {
        availableActions: expect.arrayContaining([
          expect.objectContaining({
            name: "reconcile",
            eligible: false,
            blockingReasons: [
              "The retained DVD recovery pass must be stopped before reconciliation.",
            ],
          }),
        ]),
      },
    });
    const web = await createDvdRecoveryReconciliationRoute(
      request(
        seeded.recoveryId,
        recoveryStatus === "paused"
          ? "00000000-0000-4000-8000-000000000468"
          : "00000000-0000-4000-8000-000000000464",
      ),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cli = await fixture.run([
      "archive-recovery",
      "reconcile",
      seeded.recoveryId,
      "--key",
      recoveryStatus === "paused"
        ? "00000000-0000-4000-8000-000000000469"
        : "00000000-0000-4000-8000-000000000465",
    ]);
    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: { code: "RECONCILIATION_REJECTED" },
    });
    expect(access.dvdRecoveryReconciliations.findLatestForRecovery(recoveryId))
      .toBeNull();
  } finally {
    access.close();
  }
}

it.each(["eligible", "paused"] as const)(
  "rejects reconciliation while %s Recovery work is retained",
  expectReconciliationBlockedWhileWorkRetained,
);

it("keeps requested Recovery work in a bounded active listing", () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const setup = createLegacySidecarDataAccess({
    databasePath: fixture.databasePath,
    mediaLibraryPath: fixture.mediaLibraryPath,
    originalsLibraryPath: fixture.originalsLibraryPath,
  });
  const drive = setup.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-bounded-recovery-list",
    isPresent: true,
  });
  const archives = ["queued", "historical"].map((name) => {
    const disc = setup.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: `synthetic-bounded-recovery-${name}`,
    });
    setup.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    setup.catalog.updateDetectedDiscStatus(disc.id, "approved");
    return setup.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: `/synthetic/bounded-recovery-${name}.iso`,
      fingerprint: disc.fingerprint,
    });
  });
  setup.close();
  const queuedRecoveryId = "synthetic-bounded-queued-recovery";
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    archives[0]!.id,
    "synthetic-bounded-queued",
    {
      archiveRecovery: {
        id: queuedRecoveryId,
        workStatus: "requested",
      },
    },
  );
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    archives[1]!.id,
    "synthetic-bounded-historical",
    {
      archiveRecovery: { id: "synthetic-bounded-historical-recovery" },
    },
  );
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET updated_at = 1
    WHERE id = ?`).run(queuedRecoveryId);
  database.prepare(`UPDATE archive_recoveries SET updated_at = 2
    WHERE id = ?`).run("synthetic-bounded-historical-recovery");
  database.close();

  const access = fixture.openAccess();
  try {
    expect(access.catalog.listArchiveRecoveries({ limit: 1 }))
      .toEqual([expect.objectContaining({ id: queuedRecoveryId })]);
  } finally {
    access.close();
  }
});

it.each([
  "rolling_back",
  "projecting",
  "cleaning_up",
] as const)("requeues a reconciliation stopped while %s", async (phase) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const recoveryId = seeded.recoveryId as ArchiveRecoveryId;
  const controller = new AbortController();
  try {
    access.dvdRecoveryReconciliations.submit({
      mutationKey: `shutdown-${phase}`,
      archiveRecoveryId: recoveryId,
    });
    await expect(pollDvdRecoveryReconciliation({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      workerExecutionId: "stopping-reconciliation-worker",
      signal: controller.signal,
      async reconcile(options) {
        options.setPhase?.(phase);
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error("unreachable");
      },
    })).resolves.toBe(true);

    expect(access.dvdRecoveryReconciliations.findLatestForRecovery(recoveryId))
      .toMatchObject({
        status: "queued",
        phase: "queued",
        failureCode: null,
        workerExecutionId: null,
        claimToken: null,
      });
    const restarted = access.dvdRecoveryReconciliations.claimNext(
      "restarted-reconciliation-worker",
    );
    expect(restarted).toMatchObject({
      status: "running",
      phase: "examining",
      workerExecutionId: "restarted-reconciliation-worker",
    });
    if (restarted === null) throw new Error("Expected restarted claim");
    expect(access.dvdRecoveryReconciliations.fail(
      restarted,
      "CONSISTENCY_FAULT",
    )).not.toBeNull();
  } finally {
    access.close();
  }
});

it("prioritizes active reconciliation in a bounded recovery listing", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const active = await seedRecovery(fixture);
  const migrationAccess = createLegacySidecarDataAccess({
    databasePath: fixture.databasePath,
    mediaLibraryPath: fixture.mediaLibraryPath,
    originalsLibraryPath: fixture.originalsLibraryPath,
  });
  const historicalArchive = (() => {
    try {
      const drive = migrationAccess.catalog.upsertOpticalDrive({
        devicePath: "/dev/synthetic-reconciliation-listing",
        isPresent: true,
      });
      const contentId = `sha256:${"b".repeat(64)}`;
      const disc = migrationAccess.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: contentId,
        volumeLabel: "SYNTHETIC_LISTING",
      });
      migrationAccess.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      migrationAccess.catalog.updateDetectedDiscStatus(disc.id, "approved");
      return migrationAccess.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: "/media/originals/synthetic-listing.iso",
        fingerprint: contentId,
        sizeBytes: 2_048,
      });
    } finally {
      migrationAccess.close();
    }
  })();
  const historicalRecoveryId = "synthetic-historical-recovery";
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    historicalArchive.id,
    "synthetic-listing",
    { archiveRecovery: { id: historicalRecoveryId } },
  );
  const access = fixture.openAccess();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.prepare(
        "UPDATE archive_recoveries SET updated_at = ? WHERE id = ?",
      ).run(1, active.recoveryId);
      database.prepare(
        "UPDATE archive_recoveries SET updated_at = ? WHERE id = ?",
      ).run(2, historicalRecoveryId);
    } finally {
      database.close();
    }
    access.dvdRecoveryReconciliations.submit({
      mutationKey: "active-reconciliation-list-priority",
      archiveRecoveryId: active.recoveryId as ArchiveRecoveryId,
    });

    const listing = await fixture.run([
      "inspect",
      "archive-recoveries",
      "--limit",
      "1",
    ]);
    expect(listing.result).toMatchObject({
      items: [{ id: active.recoveryId, status: "queued" }],
    });
  } finally {
    access.close();
  }
});

it("persists a machine-readable consistency fault without deleting evidence", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  try {
    const submitted = await fixture.run([
      "archive-recovery",
      "reconcile",
      seeded.recoveryId,
      "--key",
      "00000000-0000-4000-8000-000000000439",
    ]);
    expect(submitted.exitCode).toBe(0);
    const pointerPath = join(seeded.directory, "checkpoint.json");
    unlinkSync(pointerPath);

    await expect(pollDvdRecoveryReconciliation({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      workerExecutionId: "synthetic-reconciliation-worker",
    })).resolves.toBe(true);
    expect(access.dvdRecoveryReconciliations.findLatestForRecovery(
      seeded.recoveryId as ArchiveRecoveryId,
    )).toMatchObject({
      status: "failed",
      phase: "completed",
      failureCode: "CONSISTENCY_FAULT",
      evidence: null,
    });
  } finally {
    access.close();
  }
});

it("blocks stable reads after uncertain quiescence until reconciliation succeeds", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const recoveryId = seeded.recoveryId as ArchiveRecoveryId;
  try {
    access.dvdRecoveryReconciliations.submit({
      mutationKey: "00000000-0000-4000-8000-000000000440",
      archiveRecoveryId: recoveryId,
    });
    await defaultArchiveImageOwnership.withWriter({
      archiveId: seeded.archive.id,
      imagePath: seeded.archive.archivePath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        await expect(pollDvdRecoveryReconciliation({
          access,
          originalsLibraryPath: fixture.originalsLibraryPath,
          workerExecutionId: "synthetic-reconciliation-worker",
        })).resolves.toBe(true);
      },
    });
    expect(access.dvdRecoveryReconciliations.findLatestForRecovery(recoveryId))
      .toMatchObject({
        status: "failed",
        failureCode: "WRITER_NOT_QUIESCENT",
      });
    await expect(access.readDvdCheckpoint(
      seeded.archive.id,
      defaultArchiveImageOwnership,
    )).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });

    access.dvdRecoveryReconciliations.submit({
      mutationKey: "00000000-0000-4000-8000-000000000441",
      archiveRecoveryId: recoveryId,
    });
    await expect(pollDvdRecoveryReconciliation({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      workerExecutionId: "synthetic-reconciliation-worker",
    })).resolves.toBe(true);
    await expect(access.readDvdCheckpoint(
      seeded.archive.id,
      defaultArchiveImageOwnership,
    )).resolves.toMatchObject({ revision: 1 });
  } finally {
    access.close();
  }
});

it("exposes durable intermediate progress equally through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const recoveryId = seeded.recoveryId as ArchiveRecoveryId;
  try {
    access.dvdRecoveryReconciliations.submit({
      mutationKey: "00000000-0000-4000-8000-000000000442",
      archiveRecoveryId: recoveryId,
    });
    const claimed = access.dvdRecoveryReconciliations.claimNext(
      "synthetic-reconciliation-worker",
    );
    if (claimed === null) throw new Error("Expected reconciliation claim");
    const running = access.dvdRecoveryReconciliations.setPhase(
      claimed,
      "rolling_back",
    );

    const web = await createDvdRecoveryReconciliationInspectionRoute(
      seeded.recoveryId,
      () => access,
    );
    const cli = await fixture.run([
      "archive-recovery",
      "inspect-reconciliation",
      seeded.recoveryId,
    ]);
    expect(await web.json()).toEqual(cli.result);
    expect(cli.result).toMatchObject({
      reconciliation: { status: "running", phase: "rolling_back" },
    });
    expect(access.dvdRecoveryReconciliations.fail(
      running,
      "CONSISTENCY_FAULT",
    )).not.toBeNull();
  } finally {
    access.close();
  }
});

it("orders attempts monotonically and hides recovery claim authority", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedRecovery(fixture);
  const access = fixture.openAccess();
  const recoveryId = seeded.recoveryId as ArchiveRecoveryId;
  try {
    access.archiveRecoveryWork.request(recoveryId);
    access.archiveRecoveryWork.claim(recoveryId, "synthetic-recovery-worker");
    const first = access.dvdRecoveryReconciliations.submit({
      mutationKey: "00000000-0000-4000-8000-000000000443",
      archiveRecoveryId: recoveryId,
    });
    const claimed = access.dvdRecoveryReconciliations.claimNext(
      "synthetic-reconciliation-worker",
    );
    if (claimed === null) throw new Error("Expected reconciliation claim");
    expect(access.dvdRecoveryReconciliations.fail(
      claimed,
      "CONSISTENCY_FAULT",
    )).not.toBeNull();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.prepare(`
        UPDATE dvd_recovery_reconciliations
        SET created_at = 9000000000000
        WHERE id = ?
      `).run(first.id);
    } finally {
      database.close();
    }
    const second = access.dvdRecoveryReconciliations.submit({
      mutationKey: "00000000-0000-4000-8000-000000000444",
      archiveRecoveryId: recoveryId,
    });
    expect(second.attemptOrdinal).toBe(2);
    expect(access.dvdRecoveryReconciliations.findLatestForRecovery(recoveryId))
      .toMatchObject({ id: second.id, attemptOrdinal: 2, status: "queued" });

    const inspection = await fixture.run([
      "archive-recovery",
      "inspect-reconciliation",
      seeded.recoveryId,
    ]);
    const inspectionResult = inspection.result as {
      archiveRecovery: { work: unknown };
    };
    expect(inspectionResult).toMatchObject({
      archiveRecovery: {
        work: { archiveRecoveryId: recoveryId, status: "claimed" },
      },
    });
    expect(inspectionResult.archiveRecovery.work).not.toHaveProperty(
      "claimToken",
    );
  } finally {
    access.close();
  }
});
