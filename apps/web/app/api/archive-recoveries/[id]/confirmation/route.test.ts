import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  createDvdDiscVerificationResultDigest,
  type DvdDiscVerificationDiagnostic,
} from "@rip-dvd/data-access";

import { seedDvdDiscVerificationFixture } from "../../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import {
  createDvdDiscConfirmationPreviewRoute,
  createDvdDiscConfirmationRoute,
} from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

function request(id: string, body: unknown): Request {
  return new Request(
    `http://localhost:3000/api/archive-recoveries/${id}/confirmation`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    },
  );
}

const mediumError: DvdDiscVerificationDiagnostic = {
  category: "medium_error",
  classifierVersion: "scsi-read-classifier-v2",
  scsiStatus: 2,
  hostStatus: 0,
  driverStatus: 8,
  senseResponseCode: 0x70,
  senseKey: 3,
  asc: 0x11,
  ascq: 0,
  informationLba: null,
};

async function completeUncertainVerification(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  outcome: "mismatch" | "inconclusive",
  options: {
    mutationKey?: string;
    workerExecutionId?: string;
    unrecoveredSourceRanges?: Parameters<
      typeof seedDvdDiscVerificationFixture
    >[1];
  } = {},
) {
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    options.unrecoveredSourceRanges,
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", options.mutationKey ??
      "00000000-0000-4000-8000-000000000443",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const access = fixture.openAccess();
  try {
    const claim = access.dvdDiscVerifications.claimNext(
      options.workerExecutionId ?? "synthetic-confirmation-worker",
    )!;
    const sample = seeded.sampleManifest.samples[0]!;
    const finding = outcome === "mismatch"
      ? {
          ...sample,
          outcome: "mismatch" as const,
          referenceDigest: sample.digest,
          observedDigest: "f".repeat(64),
          diagnostic: null,
        }
      : {
          ...sample,
          outcome: "unreadable" as const,
          referenceDigest: sample.digest,
          observedDigest: null,
          diagnostic: mediumError,
        };
    access.dvdDiscVerifications.appendFinding(claim, finding);
    const verification = access.dvdDiscVerifications.complete(claim, {
      findings: [finding],
      budgetExhausted: outcome === "inconclusive",
      interrupted: false,
      insertionChanged: false,
      checkpointChanged: false,
    });
    expect(verification.outcome).toBe(outcome);
    return { seeded, verification };
  } finally {
    access.close();
  }
}

function cliConfirmationCommand(
  recoveryId: string,
  body: Record<string, unknown>,
) {
  return [
    "archive-recovery", "confirm-disc", recoveryId,
    "--key", String(body.mutationKey),
    "--archive-id", String(body.originalDiscArchiveId),
    "--attempt-id", String(body.archiveRecoveryAttemptId),
    "--disc-inspection-id", String(body.discInspectionId),
    "--detected-disc-id", String(body.detectedDiscId),
    "--media-generation", String(body.mediaGeneration),
    "--verification-id", String(body.verificationId),
    "--verification-execution-id",
    String(body.verificationWorkerExecutionId),
    "--verification-outcome", String(body.verificationOutcome),
    "--verification-result-digest", String(body.verificationResultDigest),
    "--checkpoint-revision", String(body.checkpointRevision),
    "--checkpoint-digest", String(body.checkpointDigest),
    "--acknowledge-mixed-source",
  ];
}

