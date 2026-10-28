import { afterEach, expect, it, vi } from "vitest";
import { dispatchNotifications } from "@rip-dvd/application";
import type { ArchiveReadFailureEvidence, NotificationPayload } from "@rip-dvd/data-access";
import { ARCHIVE_JOB_LEASE_DURATION_MS, createCleanReadArchiveIntegrityEvidence, createIncompleteReadArchiveIntegrityEvidence, createUnknownArchiveIntegrityEvidence, createWatchableSalvageArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest, createNormalDvdArchiveBoundaryEvidenceForTest } from "@rip-dvd/data-access/test-support";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { notificationWorkflow } from "./notification-workflow.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const readFailure: ArchiveReadFailureEvidence = {
  stage: "initial_copy", category: "unknown", classifierVersion: "scsi-read-classifier-v2", failingLba: 10,
  requestedBlockCount: 1, retryCount: 0, scsiStatus: null, hostStatus: null, driverStatus: null, senseKey: null, asc: null, ascq: null,
};
const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

async function createNotificationFixture() {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  return notificationWorkflow(fixture);
}

async function startArchiveJob(fixture: ReturnType<typeof createOperatorWorkflowFixture>, label?: string) {
  const access = fixture.openAccess();
  const drive = access.catalog.upsertOpticalDrive({ devicePath: "/dev/synthetic-notification", isEnabled: true, isPresent: true });
  const disc = access.catalog.registerDetectedDisc({ opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-notification-disc", volumeLabel: label });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  const submitted = await fixture.run(["submit-archive-request", "--key", "synthetic-archive-request", "--detected-disc-id", disc.id]);
  expect(submitted.exitCode).toBe(0);
  const settled = beginSettledDiscInspectionForTest(access, { opticalDriveId: drive.id, mediaGeneration: "synthetic-generation", mediaCapacityBytes: 204_800 });
  access.discInspections.record(settled.claim, { type: "metadata", volumeLabel: label ?? null, titleCount: 0,
    chapterCount: 0, audioStreamCount: 0, subtitleStreamCount: 0, totalBytes: 204_800 });
  const inspection = access.discInspections.record(settled.claim, { type: "complete", detectedDiscId: disc.id });
  settled.restoreSystemTime();
  const claim = access.archiveJobs.startForInspection(inspection.id, "synthetic-worker")!;
  expect(claim).not.toBeNull();
  return { access, claim, disc };
}

it("notifies every eligible browser when a CLI-initiated Archive Job fails", async () => {
  const { fixture, register } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture, "Synthetic disc");
  try {
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    access.archiveJobs.fail(claim, "Synthetic private diagnostic");
    expect(() => access.archiveJobs.fail(claim, "Repeated failure")).toThrow();
    await register("future");
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); })).toEqual({ accepted: 2, failed: 0 });
    expect(sent).toEqual([expect.objectContaining({ label: "Synthetic disc", body: "Archive Job failed. Inspect the attempt for details.",
      destination: `/notifications/target?kind=archive-jobs&id=${claim.id}` }), expect.any(Object)]);
    expect(sent[1]).toEqual(sent[0]);
    expect(JSON.stringify(sent)).not.toContain("private diagnostic");
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [
      { status: "accepted" }, { status: "accepted" },
    ] });
  } finally { access.close(); }
});

it.each(["clean", "unknown", "remaining"] as const)("notifies once after a %s archive save and preserves the saved outcome if sending fails", async (integrity) => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture);
  const publication = {
    archivePath: join(fixture.originalsLibraryPath, "synthetic.iso"),
    sizeBytes: 204_800,
    boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(204_800),
    integrityEvidence: integrity === "clean" ? createCleanReadArchiveIntegrityEvidence("synthetic-policy-v1")
      : integrity === "unknown" ? createUnknownArchiveIntegrityEvidence()
        : createWatchableSalvageArchiveIntegrityEvidence("synthetic-policy-v1", [{ startLba: 10, sectorCount: 1 }], [{ titleNumber: 1, badSectorCount: 1 }]),
  };
  try {
    const saved = access.archiveJobs.publish(claim, publication);
    expect(() => access.archiveJobs.publish(claim, publication)).toThrow();
    expect(() => access.archiveJobs.fail(claim, "Later recovery fault")).toThrow();
    expect(access.archiveJobs.recoverExpiredClaims()).toEqual([]);
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(access, async (_recipient, payload) => {
      sent.push(payload);
      throw new Error("Synthetic sender failure");
    })).toEqual({ accepted: 0, failed: 2 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ label: "Unlabelled disc", destination: `/notifications/target?kind=archive-jobs&id=${claim.id}`,
      body: integrity === "remaining" ? "Original Disc Archive saved. Source remains unrecovered; recovery may continue." : "Original Disc Archive saved." });
    expect(sent[1]).toEqual(sent[0]);
    expect(access.archiveJobs.find(claim.id)).toEqual(saved);
    expect((await fixture.run(["inspect", "archive-requests", claim.archiveRequestId])).result).toMatchObject({ item: { status: "fulfilled" } });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "failed" }, { status: "failed" }] });
  } finally { access.close(); }
});

