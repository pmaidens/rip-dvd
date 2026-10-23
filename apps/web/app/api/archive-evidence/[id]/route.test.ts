import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  utimesSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import {
  ENCODE_JOB_LEASE_DURATION_MS,
  type DvdDiscVerificationId,
  type DvdRecoveryWriteAuthority,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";
import {
  commitDvdRecoveryBatch,
  type DvdRecoveryAtomicWriter,
} from "../../../../../archive-worker/src/dvd-recovery-batch.js";
import { reconcileDvdRecoveryCheckpoint } from "../../../../../archive-worker/src/dvd-recovery-reconciliation.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedCommittedArchiveEvidence } from "../../../../../operator-cli/src/archive-evidence.test-support.js";
import { createArchiveEvidenceRoute } from "./route";

const RECOVERY_TEST_TIMEOUT_MS = 15_000;

const syntheticAtomicWriter: DvdRecoveryAtomicWriter = {
  inspect() {
    return {
      contract: "linux-rwf-atomic-v1",
      unitBytes: 4_096,
      memoryAlignmentBytes: 512,
    };
  },
  write({ imagePath, startByte, bytes, unitBytes }) {
    const descriptor = openSync(imagePath, "r+");
    try {
      const bytesWritten = writeSync(
        descriptor,
        bytes,
        0,
        bytes.length,
        startByte,
      );
      fsyncSync(descriptor);
      return { bytesWritten, unitBytes };
    } finally {
      closeSync(descriptor);
    }
  },
  restoreVersion({ imagePath, mtimeNs }) {
    const current = lstatSync(imagePath, { bigint: true });
    utimesSync(
      imagePath,
      Number(current.atimeNs) / 1_000_000_000,
      Number(BigInt(mtimeNs)) / 1_000_000_000,
    );
    return {
      mtimeNs: lstatSync(imagePath, { bigint: true }).mtimeNs.toString(),
    };
  },
};

function recordSupportedRecoveryStorage(
  access: ReturnType<ReturnType<typeof createOperatorWorkflowFixture>["openAccess"]>,
  unitBytes = 4_096,
) {
  access.dvdRecoveryStorage.record({
    contractVersion: "dvd-recovery-storage-preflight-v1",
    status: "supported",
    reasonCode: null,
    facts: {
      filesystemType: "synthetic-local",
      storageClass: "local",
      mutationProtection: {
        status: "verified",
        contract: "linux-rwf-atomic-v1",
        unitBytes,
        memoryAlignmentBytes: 512,
      },
      journalReservationBytes: 1_048_576,
      journalPayloadBytes: 983_040,
      journalReservation: "verified",
      journalSynchronization: "verified",
      imageSynchronization: "verified",
      checkpointSynchronization: "verified",
      checkpointReplacement: "verified",
      directorySynchronization: "verified",
      crossProcessWriterExclusion: "verified",
      crossHostWriterExclusion: "not_applicable",
      disconnectionBehavior: "not_applicable",
    },
  });
}

function prepareEligibleRecovery(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  archiveId: string,
  ranges: readonly { startLba: number; sectorCount: number }[],
): DvdRecoveryWriteAuthority {
  const badSectorCount = ranges.reduce(
    (count, range) => count + range.sectorCount,
    0,
  );
  let database = new DatabaseSync(fixture.databasePath);
  try {
    database.prepare(`UPDATE original_disc_archives SET
      integrity = 'incomplete_read', integrity_evidence_revision = 1,
      integrity_policy_version = 'dvd-recovery-evidence-v1',
      bad_sector_count = ?, bad_area_count = ?, bad_sector_ranges = ?
      WHERE id = ?`).run(
      badSectorCount,
      ranges.length,
      JSON.stringify(ranges),
      archiveId,
    );
    database.prepare(`INSERT INTO archive_recoveries (
      id, original_disc_archive_id, attempt_id, attempt_ordinal, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'eligible', 1, 1)`).run(
      `${archiveId}:recovery`,
      archiveId,
      `${archiveId}:recovery:attempt:1`,
    );
  } finally {
    database.close();
  }
  const access = fixture.openAccess();
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [archiveId as OriginalDiscArchiveId],
  })[0]!;
  const recovery = access.catalog.findArchiveRecovery(archive.id)!;
  const sourceDisc = access.catalog.listDetectedDiscs(undefined, {
    ids: [archive.detectedDiscId],
  })[0]!;
  const drive = access.catalog.listOpticalDrives({
    ids: [sourceDisc.opticalDriveId],
  })[0]!;
  access.catalog.upsertOpticalDrive({
    devicePath: drive.devicePath,
    isEnabled: true,
    isPresent: true,
  });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: sourceDisc.opticalDriveId,
    mediaGeneration: "synthetic-recovery-generation",
    mediaCapacityBytes: 1_024 * 2_048,
  });
  access.discInspections.record(started.claim, {
    type: "metadata",
    volumeLabel: "SYNTHETIC_RECOVERY",
    titleCount: 1,
    chapterCount: 1,
    audioStreamCount: 1,
    subtitleStreamCount: 0,
    totalBytes: 1_024 * 2_048,
  });
  const inspection = access.discInspections.record(started.claim, {
    type: "complete",
    detectedDiscId: sourceDisc.id,
  });
  started.restoreSystemTime();
  const header = access.catalog.findDvdArchiveEvidenceHeader(archive.id)!;
  access.close();

  const verificationId = `${archiveId}:verification` as DvdDiscVerificationId;
  const workerExecutionId = "synthetic-verification-worker-execution";
  database = new DatabaseSync(fixture.databasePath);
  try {
    database.prepare(`INSERT INTO dvd_disc_verifications (
      id, archive_recovery_id, archive_recovery_attempt_id, attempt_ordinal,
      original_disc_archive_id,
      disc_inspection_id, detected_disc_id, media_generation,
      source_metadata_fingerprint, observed_metadata_fingerprint,
      checkpoint_revision, checkpoint_digest, status, outcome, reasons,
      findings, budget_exhausted, worker_execution_id, claim_token,
      claimed_at, started_at, completed_at, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'match', '[]',
      '[]', 0, ?, NULL, NULL, 1, 1, NULL, 1, 1)`).run(
      verificationId,
      recovery.id,
      recovery.attemptId,
      archive.id,
      inspection.id,
      sourceDisc.id,
      inspection.mediaGeneration,
      archive.fingerprint,
      archive.fingerprint,
      header.currentManifestRevision,
      header.currentManifestDigest,
      workerExecutionId,
    );
  } finally {
    database.close();
  }
  return {
    verificationId,
    archiveRecoveryId: recovery.id,
    archiveRecoveryAttemptId: recovery.attemptId,
    originalDiscArchiveId: archive.id,
    discInspectionId: inspection.id,
    detectedDiscId: sourceDisc.id,
    mediaGeneration: inspection.mediaGeneration,
    verificationWorkerExecutionId: workerExecutionId,
    checkpointRevision: header.currentManifestRevision,
    checkpointDigest: header.currentManifestDigest,
  };
}

