import { renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDataAccess,
  DVD_DISC_VERIFICATION_CLAIM_LEASE_MS,
  DVD_DISC_VERIFICATION_READ_DEADLINE_MS,
  type ArchiveRecoveryId,
} from "@rip-dvd/data-access";

import { seedDvdDiscVerificationFixture } from "./dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => {
  vi.useRealTimers();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

it("inspects, submits, replays, and rejects stale DVD Disc Verification", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const { recoveryId, inspection, sourceDisc } = seeded;

  const inspected = await fixture.run([
    "archive-recovery", "inspect-verification", recoveryId,
  ]);
  expect(inspected).toMatchObject({ exitCode: 0, stderr: "" });
  expect(inspected.result).toMatchObject({
    archiveRecovery: { id: recoveryId, status: "eligible" },
    checkpoint: { revision: 1, digest: seeded.manifest.manifestDigest },
    insertion: {
      discInspectionId: inspection.id,
      detectedDiscId: sourceDisc.id,
      mediaGeneration: "synthetic-verification-generation",
    },
    sourceSampleManifest: { policyVersion: "dvd-disc-verification-v1" },
    verification: null,
    writeAuthority: { available: false },
    action: { name: "verify-disc", available: true },
  });

  const key = "00000000-0000-4000-8000-000000000439";
  const command = [
    "archive-recovery", "verify-disc", recoveryId,
    "--key", key,
    "--disc-inspection-id", inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ] as const;
  const submitted = await fixture.run(command);
  const replayed = await fixture.run(command);
  expect(submitted).toMatchObject({
    exitCode: 0,
    result: { verification: { status: "queued", current: true } },
  });
  expect(replayed.result).toEqual(submitted.result);

  const checkpointPath = join(seeded.directory, "checkpoint.json");
  const hiddenCheckpointPath = `${checkpointPath}.hidden`;
  renameSync(checkpointPath, hiddenCheckpointPath);
  try {
    const replayWithoutCheckpoint = await fixture.run(command);
    expect(replayWithoutCheckpoint.result).toEqual(submitted.result);
    const changedReplay = await fixture.run([
      ...command.slice(0, -1),
      "f".repeat(64),
    ]);
    expect(changedReplay).toMatchObject({
      exitCode: 2,
      result: { error: { code: "MUTATION_KEY_CONFLICT" } },
    });
  } finally {
    renameSync(hiddenCheckpointPath, checkpointPath);
  }

  const after = await fixture.run([
    "archive-recovery", "inspect-verification", recoveryId,
  ]);
  expect(after.result).toMatchObject({
    verification: {
      id: (submitted.result as { verification: { id: string } }).verification.id,
      status: "queued",
      current: true,
    },
    action: {
      available: false,
      blockingReasons: [{ code: "DISC_VERIFICATION_ACTIVE" }],
    },
  });

  const workerAccess = fixture.openAccess();
  const claim = workerAccess.dvdDiscVerifications.claimNext(
    "synthetic-verification-worker-execution",
  )!;
  const findings = seeded.sampleManifest.samples.map((sample) => ({
      ...sample,
      outcome: "match" as const,
      referenceDigest: sample.digest,
      observedDigest: sample.digest,
      diagnostic: null,
    }));
  for (const finding of findings) {
    workerAccess.dvdDiscVerifications.appendFinding(claim, finding);
  }
  expect(() => workerAccess.dvdDiscVerifications.complete(claim, {
    findings: findings.slice(0, -1),
    budgetExhausted: false,
    interrupted: false,
    insertionChanged: false,
    checkpointChanged: false,
  })).toThrow("findings were not durably recorded");
  workerAccess.dvdDiscVerifications.complete(claim, {
    findings,
    budgetExhausted: false,
    interrupted: false,
    insertionChanged: false,
    checkpointChanged: false,
  });
  workerAccess.close();
  const matched = await fixture.run([
    "archive-recovery", "inspect-verification", recoveryId,
  ]);
  expect(matched.result).toMatchObject({
    verification: {
      status: "completed",
      outcome: "match",
      workerExecutionId: "synthetic-verification-worker-execution",
      checkpointRevision: 1,
      checkpointDigest: seeded.manifest.manifestDigest,
      findings: expect.arrayContaining([
        expect.objectContaining({ bandIndex: 0, outcome: "match" }),
      ]),
    },
    writeAuthority: { available: true, blockingReasons: [] },
  });

  const storageAccess = fixture.openAccess();
  const supportedPreflight = storageAccess.dvdRecoveryStorage.readCurrent()!;
  storageAccess.dvdRecoveryStorage.record({
    ...supportedPreflight,
    status: "unsupported",
    reasonCode: "STORAGE_UNSUPPORTED",
  });
  storageAccess.close();
  const storageBlocked = await fixture.run([
    "archive-recovery", "inspect-verification", recoveryId,
  ]);
  expect(storageBlocked.result).toMatchObject({
    verification: { status: "completed", outcome: "match", current: true },
    writeAuthority: {
      available: false,
      blockingReasons: [
        expect.objectContaining({ code: "STORAGE_UNSUPPORTED" }),
      ],
    },
  });
  const restoredStorageAccess = fixture.openAccess();
  restoredStorageAccess.dvdRecoveryStorage.record({
    ...supportedPreflight,
    status: "supported",
    reasonCode: null,
  });
  restoredStorageAccess.close();

  const staleAccess = fixture.openAccess();
  staleAccess.discInspections.clearCurrent({
    opticalDriveId: sourceDisc.opticalDriveId,
  });
  staleAccess.close();
  const invalidated = await fixture.run([
    "archive-recovery", "inspect-verification", recoveryId,
  ]);
  expect(invalidated.result).toMatchObject({
    verification: { status: "completed", outcome: "match", current: false },
    writeAuthority: {
      available: false,
      blockingReasons: [{ code: "DISC_VERIFICATION_STALE" }],
    },
  });
  const stale = await fixture.run([
    "archive-recovery", "verify-disc", recoveryId,
    "--key", "00000000-0000-4000-8000-000000000440",
    "--disc-inspection-id", inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(stale).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "DISC_INSERTION_CHANGED",
        reasons: [{ code: "DISC_INSERTION_CHANGED" }],
        currentIdentities: {
          checkpoint: {
            revision: 1,
            digest: seeded.manifest.manifestDigest,
          },
          insertion: null,
          insertionCandidates: [],
        },
      },
    },
  });
});

