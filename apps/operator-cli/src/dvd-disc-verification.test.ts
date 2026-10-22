import { afterEach, expect, it } from "vitest";

import { seedDvdDiscVerificationFixture } from "./dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("inspects, submits, replays, and rejects stale inserted-disc verification", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const { recoveryId, inspection, sourceDisc } = seeded;

  const inspected = await fixture.run([
    "inspect-verification", "--archive-recovery-id", recoveryId,
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
    "verify-disc",
    "--key", key,
    "--archive-recovery-id", recoveryId,
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
    "inspect-verification", "--archive-recovery-id", recoveryId,
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
  workerAccess.dvdDiscVerifications.complete(claim, {
    outcome: "match",
    reasons: [],
    findings: seeded.sampleManifest.samples.map((sample) => ({
      ...sample,
      outcome: "match" as const,
      referenceDigest: sample.digest,
      observedDigest: sample.digest,
      diagnostic: null,
    })),
    budgetExhausted: false,
  });
  workerAccess.close();
  const matched = await fixture.run([
    "inspect-verification", "--archive-recovery-id", recoveryId,
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
    "inspect-verification", "--archive-recovery-id", recoveryId,
  ]);
  expect(invalidated.result).toMatchObject({
    verification: { status: "completed", outcome: "match", current: false },
    writeAuthority: {
      available: false,
      blockingReasons: [{ code: "DISC_VERIFICATION_STALE" }],
    },
  });
  const stale = await fixture.run([
    "verify-disc",
    "--key", "00000000-0000-4000-8000-000000000440",
    "--archive-recovery-id", recoveryId,
    "--disc-inspection-id", inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(stale).toMatchObject({
    exitCode: 2,
    result: { error: { code: "DISC_INSERTION_CHANGED" } },
  });
});