function claimRecovery(
  access: ReturnType<ReturnType<typeof createOperatorWorkflowFixture>["openAccess"]>,
  archiveId: OriginalDiscArchiveId,
) {
  const recovery = access.catalog.findArchiveRecovery(archiveId);
  if (recovery === null) throw new Error("Expected Archive Recovery");
  return access.archiveRecoveryWork.claim(
    recovery.id,
    "synthetic-recovery-worker",
  );
}

it.each(["clean", "damaged", "long", "historical", "missing"])("matches CLI evidence and paging for %s", async (kind) => {
  const fixture = createOperatorWorkflowFixture();
  const ranges = kind === "long" ? Array.from({ length: 113 }, (_, index) => ({ startLba: index * 2, sectorCount: 1, classification: "skipped_untested" as const })) : kind === "damaged" ? [{ startLba: 8, sectorCount: 64, classification: "skipped_untested" as const }] : [];
  const saved = kind === "historical" ? seedCatalogReviewForReadFixture(fixture) : await seedCommittedArchiveEvidence(fixture, ranges);
  if (kind === "missing" && "directory" in saved) unlinkSync(join(saved.directory, "checkpoint.json"));
  const access = fixture.openAccess();
  try {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "10" });
      const args = ["archive-evidence", saved.archive.id, "--limit", "10"];
      if (cursor !== null) { query.set("cursor", cursor); args.push("--cursor", cursor); }
      const web = await createArchiveEvidenceRoute(new Request(`http://localhost/api/archive-evidence/${saved.archive.id}?${query}`), saved.archive.id, () => access);
      const cli = await fixture.run(args);
      expect(web.status).toBe(200);
      expect(web.headers.get("Cache-Control")).toBe("no-store");
      const body = await web.json();
      expect(cli.result).toEqual(body);
      cursor = body.nextCursor;
    } while (cursor !== null);
  } finally { access.close(); fixture.dispose(); }
});

