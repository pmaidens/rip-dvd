import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createApplicationOperations } from "@rip-dvd/application";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";

import { seedDvdDiscVerificationFixture } from "./dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function invokeInNewProcess(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  args: readonly string[],
) {
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      RIP_DVD_DATABASE_PATH: fixture.databasePath,
      RIP_DVD_MEDIA_LIBRARY_PATH: fixture.mediaLibraryPath,
      RIP_DVD_ORIGINALS_LIBRARY_PATH: fixture.originalsLibraryPath,
    },
  });
  return {
    exitCode: result.status,
    result: JSON.parse(result.stdout) as unknown,
  };
}

function stopRecovery(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  recoveryId: string,
  attemptId: string,
) {
  const access = fixture.openAccess();
  try {
    const receipt = createApplicationOperations(access).stopDvdRecovery({
      mutationKey: "00000000-0000-4000-8000-000000000601",
      archiveRecoveryId: recoveryId,
      attemptId,
    });
    return access.archiveRecoveryWork.completeStop({
      archiveRecoveryId: receipt.archiveRecovery.id,
      attemptId: receipt.archiveRecovery.attemptId,
      stopOperationId: receipt.operation.operationId,
    });
  } finally {
    access.close();
  }
}

function resumeArgs(input: {
  recoveryId: string;
  attemptId: string;
  revision: number;
  digest: string;
  mutationKey: string;
  speedMode?: "normal" | "low";
}) {
  return [
    "archive-recovery",
    "resume",
    input.recoveryId,
    "--key",
    input.mutationKey,
    "--attempt-id",
    input.attemptId,
    "--checkpoint-revision",
    String(input.revision),
    "--checkpoint-digest",
    input.digest,
    "--speed-mode",
    input.speedMode ?? "normal",
  ];
}

it("replays Resume after process restart and reports stale identities", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const stopped = stopRecovery(fixture, seeded.recoveryId, seeded.attemptId);
  const mutationKey = "00000000-0000-4000-8000-000000000602";
  const args = resumeArgs({
    recoveryId: stopped.id,
    attemptId: stopped.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey,
    speedMode: "low",
  });
  const access = fixture.openAccess();
  const committed = await createApplicationOperations(access).resumeDvdRecovery({
    mutationKey,
    archiveRecoveryId: stopped.id,
    attemptId: stopped.attemptId,
    checkpointRevision: seeded.pointer.currentManifestRevision,
    checkpointDigest: seeded.pointer.currentManifestDigest,
    speedMode: "low",
  });
  access.close();
  const expected = JSON.parse(JSON.stringify(committed));

  expect(invokeInNewProcess(fixture, args)).toEqual({
    exitCode: 0,
    result: expected,
  });
  expect(invokeInNewProcess(fixture, [
    ...args.slice(0, -1),
    "normal",
  ])).toMatchObject({
    exitCode: 2,
    result: { error: { code: "MUTATION_KEY_CONFLICT" } },
  });
  expect(invokeInNewProcess(fixture, resumeArgs({
    recoveryId: stopped.id,
    attemptId: stopped.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000603",
  }))).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "STALE_RECOVERY_ATTEMPT",
        currentIdentities: {
          archiveRecoveryId: stopped.id,
          attemptId: committed.archiveRecovery.attemptId,
        },
      },
    },
  });
}, 20_000);

it("waits durably for a disc and allows Stop while waiting", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const stopped = stopRecovery(fixture, seeded.recoveryId, seeded.attemptId);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare("UPDATE disc_inspections SET is_current = 0").run();
  database.close();

  const resumed = await fixture.run(resumeArgs({
    recoveryId: stopped.id,
    attemptId: stopped.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000604",
  }));
  expect(resumed).toMatchObject({
    exitCode: 0,
    result: {
      archiveRecovery: {
        status: "waiting_for_disc",
        speedMode: "normal",
        work: { status: "requested" },
      },
      operation: { status: "waiting_for_disc" },
    },
  });

  const access = fixture.openAccess();
  expect(access.archiveRecoveryWork.activateWaitingResume()).toBeNull();
  const waiting = access.catalog.findArchiveRecoveryById(stopped.id)!;
  const stop = access.archiveRecoveryWork.requestStop({
    mutationKey: "00000000-0000-4000-8000-000000000605",
    archiveRecoveryId: waiting.id,
    attemptId: waiting.attemptId,
  });
  const completed = access.archiveRecoveryWork.completeStop({
    archiveRecoveryId: stop.id,
    attemptId: stop.attemptId,
    stopOperationId: stop.stopOperationId,
  });
  expect(completed).toMatchObject({ status: "stopped", work: null });
  access.close();
});