it("notifies once for persisted expired-claim failure after a worker restart", async () => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture);
  access.close();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(claim.updatedAt.getTime() + ARCHIVE_JOB_LEASE_DURATION_MS + 1));
  const restarted = fixture.openAccess();
  try {
    expect(restarted.archiveJobs.recoverExpiredClaims()).toMatchObject([{ id: claim.id, status: "failed" }]);
    expect(restarted.archiveJobs.recoverExpiredClaims()).toEqual([]);
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(restarted, async (_recipient, payload) => { sent.push(payload); })).toEqual({ accepted: 2, failed: 0 });
    expect(sent[0]).toMatchObject({ label: "Unlabelled disc", body: "Archive Job failed. Inspect the attempt for details." });
    expect(sent[1]).toEqual(sent[0]);
    expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: { status: "failed" } });
  } finally { restarted.close(); }
});

it.each(["saved", "failed", "read_failure", "expired"] as const)("rolls back the %s outcome when notification persistence cannot commit", async (outcome) => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture);
  const observer = fixture.openAccess();
  const sqlite = new DatabaseSync(fixture.databasePath);
  if (outcome === "expired") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(claim.updatedAt.getTime() + ARCHIVE_JOB_LEASE_DURATION_MS + 1));
  }
  const transition = () => {
    if (outcome === "saved") access.archiveJobs.publish(claim, {
      archivePath: join(fixture.originalsLibraryPath, "synthetic.iso"), sizeBytes: 204_800,
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(204_800),
      integrityEvidence: createCleanReadArchiveIntegrityEvidence("synthetic-policy-v1"),
    });
    else if (outcome === "failed") access.archiveJobs.fail(claim, "Synthetic failure");
    else if (outcome === "read_failure") access.archiveJobs.failWithReadFailure(claim, readFailure);
    else access.archiveJobs.recoverExpiredClaims();
  };
  try {
    // Fail a recipient write, after the domain outcome and event writes.
    sqlite.exec("CREATE TRIGGER synthetic_notification_rollback BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT, 'Synthetic rollback'); END");
    expect(transition).toThrow();
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    expect(access.archiveJobs.find(claim.id)?.status).toBe("running");
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    sqlite.exec("DROP TRIGGER synthetic_notification_rollback");
    transition();
    expect(await dispatchNotifications(observer, async () => undefined)).toEqual({ accepted: 2, failed: 0 });
    if (outcome === "read_failure") expect(access.archiveJobs.find(claim.id)).toMatchObject({ status: "failed", readFailureCategory: "unknown" });
  } finally { sqlite.close(); observer.close(); access.close(); }
});

it.each(["abort", "fail", "read_failure", "expired"] as const)("does not alert on progress or cancellation through %s", async (outcome) => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture);
  try {
    access.archiveJobs.updateProgress(claim, { phase: "copying", progressPercent: 20, progressBytes: 4096 });
    expect(access.notifications.deliveries({ limit: 10 })).toEqual([]);
    expect((await fixture.run(["cancel-archive-request", "--key", "synthetic-cancel", "--archive-request-id", claim.archiveRequestId])).exitCode).toBe(0);
    if (outcome === "abort") access.archiveJobs.abort(claim, "Synthetic cooperative abort");
    else if (outcome === "fail") access.archiveJobs.fail(claim, "Synthetic cancellation race");
    else if (outcome === "read_failure") access.archiveJobs.failWithReadFailure(claim, readFailure);
    else {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + ARCHIVE_JOB_LEASE_DURATION_MS + 1));
      expect(access.archiveJobs.recoverExpiredClaims()).toEqual([]);
      access.archiveJobs.finalizeExpiredCancellation(claim);
    }
    expect(access.archiveJobs.find(claim.id)?.status).toBe("aborted");
    expect(await dispatchNotifications(access, async () => { throw new Error("Must not send cancellation"); })).toEqual({ accepted: 0, failed: 0 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
  } finally { access.close(); }
});

it("keeps incomplete-read publication admission closed without queuing a saved alert", async () => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture);
  try {
    expect(() => access.archiveJobs.publish(claim, {
      archivePath: join(fixture.originalsLibraryPath, "synthetic.iso"), sizeBytes: 204_800,
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(204_800),
      integrityEvidence: createIncompleteReadArchiveIntegrityEvidence([{ startLba: 10, sectorCount: 1 }]),
    })).toThrow("Incomplete-read evidence requires an admitted dvd-recovery-evidence-v1 Archive Job");
    expect(access.archiveJobs.find(claim.id)?.status).toBe("running");
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
  } finally { access.close(); }
});

