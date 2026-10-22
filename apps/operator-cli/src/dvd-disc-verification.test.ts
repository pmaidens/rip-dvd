import { afterEach, expect, it, vi } from "vitest";
import { createDataAccess } from "@rip-dvd/data-access";

import { seedDvdDiscVerificationFixture } from "./dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => {
  vi.useRealTimers();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

it("inspects, submits, replays, and rejects stale inserted-disc verification", async () => {
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
    sourceSampleManifest: { policyVersion: "dvd-source-verification-v1" },
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
    result: { error: { code: "DISC_INSERTION_CHANGED" } },
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
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_001);
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
