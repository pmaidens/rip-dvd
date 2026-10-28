import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { dispatchNotifications } from "@rip-dvd/application";
import type { DataAccess, NotificationPayload } from "@rip-dvd/data-access";
import { pollDvdRecoveryPass } from "../../../../../archive-worker/src/dvd-recovery-worker.js";
import { seedDvdDiscVerificationFixture } from "../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import { notificationWorkflow } from "../../../../../operator-cli/src/notification-workflow.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

function pollStop(access: DataAccess, fixture: ReturnType<typeof createOperatorWorkflowFixture>) {
  return pollDvdRecoveryPass({
    access,
    originalsLibraryPath: fixture.originalsLibraryPath,
    workerExecutionId: "synthetic-stop-worker-restart",
    reader: { start() { throw new Error("Stop must not read source"); } },
    mediaGenerationObserver: { async observe() { throw new Error("Stop must not observe new source"); } },
    deviceInactivity: {
      async withDeviceInactive(_path, task) { await task(); },
      async withDeviceIdentityInactive(_identity, task) { await task(); },
    },
  });
}

it("notifies once after safe Stop, including after restart and a later distinct stop", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { register } = await notificationWorkflow(fixture);
  const disabled = await register("disabled");
  expect((await fixture.run(["notifications", "remove", "--key", "synthetic-disable",
    "--id", disabled.id])).exitCode).toBe(0);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const args = ["archive-recovery", "stop", seeded.recoveryId,
    "--key", "synthetic-notification-stop", "--attempt-id", seeded.attemptId];
  const submitted = await fixture.run(args);
  expect(submitted).toMatchObject({ exitCode: 0, result: { operation: { status: "stopping" } } });
  expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
  const bytesBefore = readFileSync(seeded.archive.archivePath);
  let access = fixture.openAccess();
  const headerBefore = access.catalog.findDvdArchiveEvidenceHeader(seeded.archive.id);
  access.close();
  // A restarted worker uses the real checkpoint reconciliation and ownership path.
  access = fixture.openAccess();
  try {
    expect(await pollStop(access, fixture)).toBe(true);
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "stopped", stopRequestedAt: expect.any(String) } });
    expect((await fixture.run(args)).result).toEqual(submitted.result);
    expect((await fixture.run(["archive-recovery", "stop", seeded.recoveryId,
      "--key", "synthetic-repeated-stop", "--attempt-id", seeded.attemptId])).exitCode).toBe(2);
    expect(await pollStop(access, fixture)).toBe(false);
    await register("future");
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(access, async (_subscription, payload) => { sent.push(payload); }))
      .toEqual({ accepted: 2, failed: 0 });
    expect(sent).toEqual([expect.objectContaining({
      label: seeded.sourceDisc.volumeLabel,
      body: "Archive Recovery stopped. Source remains unrecovered.",
      destination: `/notifications/target?kind=original-disc-archives&id=${seeded.archive.id}`,
    }), expect.any(Object)]);
    expect(sent[1]).toEqual(sent[0]);
    expect(access.catalog.findDvdArchiveEvidenceHeader(seeded.archive.id)).toEqual(headerBefore);
    expect(readFileSync(seeded.archive.archivePath)).toEqual(bytesBefore);

    // A distinct synthetic attempt represents later resumed work without exercising Resume here.
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`UPDATE archive_recoveries SET attempt_id = 'synthetic-later-attempt',
      attempt_ordinal = 2, status = 'eligible', stop_operation_id = NULL,
      stop_requested_at = NULL, stopped_at = NULL WHERE id = ?`).run(seeded.recoveryId);
    database.close();
    expect((await fixture.run(["archive-recovery", "stop", seeded.recoveryId,
      "--key", "synthetic-later-stop", "--attempt-id", "synthetic-later-attempt"])).exitCode).toBe(0);
    expect(await pollStop(access, fixture)).toBe(true);
    const later: NotificationPayload[] = [];
    expect(await dispatchNotifications(access, async (_subscription, payload) => {
      later.push(payload);
      throw { statusCode: 400 };
    })).toEqual({ accepted: 0, failed: 3 });
    expect(later).toHaveLength(3);
    expect(later[0]!.tag).not.toBe(sent[0]!.tag);
    expect(later.every((payload) => payload.tag === later[0]!.tag)).toBe(true);
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "stopped", stopRequestedAt: expect.any(String) } });
    expect(access.archiveJobs.listForArchive(seeded.archive.id)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect((await fixture.run(["inspect", "archive-requests"])).result).toMatchObject({
      items: [expect.objectContaining({ status: "fulfilled" }), expect.objectContaining({ status: "fulfilled" })],
    });
    expect(access.catalog.findDvdArchiveEvidenceHeader(seeded.archive.id)).toEqual(headerBefore);
  } finally { access.close(); }
}, 20_000);

it("rolls back safe Stop with its event and uses the common missing-label fallback on retry", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  await notificationWorkflow(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  expect((await fixture.run(["archive-recovery", "stop", seeded.recoveryId,
    "--key", "synthetic-atomic-stop", "--attempt-id", seeded.attemptId])).exitCode).toBe(0);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare("UPDATE detected_discs SET volume_label = NULL WHERE id = ?").run(seeded.sourceDisc.id);
  database.exec(`CREATE TRIGGER synthetic_notification_failure BEFORE INSERT ON notification_events
    BEGIN SELECT RAISE(ABORT, 'Synthetic event persistence failure'); END`);
  const access = fixture.openAccess();
  try {
    const recovery = access.catalog.findArchiveRecoveryById(seeded.recoveryId)!;
    const stop = { archiveRecoveryId: recovery.id, attemptId: recovery.attemptId,
      stopOperationId: recovery.stopOperationId! };
    expect(() => access.archiveRecoveryWork.completeStop(stop)).toThrow();
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "stopping", stoppedAt: null } });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    database.exec("DROP TRIGGER synthetic_notification_failure");
    access.archiveRecoveryWork.completeStop(stop);
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); }))
      .toEqual({ accepted: 2, failed: 0 });
    expect(sent).toEqual([expect.objectContaining({ title: "Unlabelled disc", label: "Unlabelled disc",
      body: "Archive Recovery stopped. Source remains unrecovered." }), expect.any(Object)]);
  } finally { database.close(); access.close(); }
});
