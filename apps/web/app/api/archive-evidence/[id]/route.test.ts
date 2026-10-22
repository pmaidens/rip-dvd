import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { defaultArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import {
  ENCODE_JOB_LEASE_DURATION_MS,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  commitDvdRecoveryBatch,
  type DvdRecoveryAtomicWriter,
} from "../../../../../archive-worker/src/dvd-recovery-batch.js";
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
) {
  const badSectorCount = ranges.reduce(
    (count, range) => count + range.sectorCount,
    0,
  );
  const database = new DatabaseSync(fixture.databasePath);
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
      id, original_disc_archive_id, status, created_at, updated_at
    ) VALUES (?, ?, 'eligible', 1, 1)`).run(
      `${archiveId}:recovery`,
      archiveId,
    );
  } finally {
    database.close();
  }
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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

it("commits one recovered sector through the worker and shared web/CLI evidence read", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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
      status: "eligible",
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
    startLba: 10,
    sectorCount: 1,
  }]);
  const access = fixture.openAccess();
  const imageBefore = readFileSync(saved.archive.archivePath);
  const header = access.catalog.findDvdArchiveEvidenceHeader(saved.archive.id)!;
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
    const recoveryWorkClaim = claimRecovery(access, saved.archive.id);
    await expect(commitDvdRecoveryBatch({
      access: cappedAccess,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: saved.archive.id,
      recoveryWorkClaim,
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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
  prepareEligibleRecovery(fixture, saved.archive.id, [{
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

it.each(["limit=0", "limit=101", "cursor=bad", "offset=1", "limit=1&limit=2"])("rejects invalid paging %s", async (query) => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const response = await createArchiveEvidenceRoute(new Request(`http://localhost/api/archive-evidence/synthetic?${query}`), "synthetic", () => access);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  } finally { access.close(); fixture.dispose(); }
});