it.each(["mismatch", "inconclusive"] as const)(
  "keeps web preview and replayed %s confirmation equal to the JSON CLI",
  async (outcome) => {
    const fixture = createOperatorWorkflowFixture();
    fixtures.push(fixture);
    const { seeded, verification } = await completeUncertainVerification(
      fixture,
      outcome,
    );
    const access = fixture.openAccess();
    try {
      const webPreview = await createDvdDiscConfirmationPreviewRoute(
        seeded.recoveryId,
        () => access,
      );
      const cliPreview = await fixture.run([
        "archive-recovery", "preview-disc-confirmation", seeded.recoveryId,
      ]);
      expect(webPreview.status).toBe(200);
      expect(webPreview.headers.get("Cache-Control")).toBe("no-store");
      const preview = await webPreview.json();
      expect(preview).toEqual(cliPreview.result);
      expect(preview).toMatchObject({
        verification: { id: verification.id, outcome },
        action: { available: true },
      });

      const body = {
        ...(preview as { action: { expectedInputs: Record<string, unknown> } })
          .action.expectedInputs,
        mutationKey: outcome === "mismatch"
          ? "00000000-0000-4000-8000-000000000444"
          : "00000000-0000-4000-8000-000000000445",
      };
      const webRecorded = await createDvdDiscConfirmationRoute(
        request(seeded.recoveryId, body),
        seeded.recoveryId,
        () => access,
        () => "http://localhost:3000",
      );
      const cliReplay = await fixture.run(
        cliConfirmationCommand(seeded.recoveryId, body),
      );
      expect(webRecorded.status).toBe(201);
      expect(cliReplay.exitCode).toBe(0);
      expect(await webRecorded.json()).toEqual(cliReplay.result);
    } finally {
      access.close();
    }
  },
);

it("rejects web and CLI confirmation when storage becomes unsupported after preview", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { seeded } = await completeUncertainVerification(
    fixture,
    "mismatch",
  );
  const access = fixture.openAccess();
  try {
    const previewResponse = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    const preview = await previewResponse.json() as {
      action: { expectedInputs: Record<string, unknown> };
    };
    const body = {
      ...preview.action.expectedInputs,
      mutationKey: "00000000-0000-4000-8000-000000000446",
    };
    const supported = access.dvdRecoveryStorage.readCurrent();
    if (supported === null) throw new Error("Expected storage preflight");
    access.dvdRecoveryStorage.record({
      contractVersion: supported.contractVersion,
      status: "unsupported",
      reasonCode: "STORAGE_UNSUPPORTED",
      facts: {
        ...supported.facts,
        mutationProtection: {
          status: "unproven",
          contract: null,
          unitBytes: null,
          memoryAlignmentBytes: null,
        },
      },
    });

    const webResponse = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, body),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(webResponse.status).toBe(409);
    expect(await webResponse.json()).toMatchObject({
      error: {
        code: "STORAGE_UNSUPPORTED",
        blockingReasons: [{ code: "STORAGE_UNSUPPORTED" }],
      },
    });

    const cliResponse = await fixture.run(
      cliConfirmationCommand(seeded.recoveryId, body),
    );
    expect(cliResponse).toMatchObject({
      exitCode: 2,
      result: {
        error: {
          code: "STORAGE_UNSUPPORTED",
          blockingReasons: [{ code: "STORAGE_UNSUPPORTED" }],
        },
      },
    });
    expect(access.dvdDiscConfirmations.listForRecovery(seeded.recoveryId))
      .toEqual([]);
  } finally {
    access.close();
  }
});

it("rejects a stale preview atomically with current identities", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { seeded, verification } = await completeUncertainVerification(
    fixture,
    "mismatch",
  );
  const access = fixture.openAccess();
  try {
    const preview = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    const expectedInputs = (await preview.json() as {
      action: { expectedInputs: Record<string, unknown> };
    }).action.expectedInputs;
    const unacknowledged = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, {
        ...expectedInputs,
        mutationKey: "00000000-0000-4000-8000-000000000447",
        acknowledgeMixedSource: false,
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(unacknowledged.status).toBe(400);
    expect(access.dvdDiscConfirmations.listForRecovery(seeded.recoveryId))
      .toEqual([]);
    access.discInspections.clearCurrent({
      opticalDriveId: seeded.verificationDrive.id,
    });
    const response = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, {
        ...expectedInputs,
        mutationKey: "00000000-0000-4000-8000-000000000448",
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "DISC_CONFIRMATION_EXPIRED",
        reasons: [{ code: "DISC_INSERTION_CHANGED" }],
      },
    });
    expect(access.dvdDiscConfirmations.listForRecovery(seeded.recoveryId))
      .toEqual([]);
    expect(access.dvdDiscVerifications.find(verification.id)).not.toBeNull();
  } finally {
    access.close();
  }
});