it("keeps a durable mismatch authoritative when a worker claim expires", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000443",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);

  const access = fixture.openAccess();
  try {
    const claim = access.dvdDiscVerifications.claimNext(
      "synthetic-expired-worker-execution",
    )!;
    const sample = seeded.sampleManifest.samples[0]!;
    access.dvdDiscVerifications.appendFinding(claim, {
      ...sample,
      outcome: "mismatch",
      referenceDigest: sample.digest,
      observedDigest: "f".repeat(64),
      diagnostic: null,
    });
    const claimTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(
      claimTime + DVD_DISC_VERIFICATION_READ_DEADLINE_MS + 1,
    );
    expect(access.dvdDiscVerifications.recoverExpiredClaims()).toBe(0);
    vi.setSystemTime(
      claimTime + DVD_DISC_VERIFICATION_CLAIM_LEASE_MS + 1,
    );
    expect(access.dvdDiscVerifications.recoverExpiredClaims()).toBe(1);
    expect(access.dvdDiscVerifications.find(claim.id)).toMatchObject({
      status: "completed",
      outcome: "mismatch",
      workerExecutionId: "synthetic-expired-worker-execution",
      findings: [{ outcome: "mismatch" }],
      reasons: [
        "DISC_SAMPLE_MISMATCH",
        "DISC_SAMPLE_COVERAGE_INCOMPLETE",
        "DISC_VERIFICATION_INTERRUPTED",
      ],
    });
  } finally {
    access.close();
  }
});

it("reports unavailable checkpoint storage as a stable action reason", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);

  const inspected = await fixture.run([
    "archive-recovery", "inspect-verification", seeded.recoveryId,
  ], undefined, undefined, {
    openAccess: () => createDataAccess({ databasePath: fixture.databasePath }),
  });

  expect(inspected).toMatchObject({
    exitCode: 0,
    result: {
      checkpoint: null,
      action: {
        available: false,
        blockingReasons: expect.arrayContaining([
          expect.objectContaining({ code: "STORAGE_UNSUPPORTED" }),
        ]),
      },
    },
  });

  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000445",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ], undefined, undefined, {
    openAccess: () => createDataAccess({ databasePath: fixture.databasePath }),
  });
  expect(submitted).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "STORAGE_UNSUPPORTED",
        blockingReasons: [
          expect.objectContaining({ code: "STORAGE_UNSUPPORTED" }),
        ],
      },
    },
  });
});

it("selects the latest verification by its durable attempt sequence", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  const submit = (key: string) => fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", key,
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  const first = await submit("00000000-0000-4000-8000-000000000446");
  const firstId = (first.result as { verification: { id: string } })
    .verification.id;
  const worker = fixture.openAccess();
  worker.dvdDiscVerifications.fail(
    worker.dvdDiscVerifications.claimNext("first-attempt-worker")!,
  );
  worker.close();
  const second = await submit("00000000-0000-4000-8000-000000000447");
  const secondId = (second.result as { verification: { id: string } })
    .verification.id;

  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE dvd_disc_verifications SET id = ? WHERE id = ?")
    .run("zzzz-older-attempt", firstId);
  sqlite.prepare("UPDATE dvd_disc_verifications SET id = ? WHERE id = ?")
    .run("aaaa-newer-attempt", secondId);
  sqlite.close();

  const access = fixture.openAccess();
  try {
    const recovery = access.catalog.findArchiveRecoveryById(
      seeded.recoveryId as ArchiveRecoveryId,
    )!;
    expect(access.dvdDiscVerifications.findLatestForRecovery(
      recovery.id,
    )).toMatchObject({
      id: "aaaa-newer-attempt",
      attemptOrdinal: 2,
      createdAt: new Date("2026-10-22T12:00:00.000Z"),
    });
  } finally {
    access.close();
  }
});