it("gives a retried Archive Request a distinct attempt outcome without rewriting the predecessor", async () => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture);
  try {
    const first = access.archiveJobs.fail(claim, "Synthetic first failure");
    expect((await fixture.run(["retry-archive-request", "--key", "synthetic-retry", "--archive-request-id", claim.archiveRequestId])).exitCode).toBe(0);
    const second = access.archiveJobs.startForInspection(claim.discInspectionId!, "synthetic-retry-worker")!;
    access.archiveJobs.fail(second, "Synthetic second failure");
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); })).toEqual({ accepted: 4, failed: 0 });
    expect(new Set(sent.map((payload) => payload.tag)).size).toBe(2);
    expect(new Set(sent.map((payload) => payload.destination))).toEqual(new Set([
      `/notifications/target?kind=archive-jobs&id=${claim.id}`, `/notifications/target?kind=archive-jobs&id=${second.id}`,
    ]));
    expect(access.archiveJobs.find(claim.id)).toEqual(first);
  } finally { access.close(); }
});

it.each([
  { kind: "timeout", error: { code: "ETIMEDOUT" }, status: "retrying", failureCode: "timeout" },
  { kind: "lost response", error: { code: "ECONNRESET" }, status: "retrying", failureCode: "network_error" },
  { kind: "throttle", error: { statusCode: 429, headers: { "retry-after": "30" } }, status: "retrying", failureCode: "throttled" },
  { kind: "provider outage", error: { statusCode: 503 }, status: "retrying", failureCode: "provider_unavailable" },
  { kind: "expired subscription", error: { statusCode: 410 }, status: "failed", failureCode: "subscription_expired" },
  { kind: "permanent rejection", error: { statusCode: 403 }, status: "failed", failureCode: "sender_rejected" },
])("retains an Archive Job outcome through $kind and dispatcher restart", async ({ error, status, failureCode }) => {
  const { fixture } = await createNotificationFixture();
  const { access, claim } = await startArchiveJob(fixture, "Synthetic delivery disc");
  access.archiveJobs.fail(claim, "Synthetic source failure");
  const before = (await fixture.run(["inspect", "archive-jobs", claim.id])).result;
  const timestamp = new Date();
  const sent: NotificationPayload[] = [];
  await dispatchNotifications(access, async (_recipient, payload) => {
    sent.push(payload);
    throw { ...error, body: "Synthetic sensitive provider response", message: "https://web.push.apple.com/synthetic-secret" };
  }, { now: () => timestamp });
  access.close();
  const inspected = await fixture.run(["notifications", "deliveries"]);
  expect(inspected.result).toMatchObject({ deliveries: [
    { status, failureCode, attemptCount: 1 }, { status, failureCode, attemptCount: 1 },
  ] });
  expect(inspected.stdout).not.toContain("synthetic-secret");
  expect(inspected.stdout).not.toContain("sensitive provider response");
  expect((await fixture.run(["notifications", "subscriptions"])).result).toMatchObject({ subscriptions: [
    { active: failureCode !== "subscription_expired" }, { active: failureCode !== "subscription_expired" },
  ] });
  const restarted = fixture.openAccess();
  try {
    expect(await dispatchNotifications(restarted, async (_recipient, payload) => { sent.push(payload); }, {
      now: () => new Date(timestamp.getTime() + 60_000),
    })).toEqual({ accepted: status === "retrying" ? 2 : 0, failed: 0 });
    expect(new Set(sent.map((payload) => payload.tag)).size).toBe(1);
    expect(sent.every((payload) => JSON.stringify(payload) === JSON.stringify(sent[0]))).toBe(true);
    expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toEqual(before);
  } finally { restarted.close(); }
});

it("fences abandoned Archive Job delivery claims and competing dispatchers", async () => {
  const { fixture } = await createNotificationFixture();
  const { access, claim: archiveClaim } = await startArchiveJob(fixture);
  access.archiveJobs.fail(archiveClaim, "Synthetic failure");
  const timestamp = new Date();
  const abandoned = access.notifications.claim({ now: timestamp, leaseMs: 1_000 })!;
  access.close();
  const first = fixture.openAccess();
  const second = fixture.openAccess();
  const sent: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const now = () => new Date(timestamp.getTime() + 1_001);
  try {
    const running = dispatchNotifications(first, async (recipient) => { sent.push(recipient.endpoint); started(); await blocked; }, { now });
    await sending;
    expect(second.notifications.settle(abandoned, { status: "accepted" }, now())).toBeNull();
    const competing = await dispatchNotifications(second, async (recipient) => { sent.push(recipient.endpoint); }, { now });
    release();
    const completed = await running;
    expect(completed.accepted + competing.accepted).toBe(2);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: expect.arrayContaining([
      expect.objectContaining({ status: "accepted", attemptCount: 2 }), expect.objectContaining({ status: "accepted", attemptCount: 1 }),
    ]) });
    expect((await fixture.run(["inspect", "archive-jobs", archiveClaim.id])).result).toMatchObject({ item: { status: "failed" } });
  } finally { release(); first.close(); second.close(); }
});