it("rejects rebasing an earlier verification onto a different checkpoint", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { seeded, verification } = await completeUncertainVerification(
    fixture,
    "mismatch",
  );
  const access = fixture.openAccess();
  try {
    const previewResponse = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    const expectedInputs = (await previewResponse.json() as {
      action: { expectedInputs: Record<string, unknown> };
    }).action.expectedInputs;
    const sqlite = new DatabaseSync(fixture.databasePath);
    sqlite.prepare(`
      update dvd_disc_verifications
      set checkpoint_revision = ?, checkpoint_digest = ?
      where id = ?
    `).run(2, "b".repeat(64), verification.id);
    sqlite.close();
    const changedVerification = access.dvdDiscVerifications.find(
      verification.id,
    );
    if (changedVerification === null) {
      throw new Error("Expected changed DVD Disc Verification");
    }

    const response = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, {
        ...expectedInputs,
        mutationKey: "00000000-0000-4000-8000-000000000453",
        verificationResultDigest: createDvdDiscVerificationResultDigest(
          changedVerification,
        ),
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "DISC_CONFIRMATION_EXPIRED",
        reasons: [{ code: "DISC_CHECKPOINT_CHANGED" }],
      },
    });
    expect(access.dvdDiscConfirmations.listForRecovery(seeded.recoveryId))
      .toEqual([]);
  } finally {
    access.close();
  }
});

it("bounds recovered-range provenance independently from aggregate counts", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { seeded, verification } = await completeUncertainVerification(
    fixture,
    "mismatch",
    {
      unrecoveredSourceRanges: [{
        startLba: 0,
        sectorCount: 202,
        classification: "skipped_untested",
      }],
    },
  );
  const access = fixture.openAccess();
  try {
    const previewResponse = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    const expectedInputs = (await previewResponse.json() as {
      action: { expectedInputs: Record<string, unknown> };
    }).action.expectedInputs;
    const recordResponse = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, {
        ...expectedInputs,
        mutationKey: "00000000-0000-4000-8000-000000000454",
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(recordResponse.status).toBe(201);
    const recorded = await recordResponse.json() as {
      confirmation: { id: string };
    };
    const sqlite = new DatabaseSync(fixture.databasePath);
    const insert = sqlite.prepare(`
      insert into dvd_archive_recovery_reads (
        id,
        original_disc_archive_id,
        from_manifest_id,
        from_manifest_revision,
        start_lba,
        sector_count,
        outcome,
        verification_id,
        disc_confirmation_id,
        evidence_digest,
        created_at
      ) values (?, ?, ?, ?, ?, 1, 'recovered', ?, ?, ?, ?)
    `);
    sqlite.exec("begin immediate");
    try {
      for (let index = 0; index < 101; index += 1) {
        insert.run(
          `synthetic-confirmed-read-${index}`,
          seeded.archive.id,
          seeded.manifest.id,
          seeded.manifest.revision,
          index * 2,
          verification.id,
          recorded.confirmation.id,
          "a".repeat(64),
          Date.now() + index,
        );
      }
      sqlite.exec("commit");
    } catch (error) {
      sqlite.exec("rollback");
      throw error;
    } finally {
      sqlite.close();
    }

    const provenanceResponse = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    expect(provenanceResponse.status).toBe(200);
    const provenance = await provenanceResponse.json() as {
      provenance: {
        confirmations: Array<{
          recoveredSectorCount: number;
          recoveredRanges: unknown[];
          recoveredRangesTruncated: boolean;
        }>;
      };
    };
    expect(provenance.provenance.confirmations[0]).toMatchObject({
      recoveredSectorCount: 101,
      recoveredRangesTruncated: true,
    });
    expect(provenance.provenance.confirmations[0]?.recoveredRanges)
      .toHaveLength(100);
  } finally {
    access.close();
  }
});