it("activates a waiting Resume only after an insertion appears", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const stopped = stopRecovery(fixture, seeded.recoveryId, seeded.attemptId);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare("UPDATE disc_inspections SET is_current = 0").run();
  database.close();
  await fixture.run(resumeArgs({
    recoveryId: stopped.id,
    attemptId: stopped.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000606",
  }));

  const inserted = new DatabaseSync(fixture.databasePath);
  inserted.prepare(`UPDATE disc_inspections SET is_current = 1
    WHERE id = ?`).run(seeded.inspection.id);
  inserted.close();
  const access = fixture.openAccess();
  try {
    expect(access.archiveRecoveryWork.activateWaitingResume()).toMatchObject({
      status: "eligible",
      work: {
        status: "requested",
        verificationId: expect.any(String),
      },
    });
    expect(access.archiveRecoveryWork.activateWaitingResume()).toBeNull();
  } finally {
    access.close();
  }
});

it("uses the sole current insertion on an alternate drive for Resume", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const stopped = stopRecovery(fixture, seeded.recoveryId, seeded.attemptId);
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE disc_inspections SET is_current = 0").run();
  sqlite.close();
  const access = fixture.openAccess();
  const alternateDrive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-resume-alternate",
    isEnabled: true,
    isPresent: true,
  });
  const alternateDisc = access.catalog.registerDetectedDisc({
    opticalDriveId: alternateDrive.id,
    discKind: "dvd",
    fingerprint: seeded.sourceDisc.fingerprint,
  });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: alternateDrive.id,
    mediaGeneration: "synthetic-resume-alternate-generation",
    mediaCapacityBytes: 1_024 * 2_048,
  });
  access.discInspections.record(started.claim, {
    type: "metadata",
    volumeLabel: "SYNTHETIC_RESUME_ALTERNATE",
    titleCount: 1,
    chapterCount: 1,
    audioStreamCount: 1,
    subtitleStreamCount: 0,
    totalBytes: 1_024 * 2_048,
  });
  const alternateInspection = access.discInspections.record(started.claim, {
    type: "complete",
    detectedDiscId: alternateDisc.id,
  });
  started.restoreSystemTime();
  access.close();

  expect(await fixture.run(resumeArgs({
    recoveryId: stopped.id,
    attemptId: stopped.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000610",
  }))).toMatchObject({
    exitCode: 0,
    result: {
      archiveRecovery: {
        status: "eligible",
        work: { status: "requested" },
      },
    },
  });
  const verified = fixture.openAccess();
  expect(verified.dvdDiscVerifications.findLatestForRecovery(stopped.id))
    .toMatchObject({ discInspectionId: alternateInspection.id });
  verified.close();
});

it("waits when Resume sees ambiguous alternate-drive insertions", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const stopped = stopRecovery(fixture, seeded.recoveryId, seeded.attemptId);
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE disc_inspections SET is_current = 0").run();
  sqlite.close();
  const access = fixture.openAccess();
  for (const ordinal of [1, 2]) {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: `/dev/synthetic-resume-ambiguous-${ordinal}`,
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: `${seeded.sourceDisc.fingerprint}-${ordinal}`,
    });
    const started = beginSettledDiscInspectionForTest(access, {
      opticalDriveId: drive.id,
      mediaGeneration: `synthetic-resume-ambiguous-generation-${ordinal}`,
      mediaCapacityBytes: 1_024 * 2_048,
    });
    access.discInspections.record(started.claim, {
      type: "metadata",
      volumeLabel: `SYNTHETIC_RESUME_AMBIGUOUS_${ordinal}`,
      titleCount: 1,
      chapterCount: 1,
      audioStreamCount: 1,
      subtitleStreamCount: 0,
      totalBytes: 1_024 * 2_048,
    });
    access.discInspections.record(started.claim, {
      type: "complete",
      detectedDiscId: disc.id,
    });
    started.restoreSystemTime();
  }
  access.close();

  expect(await fixture.run(resumeArgs({
    recoveryId: stopped.id,
    attemptId: stopped.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000611",
  }))).toMatchObject({
    exitCode: 0,
    result: {
      archiveRecovery: {
        status: "waiting_for_disc",
        work: { status: "requested" },
      },
    },
  });
  const waiting = fixture.openAccess();
  expect(waiting.catalog.findArchiveRecoveryById(stopped.id)).toMatchObject({
    work: { status: "requested", verificationId: null },
  });
  expect(waiting.dvdDiscVerifications.findLatestForRecovery(stopped.id))
    .toBeNull();
  waiting.close();
});