it("keeps web and CLI evidence reads unavailable throughout a writer interval", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture);
  const access = fixture.openAccess();
  try {
    await defaultArchiveImageOwnership.withInitialPublicationWriter({
      archiveId: saved.archive.id,
      imagePath: saved.archive.archivePath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        const web = await createArchiveEvidenceRoute(
          new Request(
            `http://localhost/api/archive-evidence/${saved.archive.id}`,
          ),
          saved.archive.id,
          () => access,
        );
        const cli = await fixture.run(["archive-evidence", saved.archive.id]);
        const body = await web.json();
        expect(web.status).toBe(200);
        expect(cli.exitCode).toBe(0);
        expect(body).toMatchObject({
          available: false,
          unavailableReason: "WRITER_NOT_QUIESCENT",
        });
        expect(cli.result).toEqual(body);
      },
    });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("rejects a recovery batch without a current durable work claim", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  const imageBefore = readFileSync(saved.archive.archivePath);
  try {
    const staleClaim = claimRecovery(access, saved.archive.id);
    access.archiveRecoveryWork.release(staleClaim);
    await expect(commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim: staleClaim,
      writeAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x61),
      },
      atomicWriter: {
        inspect() { throw new Error("Stale work must fail before image I/O"); },
        write() { throw new Error("Stale work must fail before image I/O"); },
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(readFileSync(saved.archive.archivePath)).toEqual(imageBefore);
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(false);
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("rejects a recovery batch whose durable claim is released before mutation", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  const imageBefore = readFileSync(saved.archive.archivePath);
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    await expect(commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x62),
      },
      atomicWriter: syntheticAtomicWriter,
      fault(point) {
        if (point === "before:journal") {
          access.archiveRecoveryWork.release(recoveryWorkClaim);
        }
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(readFileSync(saved.archive.archivePath)).toEqual(imageBefore);
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(false);
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it.each(["removed", "replaced"] as const)(
  "rejects a recovery batch when the verified source is %s before mutation",
  async (change) => {
    const fixture = createOperatorWorkflowFixture();
    const saved = await seedCommittedArchiveEvidence(fixture, [{
      startLba: 10,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
    const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
      startLba: 10,
      sectorCount: 1,
    }]);
    const access = fixture.openAccess();
    const imageBefore = readFileSync(saved.archive.archivePath);
    try {
      recordSupportedRecoveryStorage(access);
      const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
      await expect(commitDvdRecoveryBatch({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        recoveryWorkClaim,
        writeAuthority,
        observation: {
          startLba: 10,
          outcome: "recovered",
          bytes: Buffer.alloc(2_048, 0x63),
        },
        atomicWriter: syntheticAtomicWriter,
        fault(point) {
          if (point !== "before:journal") return;
          const inspection = access.discInspections.list({
            ids: [writeAuthority.discInspectionId],
          })[0]!;
          access.discInspections.clearCurrent({
            opticalDriveId: inspection.opticalDriveId,
            ...(change === "replaced"
              ? { mediaGeneration: "synthetic-replacement-generation" }
              : {}),
          });
          if (change === "replaced") {
            const replacement = beginSettledDiscInspectionForTest(access, {
              opticalDriveId: inspection.opticalDriveId,
              mediaGeneration: "synthetic-replacement-generation",
              mediaCapacityBytes: 1_024 * 2_048,
            });
            access.discInspections.record(replacement.claim, {
              type: "metadata",
              volumeLabel: "SYNTHETIC_REPLACEMENT",
              titleCount: 1,
              chapterCount: 1,
              audioStreamCount: 1,
              subtitleStreamCount: 0,
              totalBytes: 1_024 * 2_048,
            });
            access.discInspections.record(replacement.claim, {
              type: "complete",
              detectedDiscId: writeAuthority.detectedDiscId,
            });
            replacement.restoreSystemTime();
          }
        },
      })).rejects.toMatchObject({ code: "DISC_VERIFICATION_STALE" });
      expect(readFileSync(saved.archive.archivePath)).toEqual(imageBefore);
      expect(existsSync(join(saved.directory, "recovery-journal.bin")))
        .toBe(false);
    } finally {
      access.close();
      fixture.dispose();
    }
  },
  RECOVERY_TEST_TIMEOUT_MS,
);

it("commits one recovered sector through the worker and shared web/CLI evidence read", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 2,
  }]);
  const access = fixture.openAccess();
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    const recoveryDatabase = new DatabaseSync(fixture.databasePath);
    recoveryDatabase.prepare(`
      UPDATE archive_recovery_work
      SET claimed_at = ?, updated_at = ?
      WHERE archive_recovery_id = ?
    `).run(
      Date.now() - ENCODE_JOB_LEASE_DURATION_MS - 1,
      Date.now() - ENCODE_JOB_LEASE_DURATION_MS - 1,
      recoveryWorkClaim.archiveRecoveryId,
    );
    recoveryDatabase.close();
    const recovered = Buffer.alloc(2_048, 0x7b);
    const committed = await commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: { startLba: 10, outcome: "recovered", bytes: recovered },
      atomicWriter: syntheticAtomicWriter,
    });

    expect(committed.header).toMatchObject({
      currentManifestRevision: 2,
      currentManifestId: `${saved.archive.id}:recovery:2`,
    });
    expect(access.catalog.listOriginalDiscArchives({ ids: [saved.archive.id] })[0])
      .toMatchObject({
        integrity: "incomplete_read",
        badSectorCount: 1,
      });
    expect(access.catalog.findArchiveRecovery(saved.archive.id)).toMatchObject({
      status: "running",
    });
    const image = readFileSync(saved.archive.archivePath);
    expect(image.subarray(10 * 2_048, 11 * 2_048)).toEqual(recovered);
    expect(image.subarray(11 * 2_048, 12 * 2_048)).toEqual(Buffer.alloc(2_048));
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(false);

    const web = await createArchiveEvidenceRoute(
      new Request(`http://localhost/api/archive-evidence/${saved.archive.id}`),
      saved.archive.id,
      () => access,
    );
    const cli = await fixture.run(["archive-evidence", saved.archive.id]);
    const body = await web.json();
    expect(web.status).toBe(200);
    expect(cli.result).toEqual(body);
    expect(body.unavailableReason).toBe(null);
    expect(body).toMatchObject({
      available: true,
      revision: { number: 2, manifestId: `${saved.archive.id}:recovery:2` },
      evidence: { unresolvedSectorCount: 1, skippedSectorCount: 1 },
      ranges: [{
        startLba: 11,
        sectorCount: 1,
        classification: "skipped_untested",
      }],
    });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("records a failed source read without mutating the archive image", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 2,
  }]);
  const access = fixture.openAccess();
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    const before = readFileSync(saved.archive.archivePath);
    await commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: { startLba: 10, outcome: "failed" },
      atomicWriter: {
        inspect() { throw new Error("A failed source read must not inspect mutation support"); },
        write() { throw new Error("A failed source read must not write"); },
      },
    });

    expect(readFileSync(saved.archive.archivePath)).toEqual(before);
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(false);
    expect((await fixture.run(["archive-evidence", saved.archive.id])).result)
      .toMatchObject({
        available: true,
        revision: { number: 2 },
        evidence: {
          unresolvedSectorCount: 2,
          classifications: { skipped_untested: 1, individually_failed: 1 },
        },
        ranges: [
          { startLba: 10, sectorCount: 1, classification: "individually_failed" },
          { startLba: 11, sectorCount: 1, classification: "skipped_untested" },
        ],
      });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("writes every atomic unit needed to cover one recovered sector", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  const writes: number[] = [];
  try {
    recordSupportedRecoveryStorage(access, 1_024);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    await commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x29),
      },
      atomicWriter: {
        inspect() {
          return {
            contract: "linux-rwf-atomic-v1",
            unitBytes: 1_024,
            memoryAlignmentBytes: 512,
          };
        },
        write(input) {
          writes.push(input.startByte);
          return syntheticAtomicWriter.write(input);
        },
      },
    });
    expect(writes).toEqual([20_480, 21_504]);
    expect(readFileSync(saved.archive.archivePath).subarray(10 * 2_048, 11 * 2_048))
      .toEqual(Buffer.alloc(2_048, 0x29));
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("rejects a batch at the final readable checkpoint before mutation", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  const imageBefore = readFileSync(saved.archive.archivePath);
  const header = access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id)!;
  const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
  access.archiveRecoveryWork.bindVerification(
    recoveryWorkClaim,
    writeAuthority,
  );
  const capacityDatabase = new DatabaseSync(fixture.databasePath);
  capacityDatabase.prepare(`
    UPDATE dvd_disc_verifications
    SET checkpoint_revision = 10000
    WHERE id = ?
  `).run(writeAuthority.verificationId);
  capacityDatabase.close();
  const capacityWriteAuthority = {
    ...writeAuthority,
    checkpointRevision: 10_000,
  };
  const cappedAccess = {
    ...access,
    catalog: {
      ...access.catalog,
      findDvdArchiveEvidenceHeader() {
        return { ...header, currentManifestRevision: 10_000 };
      },
    },
  };
  try {
    await expect(commitDvdRecoveryBatch({
      access: cappedAccess,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority: capacityWriteAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x2a),
      },
      atomicWriter: {
        inspect() { throw new Error("Capacity must be checked before image inspection"); },
        write() { throw new Error("Capacity must be checked before image mutation"); },
      },
    })).rejects.toMatchObject({ code: "CHECKPOINT_CAPACITY_EXHAUSTED" });
    expect(readFileSync(saved.archive.archivePath)).toEqual(imageBefore);
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(false);
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("rejects a partial protected-unit write without projecting recovery", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    await expect(commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x33),
      },
      atomicWriter: {
        ...syntheticAtomicWriter,
        write() { return { bytesWritten: 1, unitBytes: 4_096 }; },
      },
    })).rejects.toMatchObject({ code: "IMAGE_WRITE_FAILED" });
    expect(access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id))
      .toMatchObject({ currentManifestRevision: 1 });
    expect(readFileSync(saved.archive.archivePath).subarray(10 * 2_048, 11 * 2_048))
      .toEqual(Buffer.alloc(2_048));
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(true);
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it.each([
  ["journal", "after:journal", false],
  ["write", "after:write", true],
  ["image sync", "after:image_sync", true],
  ["manifest", "after:manifest", true],
  ["pointer", "after:pointer", true],
] as const)("fails closed after a %s boundary fault", async (_name, faultPoint, imageChanged) => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    await expect(commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x55),
      },
      atomicWriter: syntheticAtomicWriter,
      fault(point) {
        if (point === faultPoint) throw new Error(`synthetic ${faultPoint}`);
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

    expect(access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id)).toMatchObject({
      currentManifestRevision: 1,
    });
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(true);
    expect(readFileSync(saved.archive.archivePath).subarray(10 * 2_048, 11 * 2_048))
      .toEqual(Buffer.alloc(2_048, imageChanged ? 0x55 : 0));
    expect((await fixture.run(["archive-evidence", saved.archive.id])).result)
      .toMatchObject({ available: false, unavailableReason: "CONSISTENCY_FAULT" });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it.each([
  ["journal", "after:journal", "rolled_back", 1, false],
  ["write", "after:write", "rolled_back", 1, false],
  ["image sync", "after:image_sync", "rolled_back", 1, false],
  ["manifest", "after:manifest", "rolled_back", 1, false],
  ["pointer", "after:pointer", "rolled_forward", 2, true],
  ["database", "after:database", "cleaned_up", 2, true],
  ["cleanup", "after:cleanup", "already_consistent", 2, true],
] as const)(
  "reconciles a crash after %s and is idempotent",
  async (_name, faultPoint, outcome, revision, recovered) => {
    const fixture = createOperatorWorkflowFixture();
    const saved = await seedCommittedArchiveEvidence(fixture, [{
      startLba: 10,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
    const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
      startLba: 10,
      sectorCount: 1,
    }]);
    const access = fixture.openAccess();
    try {
      recordSupportedRecoveryStorage(access);
      const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
      await expect(commitDvdRecoveryBatch({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        recoveryWorkClaim,
        writeAuthority,
        observation: {
          startLba: 10,
          outcome: "recovered",
          bytes: Buffer.alloc(2_048, 0x6a),
        },
        atomicWriter: syntheticAtomicWriter,
        fault(point) {
          if (point === faultPoint) throw new Error(`synthetic ${faultPoint}`);
        },
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

      expect(access.catalog.findArchiveRecoveryById(
        recoveryWorkClaim.archiveRecoveryId,
      )).toMatchObject({
        status: "running",
        work: { claimToken: recoveryWorkClaim.claimToken },
      });

      const result = await reconcileDvdRecoveryCheckpoint({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        atomicWriter: syntheticAtomicWriter,
      });
      expect(result).toMatchObject({
        outcome,
        evidence: {
          authoritativeCheckpoint: { revision },
          databaseProjectionAfter: { revision },
          journal: faultPoint === "after:cleanup" ? "absent" : "removed",
        },
      });
      expect(access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id))
        .toMatchObject({ currentManifestRevision: revision });
      expect(
        readFileSync(saved.archive.archivePath)
          .subarray(10 * 2_048, 11 * 2_048),
      ).toEqual(Buffer.alloc(2_048, recovered ? 0x6a : 0));
      expect(existsSync(join(saved.directory, "recovery-journal.bin")))
        .toBe(false);

      await expect(reconcileDvdRecoveryCheckpoint({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        atomicWriter: syntheticAtomicWriter,
      })).resolves.toMatchObject({ outcome: "already_consistent" });
    } finally {
      access.close();
      fixture.dispose();
    }
  },
  RECOVERY_TEST_TIMEOUT_MS,
);

it("removes an uncommitted failed-read manifest without a journal", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 2,
  }]);
  const access = fixture.openAccess();
  const manifestPath = join(saved.directory, "recovery-manifest-2.json");
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    const imageBefore = readFileSync(saved.archive.archivePath);
    await expect(commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: { startLba: 10, outcome: "failed" },
      atomicWriter: syntheticAtomicWriter,
      fault(point) {
        if (point === "after:manifest") throw new Error("synthetic crash");
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(join(saved.directory, "recovery-journal.bin"))).toBe(false);

    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      atomicWriter: syntheticAtomicWriter,
    })).resolves.toMatchObject({
      outcome: "rolled_back",
      evidence: {
        authoritativeCheckpoint: { revision: 1 },
        journal: "absent",
        uncommittedManifest: "removed",
      },
    });
    expect(existsSync(manifestPath)).toBe(false);
    expect(readFileSync(saved.archive.archivePath)).toEqual(imageBefore);
    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      atomicWriter: syntheticAtomicWriter,
    })).resolves.toMatchObject({ outcome: "already_consistent" });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it.each([
  ["before rollback", "after:manifest", "before:rollback", 1, false, "rolled_back"],
  ["after rollback", "after:manifest", "after:rollback", 1, false, "rolled_back"],
  ["before rollback sync", "after:manifest", "before:rollback_sync", 1, false, "rolled_back"],
  ["after rollback sync", "after:manifest", "after:rollback_sync", 1, false, "rolled_back"],
  ["before projection", "after:pointer", "before:projection", 2, true, "rolled_forward"],
  ["after projection", "after:pointer", "after:projection", 2, true, "cleaned_up"],
  ["before cleanup", "after:database", "before:cleanup", 2, true, "cleaned_up"],
  ["after cleanup", "after:database", "after:cleanup", 2, true, "already_consistent"],
] as const)(
  "retries reconciliation after a crash %s",
  async (
    _name,
    batchFault,
    reconciliationFault,
    finalRevision,
    recovered,
    retryOutcome,
  ) => {
    const fixture = createOperatorWorkflowFixture();
    const saved = await seedCommittedArchiveEvidence(fixture, [{
      startLba: 10,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
    const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
      startLba: 10,
      sectorCount: 1,
    }]);
    const access = fixture.openAccess();
    const journalPath = join(saved.directory, "recovery-journal.bin");
    const manifestPath = join(saved.directory, "recovery-manifest-2.json");
    try {
      recordSupportedRecoveryStorage(access);
      const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
      await expect(commitDvdRecoveryBatch({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        recoveryWorkClaim,
        writeAuthority,
        observation: {
          startLba: 10,
          outcome: "recovered",
          bytes: Buffer.alloc(2_048, 0x63),
        },
        atomicWriter: syntheticAtomicWriter,
        fault(point) {
          if (point === batchFault) throw new Error(`synthetic ${batchFault}`);
        },
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

      await expect(reconcileDvdRecoveryCheckpoint({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        atomicWriter: syntheticAtomicWriter,
        fault(point) {
          if (point === reconciliationFault) {
            throw new Error(`synthetic ${reconciliationFault}`);
          }
        },
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
      const cleanupFinished = String(reconciliationFault) === "after:cleanup";
      expect(existsSync(journalPath)).toBe(
        !cleanupFinished,
      );
      expect(existsSync(manifestPath)).toBe(
        finalRevision === 2 || !cleanupFinished,
      );

      await expect(reconcileDvdRecoveryCheckpoint({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        atomicWriter: syntheticAtomicWriter,
      })).resolves.toMatchObject({ outcome: retryOutcome });
      expect(access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id))
        .toMatchObject({ currentManifestRevision: finalRevision });
      expect(
        readFileSync(saved.archive.archivePath)
          .subarray(10 * 2_048, 11 * 2_048),
      ).toEqual(Buffer.alloc(2_048, recovered ? 0x63 : 0));
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      access.close();
      fixture.dispose();
    }
  },
  RECOVERY_TEST_TIMEOUT_MS,
);

it("retains corrupt recovery evidence and reports a consistency fault", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  const journalPath = join(saved.directory, "recovery-journal.bin");
  try {
    recordSupportedRecoveryStorage(access);
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    await expect(commitDvdRecoveryBatch({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
      writeAuthority,
      observation: {
        startLba: 10,
        outcome: "recovered",
        bytes: Buffer.alloc(2_048, 0x4d),
      },
      atomicWriter: syntheticAtomicWriter,
      fault(point) {
        if (point === "after:journal") throw new Error("synthetic crash");
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    const corrupt = readFileSync(journalPath);
    corrupt[0] = 0;
    writeFileSync(journalPath, corrupt);

    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      atomicWriter: syntheticAtomicWriter,
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(existsSync(journalPath)).toBe(true);
    expect(access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id))
      .toMatchObject({ currentManifestRevision: 1 });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it.each([
  ["missing journal", "after:pointer"],
  ["corrupt manifest", "after:pointer"],
  ["wrong image extent", "after:journal"],
  ["wrong image identity", "after:journal"],
  ["changed protected bytes", "after:write"],
  ["failed rollback", "after:write"],
] as const)(
  "retains interrupted evidence for %s",
  async (failure, faultPoint) => {
    const fixture = createOperatorWorkflowFixture();
    const saved = await seedCommittedArchiveEvidence(fixture, [{
      startLba: 10,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
    const imageBefore = readFileSync(saved.archive.archivePath);
    const writeAuthority = prepareEligibleRecovery(fixture, saved.archive.id, [{
      startLba: 10,
      sectorCount: 1,
    }]);
    const access = fixture.openAccess();
    const journalPath = join(saved.directory, "recovery-journal.bin");
    const nextManifestPath = join(
      saved.directory,
      "recovery-manifest-2.json",
    );
    try {
      recordSupportedRecoveryStorage(access);
      const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
      await expect(commitDvdRecoveryBatch({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        recoveryWorkClaim,
        writeAuthority,
        observation: {
          startLba: 10,
          outcome: "recovered",
          bytes: Buffer.alloc(2_048, 0x5c),
        },
        atomicWriter: syntheticAtomicWriter,
        fault(point) {
          if (point === faultPoint) throw new Error(`synthetic ${faultPoint}`);
        },
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

      if (failure === "missing journal") {
        unlinkSync(journalPath);
      } else if (failure === "corrupt manifest") {
        writeFileSync(nextManifestPath, "{}");
      } else if (failure === "wrong image extent") {
        truncateSync(saved.archive.archivePath, imageBefore.length - 1);
      } else if (failure === "wrong image identity") {
        renameSync(saved.archive.archivePath, `${saved.archive.archivePath}.old`);
        writeFileSync(saved.archive.archivePath, imageBefore);
      } else if (failure === "changed protected bytes") {
        const descriptor = openSync(saved.archive.archivePath, "r+");
        try {
          writeSync(descriptor, Buffer.alloc(4_096, 0x71), 0, 4_096, 20_480);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
      const reconciliationWriter = failure === "failed rollback"
        ? {
            ...syntheticAtomicWriter,
            write() {
              throw new Error("synthetic rollback failure");
            },
          }
        : failure === "wrong image identity"
        ? {
            ...syntheticAtomicWriter,
            inspect() {
              throw new Error("native helper rejected the image identity");
            },
          }
        : syntheticAtomicWriter;

      await expect(reconcileDvdRecoveryCheckpoint({
        access,
        originalsLibraryPath: fixture.originalsLibraryPath,
        originalDiscArchiveId: saved.archive.id,
        atomicWriter: reconciliationWriter,
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
      expect(access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id))
        .toMatchObject({ currentManifestRevision: 1 });
      expect(existsSync(nextManifestPath)).toBe(
        faultPoint === "after:pointer",
      );
      expect(existsSync(journalPath)).toBe(failure !== "missing journal");
    } finally {
      access.close();
      fixture.dispose();
    }
  },
  RECOVERY_TEST_TIMEOUT_MS,
);

it("fails while an archive writer remains active", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  try {
    await defaultArchiveImageOwnership.withWriter({
      archiveId: saved.archive.id,
      imagePath: saved.archive.archivePath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        await expect(reconcileDvdRecoveryCheckpoint({
          access,
          originalsLibraryPath: fixture.originalsLibraryPath,
          originalDiscArchiveId: saved.archive.id,
          atomicWriter: syntheticAtomicWriter,
        })).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });
      },
    });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("releases stale recovery work only after archive ownership exits", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  try {
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    let ownershipActive = false;
    const ownership: ArchiveImageOwnership = {
      ...defaultArchiveImageOwnership,
      async withWriter(request) {
        ownershipActive = true;
        const result = await defaultArchiveImageOwnership.withWriter({
          ...request,
          async task(handle) {
            const reconciled = await request.task(handle);
            expect(access.catalog.findArchiveRecovery(saved.archive.id))
              .toMatchObject({
                work: { claimToken: recoveryWorkClaim.claimToken },
              });
            return reconciled;
          },
        });
        ownershipActive = false;
        return result;
      },
    };
    const release = vi.spyOn(access.archiveRecoveryWork, "release");

    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      atomicWriter: syntheticAtomicWriter,
      archiveImageOwnership: ownership,
    })).resolves.toMatchObject({ outcome: "already_consistent" });

    expect(ownershipActive).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(access.catalog.findArchiveRecovery(saved.archive.id))
      .toMatchObject({ work: null });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("preserves recovery work when Stop wins the reconciliation release race", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  try {
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    const ownership: ArchiveImageOwnership = {
      ...defaultArchiveImageOwnership,
      async withWriter(request) {
        const result = await defaultArchiveImageOwnership.withWriter(request);
        access.archiveRecoveryWork.requestStop({
          mutationKey: "00000000-0000-4000-8000-000000000478",
          archiveRecoveryId: recoveryWorkClaim.archiveRecoveryId,
          attemptId: recoveryWorkClaim.attemptId,
        });
        return result;
      },
    };

    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      atomicWriter: syntheticAtomicWriter,
      archiveImageOwnership: ownership,
    })).resolves.toMatchObject({ outcome: "already_consistent" });

    expect(access.catalog.findArchiveRecovery(saved.archive.id))
      .toMatchObject({
        status: "stopping",
        work: { claimToken: recoveryWorkClaim.claimToken },
      });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it("accepts Stop completion racing reconciliation cleanup", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  try {
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    const stop = access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000487",
      archiveRecoveryId: recoveryWorkClaim.archiveRecoveryId,
      attemptId: recoveryWorkClaim.attemptId,
    });
    const findArchiveRecovery =
      access.catalog.findArchiveRecovery.bind(access.catalog);
    let recoveryReads = 0;
    vi.spyOn(access.catalog, "findArchiveRecovery").mockImplementation(
      (archiveId) => {
        const snapshot = findArchiveRecovery(archiveId);
        recoveryReads += 1;
        if (recoveryReads === 2) {
          access.archiveRecoveryWork.completeStop({
            archiveRecoveryId: recoveryWorkClaim.archiveRecoveryId,
            attemptId: recoveryWorkClaim.attemptId,
            stopOperationId: stop.stopOperationId,
          });
        }
        return snapshot;
      },
    );

    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      atomicWriter: syntheticAtomicWriter,
    })).resolves.toMatchObject({ outcome: "already_consistent" });

    expect(recoveryReads).toBe(2);
    expect(findArchiveRecovery(saved.archive.id)).toMatchObject({
      status: "stopped",
      work: null,
    });
  } finally {
    access.close();
    fixture.dispose();
  }
}, RECOVERY_TEST_TIMEOUT_MS);

it.each(["limit=0", "limit=101", "cursor=bad", "offset=1", "limit=1&limit=2"])("rejects invalid paging %s", async (query) => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const response = await createArchiveEvidenceRoute(new Request(`http://localhost/api/archive-evidence/synthetic?${query}`), "synthetic", () => access);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  } finally { access.close(); fixture.dispose(); }
});