it("requires a fresh verification after restart expiry", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { seeded } = await completeUncertainVerification(fixture, "mismatch");
  const access = fixture.openAccess();
  try {
    const initialPreview = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    const expectedInputs = (await initialPreview.json() as {
      action: { expectedInputs: Record<string, unknown> };
    }).action.expectedInputs;
    const recorded = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, {
        ...expectedInputs,
        mutationKey: "00000000-0000-4000-8000-000000000449",
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(recorded.status).toBe(201);
    expect(access.dvdDiscConfirmations.expireForWorkerExecution(
      "synthetic-restarted-worker",
    )).toBe(1);

    const expiredPreview = await createDvdDiscConfirmationPreviewRoute(
      seeded.recoveryId,
      () => access,
    );
    expect(await expiredPreview.json()).toMatchObject({
      confirmation: { current: false, expiredAt: expect.any(String) },
      writeAuthority: { available: false },
      action: {
        available: false,
        expectedInputs: null,
        blockingReasons: [{ code: "DISC_CONFIRMATION_EXPIRED" }],
      },
    });

    const repeated = await createDvdDiscConfirmationRoute(
      request(seeded.recoveryId, {
        ...expectedInputs,
        mutationKey: "00000000-0000-4000-8000-000000000450",
      }),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      error: {
        code: "DISC_CONFIRMATION_EXPIRED",
        reasons: [{ code: "WORKER_EXECUTION_CHANGED" }],
      },
    });
  } finally {
    access.close();
  }
});

it("reports one coherent latest verification identity on stale input", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const first = await completeUncertainVerification(fixture, "mismatch");
  const access = fixture.openAccess();
  try {
    const preview = await createDvdDiscConfirmationPreviewRoute(
      first.seeded.recoveryId,
      () => access,
    );
    const staleInputs = (await preview.json() as {
      action: { expectedInputs: Record<string, unknown> };
    }).action.expectedInputs;
    const submitted = await fixture.run([
      "archive-recovery", "verify-disc", first.seeded.recoveryId,
      "--key", "00000000-0000-4000-8000-000000000451",
      "--disc-inspection-id", first.seeded.inspection.id,
      "--checkpoint-revision", "1",
      "--checkpoint-digest", first.seeded.manifest.manifestDigest,
    ]);
    expect(submitted.exitCode).toBe(0);
    const claim = access.dvdDiscVerifications.claimNext(
      "synthetic-latest-confirmation-worker",
    )!;
    const sample = first.seeded.sampleManifest.samples[0]!;
    const finding = {
      ...sample,
      outcome: "unreadable" as const,
      referenceDigest: sample.digest,
      observedDigest: null,
      diagnostic: mediumError,
    };
    access.dvdDiscVerifications.appendFinding(claim, finding);
    const latest = access.dvdDiscVerifications.complete(claim, {
      findings: [finding],
      budgetExhausted: true,
      interrupted: false,
      insertionChanged: false,
      checkpointChanged: false,
    });
    const response = await createDvdDiscConfirmationRoute(
      request(first.seeded.recoveryId, {
        ...staleInputs,
        mutationKey: "00000000-0000-4000-8000-000000000452",
      }),
      first.seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "DISC_CONFIRMATION_EXPIRED",
        currentIdentities: {
          verificationId: latest.id,
          verificationWorkerExecutionId:
            "synthetic-latest-confirmation-worker",
          verificationResultDigest:
            createDvdDiscVerificationResultDigest(latest),
          insertion: {
            discInspectionId: latest.discInspectionId,
            detectedDiscId: latest.detectedDiscId,
            mediaGeneration: latest.mediaGeneration,
          },
        },
      },
    });
  } finally {
    access.close();
  }
});