it("waits for a changed insertion after Resume verification mismatch", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  await fixture.run(resumeArgs({
    recoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000608",
    speedMode: "low",
  }));

  const access = fixture.openAccess();
  const claim = access.dvdDiscVerifications.claimNext(
    "synthetic-resume-mismatch-worker",
  )!;
  const sample = seeded.sampleManifest.samples[0]!;
  const finding = {
    ...sample,
    outcome: "mismatch" as const,
    referenceDigest: sample.digest,
    observedDigest: "f".repeat(64),
    diagnostic: null,
  };
  access.dvdDiscVerifications.appendFinding(claim, finding);
  access.dvdDiscVerifications.complete(claim, {
    findings: [finding],
    budgetExhausted: false,
    interrupted: false,
    insertionChanged: false,
    checkpointChanged: false,
  });
  expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
    .toMatchObject({
      status: "waiting_for_disc",
      speedMode: "low",
      speedRequestResult: null,
      work: { status: "requested", verificationId: null },
    });
  expect(access.archiveRecoveryWork.activateWaitingResume()).toBeNull();

  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: seeded.verificationDrive.id,
    mediaGeneration: "synthetic-changed-resume-generation",
    mediaCapacityBytes: 1_024 * 2_048,
  });
  access.discInspections.record(started.claim, {
    type: "metadata",
    volumeLabel: "SYNTHETIC_CHANGED_RESUME",
    titleCount: 1,
    chapterCount: 1,
    audioStreamCount: 1,
    subtitleStreamCount: 0,
    totalBytes: 1_024 * 2_048,
  });
  const changed = access.discInspections.record(started.claim, {
    type: "complete",
    detectedDiscId: seeded.verificationDisc.id,
  });
  started.restoreSystemTime();
  expect(access.archiveRecoveryWork.activateWaitingResume()).toMatchObject({
    status: "eligible",
    speedRequestResult: null,
    work: { status: "requested", verificationId: expect.any(String) },
  });
  expect(access.dvdDiscVerifications.findLatestForRecovery(
    seeded.recoveryId,
  )).toMatchObject({ discInspectionId: changed.id, status: "queued" });
  access.close();
});

it("retries interrupted Resume verification without another Resume", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  await fixture.run(resumeArgs({
    recoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000609",
  }));

  const access = fixture.openAccess();
  const recovery = access.catalog.findArchiveRecoveryById(seeded.recoveryId)!;
  const claim = access.dvdDiscVerifications.claimNext(
    "synthetic-interrupted-resume-verifier",
  )!;
  const expired = new DatabaseSync(fixture.databasePath);
  expired.prepare(`UPDATE dvd_disc_verifications SET claimed_at = 0
    WHERE id = ?`).run(claim.id);
  expired.close();
  expect(access.dvdDiscVerifications.recoverExpiredClaims()).toBe(1);
  expect(access.dvdDiscVerifications.listForRecoveryAttempt(
    recovery.id,
    recovery.attemptId,
  )).toMatchObject([
    {
      status: "completed",
      outcome: "inconclusive",
      reasons: expect.arrayContaining(["DISC_VERIFICATION_INTERRUPTED"]),
    },
    { status: "queued", discInspectionId: seeded.inspection.id },
  ]);
  expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
    .toMatchObject({
      status: "eligible",
      attemptId: recovery.attemptId,
      work: {
        status: "requested",
        verificationId: expect.any(String),
      },
    });
  const retry = access.dvdDiscVerifications.claimNext(
    "synthetic-interrupted-resume-retry-verifier",
  )!;
  const sample = seeded.sampleManifest.samples[0]!;
  const mismatch = {
    ...sample,
    outcome: "mismatch" as const,
    referenceDigest: sample.digest,
    observedDigest: "e".repeat(64),
    diagnostic: null,
  };
  access.dvdDiscVerifications.appendFinding(retry, mismatch);
  access.dvdDiscVerifications.complete(retry, {
    findings: [mismatch],
    budgetExhausted: false,
    interrupted: false,
    insertionChanged: false,
    checkpointChanged: false,
  });
  expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
    .toMatchObject({
      status: "waiting_for_disc",
      attemptId: recovery.attemptId,
      work: { status: "requested", verificationId: null },
    });
  access.close();
});

it("keeps a repaired storage fault paused until explicit Resume", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const access = fixture.openAccess();
  const claim = access.archiveRecoveryWork.claim(
    access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
    "synthetic-resume-storage-worker",
  );
  const runningDatabase = new DatabaseSync(fixture.databasePath);
  runningDatabase.prepare(`UPDATE archive_recoveries SET
    status = 'running', updated_at = updated_at + 1 WHERE id = ?`)
    .run(seeded.recoveryId);
  runningDatabase.close();
  const paused = access.archiveRecoveryWork.markFault({
    claim,
    faultCode: "STORAGE_UNSUPPORTED",
    retainWork: true,
  });
  expect(paused).toMatchObject({
    status: "paused",
    pauseReason: "storage_fault",
    faultCode: null,
    work: { status: "claimed" },
  });
  const reconciled = access.archiveRecoveryWork.releaseAfterReconciliation({
    archiveRecoveryId: paused.id,
    attemptId: paused.attemptId,
  });
  expect(reconciled).toMatchObject({
    status: "paused",
    pauseReason: "storage_fault",
    work: null,
  });
  access.close();

  expect((await fixture.run(["inspect", "archive-recoveries", reconciled.id]))
    .result).toMatchObject({
      item: {
        recoveryStatus: "paused",
        availableActions: expect.arrayContaining([
          expect.objectContaining({ name: "resume", available: true }),
        ]),
      },
    });
  expect(await fixture.run(resumeArgs({
    recoveryId: reconciled.id,
    attemptId: reconciled.attemptId,
    revision: seeded.pointer.currentManifestRevision,
    digest: seeded.pointer.currentManifestDigest,
    mutationKey: "00000000-0000-4000-8000-000000000607",
  }))).toMatchObject({
    exitCode: 0,
    result: { archiveRecovery: { status: "eligible", pauseReason: null } },
  });
});
