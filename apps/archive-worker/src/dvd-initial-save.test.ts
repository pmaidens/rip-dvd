import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  createDvdArchiveEvidenceManifestDigests,
  createDvdArchiveRecoveryReadEvidenceDigest,
  createDataAccess,
  dvdSourceSampleCandidates,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  type RunningArchiveJob,
} from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";
import {
  createArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import { runDvdInitialArchiveBoundaryForArchiveJob } from "./dvd-initial-boundary.js";
import { isoProfileImage } from "./dvd-metadata-profile-fixtures.js";
import { createInProcessDvdRescueWorkspaceLock } from "./dvd-rescue-workspace-lock.js";
import { DvdInitialCopyBoundaryError } from "./dvd-initial-copy.js";
import { saveDvdInitialArchiveForArchiveJob, reconcileDvdInitialArchiveForArchiveJob, runDvdInitialArchiveJob } from "./dvd-initial-save.js";
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  damaged = false,
  corrected = false,
  distributedSamples = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "dvd-initial-publication-"));
  directories.push(directory);
  const originalsLibraryPath = join(directory, "originals");
  const staging = join(directory, "request");
  await mkdir(originalsLibraryPath);
  await mkdir(staging);
  const sectorCount = distributedSamples ? 1_024 : 64;
  const image = distributedSamples
    ? Buffer.alloc(sectorCount * 2_048)
    : isoProfileImage();
  if (distributedSamples) {
    for (let bandIndex = 0; bandIndex < DVD_SOURCE_SAMPLE_BAND_COUNT; bandIndex += 1) {
      const startLba = dvdSourceSampleCandidates({
        acceptedEndLbaExclusive: sectorCount,
        bandIndex,
        unrecoveredSourceRanges: [],
      })[0]!;
      image[startLba * 2_048 + DVD_SOURCE_SAMPLE_BYTE_COUNT - 1] =
        bandIndex + 1;
    }
  }
  if (damaged) {
    image.fill(0, 32 * 2048, 33 * 2048);
    image.fill(0, 41 * 2048, 42 * 2048);
    image.fill(0, 47 * 2048, 49 * 2048);
    image.fill(0, 63 * 2048, 64 * 2048);
  }
  const boundary: Parameters<typeof runDvdInitialArchiveBoundaryForArchiveJob>[0] = {
    authorizeBoundaryProbe() {},
    devicePath: "/dev/dvd",
    endpointProver: { async prove() {
      return {
        proofVersion: "dvd-normal-endpoint-proof-v1", confirmationCount: 2,
        firstExcludedLba: sectorCount,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2", scsiStatus: 2,
          hostStatus: 0, driverStatus: 8, senseResponseCode: 0x72,
          senseKey: 5, asc: 0x21, ascq: 0,
        },
      };
    } },
    expectedTitleMap: { schemaVersion: 2, contentId: `dvdmeta-sha256:${"0".repeat(64)}`, titles: [{ number: 1, durationSeconds: 60, chapters: 1, audioStreams: [], subtitles: [] }] },
    ...(distributedSamples ? {
      fullExtentMetadataValidator: {
        async validate() {
          return {
            policyVersion: "dvd-full-extent-metadata-v1" as const,
            decision: "publishable" as const,
            impact: "listed_checks_agree" as const,
            observations: [],
            blockers: [],
          };
        },
      },
    } : {}),
    onProgress() {},
    outputPath: join(staging, "image.partial"),
    completenessProver: { async prove() { return { maximumReferencedLba: 63 }; } },
    runner: {
      async copyInitial({ outputPath }) {
        await writeFile(outputPath, image);
        const result = {
          copyPolicyVersion: "dvd-initial-copy-v1" as const, declaredByteCount: corrected ? 80 * 2048 : image.length,
          recoveredByteCount: image.length - (damaged ? 5 * 2048 : 0), skippedRequestCount: damaged ? 4 : 0,
          diagnosticsTruncated: false, diagnostics: damaged ? [[32, 1], [41, 1], [47, 2], [63, 1]].map(([start, count]) => ({
            classification: "tolerable_medium_error" as const, classifierVersion: "scsi-read-classifier-v2" as const,
            requestedLba: start!, requestedBlockCount: count!, retryOrdinal: 0,
            scsiStatus: 2, hostStatus: 0 as const, driverStatus: 8, senseResponseCode: 0x70 as const,
            senseKey: 3 as const, asc: 0x11, ascq: 0, informationLba: start!,
          })) : [], unrecoveredSourceRanges: damaged ? [{ startLba: 32, sectorCount: 1, classification: "skipped_untested" as const }, { startLba: 41, sectorCount: 1, classification: "skipped_untested" as const }, { startLba: 47, sectorCount: 2, classification: "skipped_untested" as const }, { startLba: 63, sectorCount: 1, classification: "skipped_untested" as const }] : [],
        };
        if (corrected) throw new DvdInitialCopyBoundaryError({
          protocolVersion: 1, category: "out_of_range", classifierVersion: "scsi-read-classifier-v2",
          scsiStatus: 2, hostStatus: 0, driverStatus: 8, senseResponseCode: 0x72,
          senseKey: 5, asc: 0x21, ascq: 0, informationLba: 64,
          requestedLba: 64, requestedBlockCount: 1, retryOrdinal: 1,
          declaredByteCount: 80 * 2048, firstFailingLba: 64, retainedImageByteCount: image.length,
          boundaryProofVersion: "dvd-sector-boundary-proof-v1", candidateConfirmationCount: 2, precedingSectorLba: 63,
        }, result);
        return result;
      },
      async waitForInactive() {},
    },
    signal: new AbortController().signal,
    sizeBytes: corrected ? 80 * 2048 : image.length,
  };
  const proven = await runDvdInitialArchiveBoundaryForArchiveJob(boundary);
  return {
    image, proven, boundary,
    identity: { originalsLibraryPath, originalDiscArchiveId: "synthetic-archive", sourceArchiveJobId: "synthetic-job", imageFingerprint: `dvdmeta-sha256:${"0".repeat(64)}` },
  };
}


async function jobFixture(
  damaged = false,
  corrected = false,
  distributedSamples = false,
) {
  const f = await fixture(damaged, corrected, distributedSamples);
  const databasePath = join(f.identity.originalsLibraryPath, "..", "catalog.sqlite");
  const access = createDataAccess({
    databasePath,
    originalsLibraryPath: f.identity.originalsLibraryPath,
  });
  const drive = access.catalog.upsertOpticalDrive({ devicePath: "/dev/synthetic-dvd", isPresent: true, isEnabled: true });
  const disc = access.catalog.registerDetectedDisc({ opticalDriveId: drive.id, fingerprint: f.identity.imageFingerprint, discKind: "dvd", volumeLabel: "SYNTHETIC", scanData: { schemaVersion: 2, contentId: f.identity.imageFingerprint, titles: [{ number: 1, durationSeconds: 60, chapters: 1, audioStreams: [], subtitles: [] }] } });
  const started = beginSettledDiscInspectionForTest(access, { opticalDriveId: drive.id, mediaGeneration: "synthetic-generation", mediaCapacityBytes: f.boundary.sizeBytes });
  access.discInspections.record(started.claim, { type: "metadata", volumeLabel: "SYNTHETIC", titleCount: 0, chapterCount: 0, audioStreamCount: 0, subtitleStreamCount: 0, totalBytes: f.boundary.sizeBytes });
  const inspection = access.discInspections.record(started.claim, { type: "complete", detectedDiscId: disc.id });
  started.restoreSystemTime();
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.archiveRequests.create({ detectedDiscId: disc.id });
  const claim = access.archiveJobs.startForInspection(inspection.id, "synthetic-worker")!;
  access.close();
  // Admission is deliberately closed. Seed the already-running marked contract.
  const sqlite = new DatabaseSync(databasePath);
  const guards = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('dvd_evidence_archive_job_update_guard', 'dvd_evidence_archive_request_update_guard')").all();
  sqlite.exec("DROP TRIGGER dvd_evidence_archive_job_update_guard; DROP TRIGGER dvd_evidence_archive_request_update_guard");
  sqlite.prepare("UPDATE archive_requests SET evidence_format = 'dvd-recovery-evidence-v1' WHERE id = ?").run(claim.archiveRequestId);
  sqlite.prepare("UPDATE archive_jobs SET evidence_format = 'dvd-recovery-evidence-v1' WHERE id = ?").run(claim.id);
  for (const guard of guards) sqlite.exec(String(guard.sql));
  sqlite.close();
  const reopened = createDataAccess({
    databasePath,
    originalsLibraryPath: f.identity.originalsLibraryPath,
  });
  return { ...f, access: reopened, claim: reopened.archiveJobs.find(claim.id) as RunningArchiveJob, databasePath, exclusion: createInProcessDvdRescueWorkspaceLock() };
}

it.each([false, true])("saves the initial image, full evidence, job, request and separate Recovery together, damaged=%s", async (damaged) => {
  const f = await jobFixture(damaged);
  try {
    const saved = await saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion, proven: f.proven });
    const id = saved.originalDiscArchiveId!;
    expect(saved.status).toBe("completed");
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("fulfilled");
    expect(f.access.catalog.findArchiveRecovery(id)?.status).toBe(damaged ? "eligible" : "completed");
    const archive = f.access.catalog.listOriginalDiscArchives({ ids: [id] })[0]!;
    expect(archive.integrity).toBe(damaged ? "incomplete_read" : "clean_read");
    expect(await readFile(archive.archivePath)).toEqual(f.image);
    const header = f.access.catalog.findDvdArchiveEvidenceHeader(id)!;
    expect(header.unrecoveredSourceRanges).toEqual(damaged ? [{ startLba: 32, sectorCount: 1, classification: "skipped_untested" as const }, { startLba: 41, sectorCount: 1, classification: "skipped_untested" as const }, { startLba: 47, sectorCount: 2, classification: "skipped_untested" as const }, { startLba: 63, sectorCount: 1, classification: "skipped_untested" as const }] : []);
    expect(header.acceptedEndLbaExclusive).toBe(64);
    const pointer = JSON.parse(await readFile(join(f.identity.originalsLibraryPath, ".dvd-evidence", id, "checkpoint.json"), "utf8"));
    expect(pointer.currentManifestDigest).toBe(header.currentManifestDigest);
    expect((await reconcileDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion })).originalDiscArchiveId).toBe(id);
    expect(f.access.catalog.listOriginalDiscArchives({})).toHaveLength(1);
  } finally { f.access.close(); }
});

it("publishes and persists all sixteen distributed source samples", async () => {
  const f = await jobFixture(false, false, true);
  const saved = await saveDvdInitialArchiveForArchiveJob({
    access: f.access,
    claim: f.claim,
    originalsLibraryPath: f.identity.originalsLibraryPath,
    exclusion: f.exclusion,
    proven: f.proven,
  });
  const originalDiscArchiveId = saved.originalDiscArchiveId!;
  const manifest = f.access.catalog.findDvdSourceSampleManifest(
    originalDiscArchiveId,
  );
  expect(manifest).toMatchObject({
    sourceMetadataFingerprint: f.identity.imageFingerprint,
    acceptedEndLbaExclusive: 1_024,
    checkpointRevision: 1,
  });
  expect(manifest?.samples).toHaveLength(DVD_SOURCE_SAMPLE_BAND_COUNT);
  expect(new Set(manifest?.samples.map((sample) => sample.bandIndex)).size)
    .toBe(DVD_SOURCE_SAMPLE_BAND_COUNT);
  f.access.close();

  const reopened = createDataAccess({ databasePath: f.databasePath });
  try {
    expect(reopened.catalog.findDvdSourceSampleManifest(
      originalDiscArchiveId,
    )).toEqual(manifest);
  } finally {
    reopened.close();
  }
});

it("keeps the source-sample database projection immutable", async () => {
  const f = await jobFixture(false, false, true);
  try {
    const saved = await saveDvdInitialArchiveForArchiveJob({
      access: f.access,
      claim: f.claim,
      originalsLibraryPath: f.identity.originalsLibraryPath,
      exclusion: f.exclusion,
      proven: f.proven,
    });
    const sqlite = new DatabaseSync(f.databasePath);
    try {
      expect(() => sqlite.prepare(`
        UPDATE dvd_source_sample_manifests
        SET manifest = manifest
        WHERE original_disc_archive_id = ?
      `).run(saved.originalDiscArchiveId)).toThrow(
        "DVD source sample manifests are immutable",
      );
      expect(() => sqlite.prepare(`
        DELETE FROM dvd_source_sample_manifests
        WHERE original_disc_archive_id = ?
      `).run(saved.originalDiscArchiveId)).toThrow(
        "DVD source sample manifests are immutable",
      );
    } finally {
      sqlite.close();
    }
  } finally {
    f.access.close();
  }
});

it("resolves immutable revision-one samples beside a validated later checkpoint", async () => {
  const f = await jobFixture(true, false, true);
  try {
    const saved = await saveDvdInitialArchiveForArchiveJob({
      access: f.access,
      claim: f.claim,
      originalsLibraryPath: f.identity.originalsLibraryPath,
      exclusion: f.exclusion,
      proven: f.proven,
    });
    const archiveId = saved.originalDiscArchiveId!;
    const pointerPath = join(
      f.identity.originalsLibraryPath,
      ".dvd-evidence",
      archiveId,
      "checkpoint.json",
    );
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
      publicationDigest: string;
    };
    const archive = f.access.catalog.listOriginalDiscArchives({
      ids: [archiveId],
    })[0]!;
    const initialHeader = f.access.catalog.findDvdArchiveEvidenceHeader(
      archiveId,
    )!;
    const recoveryReadId = `${archiveId}:synthetic-read-2`;
    const recoveryReadDigest = createDvdArchiveRecoveryReadEvidenceDigest({
      originalDiscArchiveId: archiveId,
      fromManifestId: initialHeader.currentManifestId,
      fromManifestRevision: initialHeader.currentManifestRevision,
      startLba: 32,
      sectorCount: 1,
      outcome: "recovered",
    });
    const currentRanges = initialHeader.unrecoveredSourceRanges.filter(
      (range) => range.startLba !== 32,
    );
    const currentManifestId = `${archiveId}:synthetic-revision-2`;
    const currentManifest = createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: archiveId,
      revision: 2,
      previousManifestId: initialHeader.currentManifestId,
      previousManifestDigest: initialHeader.currentManifestDigest,
      recoveryReadId,
      recoveryReadEvidenceDigest: recoveryReadDigest,
      evidenceFormat: initialHeader.evidenceFormat,
      imageFingerprint: archive.fingerprint,
      sectorSizeBytes: initialHeader.sectorSizeBytes,
      acceptedEndLbaExclusive: initialHeader.acceptedEndLbaExclusive,
      boundaryPolicyVersion: archive.boundaryPolicyVersion!,
      boundaryReportedSizeBytes: archive.boundaryReportedSizeBytes!,
      boundaryPublishedSizeBytes: archive.boundaryPublishedSizeBytes!,
      boundaryEvidenceDigest: initialHeader.boundaryEvidenceDigest,
      unrecoveredSourceRanges: currentRanges,
    });
    const currentManifestDigest = currentManifest.manifestDigest;
    const sqlite = new DatabaseSync(f.databasePath);
    try {
      const guards = sqlite.prepare(`
        SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
      `).all() as Array<{ name: string; sql: string }>;
      for (const guard of guards) {
        sqlite.exec(`DROP TRIGGER "${guard.name}"`);
      }
      sqlite.prepare(`
        INSERT INTO dvd_archive_recovery_reads (
          id, original_disc_archive_id, from_manifest_id,
          from_manifest_revision, start_lba, sector_count, outcome,
          evidence_digest, created_at
        ) VALUES (?, ?, ?, 1, 32, 1, 'recovered', ?, 2)
      `).run(
        recoveryReadId,
        archiveId,
        initialHeader.currentManifestId,
        recoveryReadDigest,
      );
      sqlite.prepare(`
        INSERT INTO dvd_archive_evidence_manifests (
          id, original_disc_archive_id, revision, previous_manifest_id,
          recovery_read_id, evidence_format, image_fingerprint,
          sector_size_bytes, accepted_end_lba_exclusive,
          boundary_policy_version, boundary_reported_size_bytes,
          boundary_published_size_bytes, boundary_evidence_digest,
          unrecovered_source_ranges, unrecovered_source_ranges_digest,
          manifest_digest, created_at
        ) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)
      `).run(
        currentManifestId,
        archiveId,
        initialHeader.currentManifestId,
        recoveryReadId,
        initialHeader.evidenceFormat,
        archive.fingerprint,
        initialHeader.sectorSizeBytes,
        initialHeader.acceptedEndLbaExclusive,
        archive.boundaryPolicyVersion,
        archive.boundaryReportedSizeBytes,
        archive.boundaryPublishedSizeBytes,
        initialHeader.boundaryEvidenceDigest,
        JSON.stringify(currentRanges),
        currentManifest.unrecoveredSourceRangesDigest,
        currentManifestDigest,
      );
      sqlite.prepare(`
        UPDATE dvd_archive_evidence_headers
        SET current_manifest_id = ?, current_manifest_revision = 2,
            current_manifest_digest = ?, updated_at = 2
        WHERE original_disc_archive_id = ?
      `).run(currentManifestId, currentManifestDigest, archiveId);
      for (const guard of guards) sqlite.exec(guard.sql);
    } finally {
      sqlite.close();
    }
    await writeFile(pointerPath, JSON.stringify({
      originalDiscArchiveId: archiveId,
      currentManifestId,
      currentManifestRevision: 2,
      currentManifestDigest,
      publicationDigest: pointer.publicationDigest,
    }));
    const resolved = await f.access.withDvdCurrentCheckpoint(
      archiveId,
      createArchiveImageOwnership(),
      async ({ checkpoint }) => checkpoint,
    );

    expect(resolved).toMatchObject({
      currentManifestId,
      currentManifestRevision: 2,
      currentManifestDigest,
      initialEvidence: {
        revision: 1,
        sourceSampleManifest: { checkpointRevision: 1 },
      },
    });

    const corrupt = new DatabaseSync(f.databasePath);
    try {
      corrupt.exec("PRAGMA foreign_keys = OFF");
      const guard = corrupt.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'trigger'
          AND name = 'dvd_evidence_manifest_delete_guard'
      `).get() as { sql: string };
      corrupt.exec("DROP TRIGGER dvd_evidence_manifest_delete_guard");
      corrupt.prepare(`
        DELETE FROM dvd_archive_evidence_manifests WHERE id = ?
      `).run(currentManifestId);
      corrupt.exec(guard.sql);
    } finally {
      corrupt.close();
    }
    await expect(f.access.withDvdCurrentCheckpoint(
      archiveId,
      createArchiveImageOwnership(),
      async ({ checkpoint }) => checkpoint,
    )).rejects.toThrow("authoritative links are incomplete");
  } finally {
    f.access.close();
  }
});

it("reasserts archive ownership after publication verification and before the database commit", async () => {
  const f = await jobFixture(true);
  const ownership = createArchiveImageOwnership();
  let databaseBoundaryReached = false;
  let assertionsAfterBoundary = 0;
  let assertionsAtCommit = -1;
  const archiveImageOwnership: ArchiveImageOwnership = {
    ...ownership,
    async withInitialPublicationWriter(request) {
      return ownership.withInitialPublicationWriter({
        ...request,
        async task(handle) {
          return request.task({
            ...handle,
            assertOwned() {
              handle.assertOwned();
              if (databaseBoundaryReached) assertionsAfterBoundary += 1;
            },
          });
        },
      });
    },
  };
  const publish = f.access.archiveJobs.publishDvdInitial.bind(
    f.access.archiveJobs,
  );
  vi.spyOn(f.access.archiveJobs, "publishDvdInitial")
    .mockImplementation((claim, input) => {
      assertionsAtCommit = assertionsAfterBoundary;
      return publish(claim, input);
    });
  try {
    await saveDvdInitialArchiveForArchiveJob({
      access: f.access,
      archiveImageOwnership,
      claim: f.claim,
      originalsLibraryPath: f.identity.originalsLibraryPath,
      exclusion: f.exclusion,
      fault(point) {
        if (point === "before:database") databaseBoundaryReached = true;
      },
      proven: f.proven,
    });
    expect(assertionsAtCommit).toBe(2);
  } finally { f.access.close(); }
});

it("fails closed when the staged image is on unsupported storage", async () => {
  const f = await jobFixture();
  const stagedImagePath = await realpath(f.proven.initialCopy.imagePath);
  const archiveImageOwnership = createArchiveImageOwnership({
    inspectStorage: (path) => path === stagedImagePath
      ? { filesystemType: "synthetic-network", storageClass: "network" }
      : { filesystemType: "test-in-process", storageClass: "local" },
  });
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({
      access: f.access,
      archiveImageOwnership,
      claim: f.claim,
      originalsLibraryPath: f.identity.originalsLibraryPath,
      exclusion: f.exclusion,
      proven: f.proven,
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_CONSISTENCY_FAULT" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally {
    f.access.close();
  }
});

it("fails closed when reconciliation finds persisted staging on unsupported storage", async () => {
  const f = await jobFixture();
  const options = {
    access: f.access,
    claim: f.claim,
    originalsLibraryPath: f.identity.originalsLibraryPath,
    exclusion: f.exclusion,
  };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({
      ...options,
      proven: f.proven,
      fault(point) {
        if (point === "after:intent") throw new Error("synthetic interruption");
      },
    })).rejects.toThrow("synthetic interruption");
    const stagedImagePath = await realpath(f.proven.initialCopy.imagePath);
    const archiveImageOwnership = createArchiveImageOwnership({
      inspectStorage: (path) => path === stagedImagePath
        ? { filesystemType: "synthetic-network", storageClass: "network" }
        : { filesystemType: "test-in-process", storageClass: "local" },
    });

    await expect(reconcileDvdInitialArchiveForArchiveJob({
      ...options,
      archiveImageOwnership,
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_CONSISTENCY_FAULT" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally {
    f.access.close();
  }
});

it("fails closed when reconciliation finds the published image on unsupported storage", async () => {
  const f = await jobFixture();
  const options = {
    access: f.access,
    claim: f.claim,
    originalsLibraryPath: f.identity.originalsLibraryPath,
    exclusion: f.exclusion,
  };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({
      ...options,
      proven: f.proven,
      fault(point) {
        if (point === "after:link") throw new Error("synthetic interruption");
      },
    })).rejects.toThrow("synthetic interruption");
    const publishedImagePath = await realpath(join(
      f.identity.originalsLibraryPath,
      `dvd-${f.claim.id}.iso`,
    ));
    const archiveImageOwnership = createArchiveImageOwnership({
      inspectStorage: (path) => path === publishedImagePath
        ? { filesystemType: "synthetic-network", storageClass: "network" }
        : { filesystemType: "test-in-process", storageClass: "local" },
    });

    await expect(reconcileDvdInitialArchiveForArchiveJob({
      ...options,
      archiveImageOwnership,
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_CONSISTENCY_FAULT" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally {
    f.access.close();
  }
});

it.each(["after:intent", "after:image", "after:manifest", "after:link", "before:pointer", "after:pointer", "before:database", "after:database", "before:cleanup", "after:cleanup"] as const)(
  "reconciles %s to the same complete save without losing evidence", async (interruption) => {
    const f = await jobFixture(true);
    const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
    try {
      await expect(saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven, fault(point) {
        if (point === interruption) throw new Error("synthetic interruption");
      } })).rejects.toThrow("synthetic interruption");
      if (!["after:database", "before:cleanup", "after:cleanup"].includes(interruption)) {
        expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
        expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
        expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("running");
      }
      const saved = await reconcileDvdInitialArchiveForArchiveJob(options);
      expect(await reconcileDvdInitialArchiveForArchiveJob(options)).toEqual(saved);
      const archive = f.access.catalog.listOriginalDiscArchives()[0]!;
      expect(f.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
      expect(await readFile(archive.archivePath)).toEqual(f.image);
      expect(f.access.catalog.findDvdArchiveEvidenceHeader(archive.id)?.unrecoveredSourceRanges).toEqual([
        { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
        { startLba: 41, sectorCount: 1, classification: "skipped_untested" },
        { startLba: 47, sectorCount: 2, classification: "skipped_untested" },
        { startLba: 63, sectorCount: 1, classification: "skipped_untested" },
      ]);
      expect(f.access.catalog.findArchiveRecovery(archive.id)?.status).toBe("eligible");
      expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("fulfilled");
    } finally { f.access.close(); }
  },
);

it("rolls back every database projection if Recovery creation fails, then replays the durable checkpoint", async () => {
  const f = await jobFixture(true);
  const sqlite = new DatabaseSync(f.databasePath);
  sqlite.exec("CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON archive_recoveries BEGIN SELECT RAISE(ABORT, 'synthetic database interruption'); END");
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven })).rejects.toMatchObject({ cause: { message: "synthetic database interruption" } });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.catalog.findDvdArchiveEvidenceHeader(`dvd-${f.claim.id}` as import("@rip-dvd/data-access").OriginalDiscArchiveId)).toBeNull();
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("running");
    sqlite.exec("DROP TRIGGER synthetic_save_failure");
    const saved = await reconcileDvdInitialArchiveForArchiveJob(options);
    expect(saved.status).toBe("completed");
    expect(f.access.catalog.findArchiveRecovery(saved.originalDiscArchiveId!)?.status).toBe("eligible");
    expect(f.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
  } finally { sqlite.close(); f.access.close(); }
});

it("preserves archive evidence after removing request staging and rejects a missing committed pointer", async () => {
  const f = await jobFixture(true);
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  try {
    const saved = await saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven });
    await rm(join(f.proven.initialCopy.imagePath, ".."), { recursive: true, force: true });
    expect((await reconcileDvdInitialArchiveForArchiveJob(options)).status).toBe("completed");
    const checkpoint = join(f.identity.originalsLibraryPath, ".dvd-evidence", saved.originalDiscArchiveId!, "checkpoint.json");
    await rm(checkpoint);
    await expect(reconcileDvdInitialArchiveForArchiveJob(options)).rejects.toMatchObject({ code: "DVD_PUBLICATION_PROJECTION_AHEAD" });
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("completed");
    expect(f.access.catalog.findArchiveRecovery(saved.originalDiscArchiveId!)?.status).toBe("eligible");
  } finally { f.access.close(); }
});

it("keeps the completed preservation outcome when a later recovery caller fails", async () => {
  const f = await jobFixture(true);
  try {
    const completed = await saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion, proven: f.proven });
    expect(() => f.access.archiveJobs.fail(f.claim, "synthetic recovery failure")).toThrow();
    expect(f.access.archiveJobs.find(f.claim.id)).toEqual(completed);
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("fulfilled");
  } finally { f.access.close(); }
});

it("does not advance the database when image bytes change before the save", async () => {
  const f = await jobFixture(true);
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion, proven: f.proven,
      async fault(point) {
        if (point === "before:database") await writeFile(f.proven.initialCopy.imagePath, Buffer.alloc(f.image.length, 7));
      },
    })).rejects.toMatchObject({ code: "DVD_PUBLICATION_IMAGE_CONFLICT" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
  } finally { f.access.close(); }
});

it("rejects an initial publication when the Originals symlink retargets after ownership admission", async () => {
  const f = await jobFixture(true);
  const fixtureRoot = dirname(f.identity.originalsLibraryPath);
  const admittedParentPath = join(fixtureRoot, "admitted-parent");
  const replacementParentPath = join(fixtureRoot, "replacement-parent");
  const configuredParentPath = join(fixtureRoot, "configured-parent");
  const admittedOriginalsPath = join(admittedParentPath, "originals");
  const replacementOriginalsPath = join(replacementParentPath, "originals");
  const configuredOriginalsPath = join(configuredParentPath, "originals");
  await mkdir(admittedParentPath);
  await mkdir(replacementOriginalsPath, { recursive: true });
  await rename(f.identity.originalsLibraryPath, admittedOriginalsPath);
  await symlink(admittedParentPath, configuredParentPath);
  const lock = createInProcessDvdRescueWorkspaceLock();
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({
      access: f.access,
      claim: f.claim,
      originalsLibraryPath: configuredOriginalsPath,
      exclusion: {
        async withLock(options) {
          return lock.withLock({
            ...options,
            async task() {
              await rm(configuredParentPath);
              await symlink(replacementParentPath, configuredParentPath);
              return options.task();
            },
          });
        },
      },
      proven: f.proven,
    })).rejects.toMatchObject({ code: "DVD_PUBLICATION_PATH_CONFLICT" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    await expect(readFile(join(
      replacementOriginalsPath,
      `${f.identity.originalDiscArchiveId}.iso`,
    ))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { f.access.close(); }
});

it("holds exclusion and waits for the initial helper to close before transferring image ownership", async () => {
  const f = await jobFixture(true);
  let releaseWriter!: () => void;
  let reportWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { reportWaiting = resolve; });
  const writerClosed = new Promise<void>(resolve => { releaseWriter = resolve; });
  let excluded = false;
  const lock = createInProcessDvdRescueWorkspaceLock();
  const saving = runDvdInitialArchiveJob({
    access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: { async withLock(options) {
      return lock.withLock({ ...options, async task() {
        excluded = true;
        try { return await options.task(); } finally { excluded = false; }
      } });
    } },
    authorizeMutation() { expect(excluded).toBe(true); },
    boundary: { ...f.boundary, runner: {
      copyInitial: f.boundary.runner.copyInitial,
      async waitForInactive() { reportWaiting(); await writerClosed; },
    } },
  });
  try {
    await waiting;
    expect(excluded).toBe(true);
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    releaseWriter();
    expect((await saving).status).toBe("completed");
    expect(excluded).toBe(false);
  } finally { releaseWriter(); await saving.catch(() => {}); f.access.close(); }
});

it.each([false, true])("saves the strict corrected extent without treating the excluded suffix as source damage, damaged=%s", async damaged => {
  const f = await jobFixture(damaged, true);
  try {
    const completed = await saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion, proven: f.proven });
    const archive = f.access.catalog.listOriginalDiscArchives()[0]!;
    expect(await readFile(archive.archivePath)).toEqual(f.image);
    expect(archive).toMatchObject({ sizeBytes: 64 * 2048, boundaryReportedSizeBytes: 80 * 2048, boundaryExcludedSectorCount: 16, integrity: damaged ? "incomplete_read" : "clean_read", badSectorCount: damaged ? 5 : 0 });
    expect(f.access.catalog.findDvdArchiveEvidenceHeader(archive.id)?.acceptedEndLbaExclusive).toBe(64);
    expect(f.access.catalog.findArchiveRecovery(archive.id)?.status).toBe(damaged ? "eligible" : "completed");
    expect(completed.status).toBe("completed");
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("fulfilled");
  } finally { f.access.close(); }
});

it("blocks ownership transfer if the initial helper cannot prove closure", async () => {
  const f = await jobFixture();
  try {
    await expect(runDvdInitialArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: createInProcessDvdRescueWorkspaceLock(), boundary: {
      ...f.boundary, runner: { copyInitial: f.boundary.runner.copyInitial, async waitForInactive() { throw new Error("synthetic active writer"); } },
    } })).rejects.toThrow("synthetic active writer");
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
  } finally { f.access.close(); }
});

it("reports a corrupt database projection as a consistency fault without changing the artifact", async () => {
  const f = await jobFixture(true);
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  const sqlite = new DatabaseSync(f.databasePath);
  try {
    const saved = await saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven });
    sqlite.exec("DROP TRIGGER dvd_evidence_header_update_guard");
    sqlite.prepare("UPDATE dvd_archive_evidence_headers SET current_manifest_digest = ? WHERE original_disc_archive_id = ?").run("0".repeat(64), saved.originalDiscArchiveId!);
    await expect(reconcileDvdInitialArchiveForArchiveJob(options)).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_CONSISTENCY_FAULT" });
    expect(f.access.archiveJobs.find(f.claim.id)).toEqual(saved);
    expect(await readFile(f.access.catalog.listOriginalDiscArchives()[0]!.archivePath)).toEqual(f.image);
  } finally { sqlite.close(); f.access.close(); }
});

it("cannot commit when cancellation arrives at the database boundary", async () => {
  const f = await jobFixture(true);
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion, proven: f.proven,
      fault(point) { if (point === "before:database") f.access.archiveRequests.cancel(f.claim.archiveRequestId); },
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_OWNERSHIP_LOST" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("cancellation_requested");
  } finally { f.access.close(); }
});

it("renews a marked initial copy through several claim leases without opening admission", async () => {
  const f = await jobFixture();
  vi.useFakeTimers();
  try {
    const saved = await runDvdInitialArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: createInProcessDvdRescueWorkspaceLock(), boundary: { ...f.boundary,
        runner: { ...f.boundary.runner, async copyInitial(input) {
          await vi.advanceTimersByTimeAsync(3 * ARCHIVE_JOB_LEASE_DURATION_MS);
          return f.boundary.runner.copyInitial(input);
        } },
      },
    });
    expect(saved.status).toBe("completed");
    expect(f.access.catalog.findArchiveRecovery(saved.originalDiscArchiveId!)?.status).toBe("completed");
    expect(() => f.access.archiveJobs.renewClaim(f.claim)).toThrow();
  } finally { f.access.close(); }
});

it("reconciles an expired pre-commit save only after exclusive writer inactivity, and fences its old claim", async () => {
  const f = await jobFixture(true);
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven, fault(point) {
      if (point === "after:pointer") throw new Error("synthetic restart");
    } })).rejects.toThrow("synthetic restart");
    f.access.close();
    f.access = createDataAccess({ databasePath: f.databasePath });
    options.access = f.access;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * ARCHIVE_JOB_LEASE_DURATION_MS);
    let inactive = false;
    const saved = await reconcileDvdInitialArchiveForArchiveJob({ ...options,
      exclusion: createInProcessDvdRescueWorkspaceLock(),
      writer: { devicePath: f.boundary.devicePath, outputPath: f.proven.initialCopy.imagePath,
        runner: { isActive() { expect(inactive).toBe(true); return false; }, async withDeviceInactive(_device, task) {
          inactive = true;
          try { await task(); } finally { inactive = false; }
        } },
      },
    });
    expect(saved.status).toBe("completed");
    expect(saved.claimToken).not.toBe(f.claim.claimToken);
    expect(f.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(f.access.catalog.findArchiveRecovery(saved.originalDiscArchiveId!)?.status).toBe("eligible");
    expect(() => f.access.archiveJobs.renewDvdInitialClaim(f.claim)).toThrow();
  } finally { f.access.close(); }
});

it("does not replace an expired claim while a native writer remains or inactivity is unproved", async () => {
  const f = await jobFixture(true);
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven, fault(point) {
      if (point === "after:pointer") throw new Error("synthetic restart");
    } })).rejects.toThrow("synthetic restart");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * ARCHIVE_JOB_LEASE_DURATION_MS);
    await expect(reconcileDvdInitialArchiveForArchiveJob(options)).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_OWNERSHIP_LOST" });
    await expect(reconcileDvdInitialArchiveForArchiveJob({ ...options,
      writer: { devicePath: f.boundary.devicePath, outputPath: f.proven.initialCopy.imagePath,
        runner: { isActive() { return true; }, async withDeviceInactive(_device, task) { await task(); } },
      },
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_OWNERSHIP_LOST" });
    expect(f.access.archiveJobs.find(f.claim.id)?.claimToken).toBe(f.claim.claimToken);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally { f.access.close(); }
});

it("keeps marked lease and completion guards closed when nullable fields are cleared", async () => {
  const f = await jobFixture();
  const sqlite = new DatabaseSync(f.databasePath);
  try {
    for (const column of ["evidence_format", "claim_token"]) {
      expect(() => sqlite.prepare(`UPDATE archive_jobs SET ${column} = NULL WHERE id = ?`).run(f.claim.id)).toThrow(/admission is closed/);
    }
    const future = Date.now() + 2 * ARCHIVE_JOB_LEASE_DURATION_MS;
    for (const column of ["claimed_by", "claimed_at"]) {
      expect(() => sqlite.prepare(`UPDATE archive_jobs SET claim_token = '00000000-0000-4000-8000-000000000408', claimed_at = ?, updated_at = ?, ${column} = NULL WHERE id = ?`).run(future, future, f.claim.id)).toThrow(/admission is closed/);
    }
    expect(f.access.archiveJobs.find(f.claim.id)?.evidenceFormat).toBe("dvd-recovery-evidence-v1");
    expect(f.access.archiveJobs.find(f.claim.id)?.claimToken).toBe(f.claim.claimToken);
  } finally { sqlite.close(); f.access.close(); }
});

it.each(["acquisition", "inspection"] as const)("reports native inactivity %s failure as ownership loss", async failure => {
  const f = await jobFixture(true);
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven, fault(point) {
      if (point === "after:pointer") throw new Error("synthetic restart");
    } })).rejects.toThrow("synthetic restart");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * ARCHIVE_JOB_LEASE_DURATION_MS);
    await expect(reconcileDvdInitialArchiveForArchiveJob({ ...options,
      writer: { devicePath: f.boundary.devicePath, outputPath: f.proven.initialCopy.imagePath,
        runner: { isActive() { throw new Error("synthetic unproved inode ownership"); },
          async withDeviceInactive(_device, task) {
            if (failure === "acquisition") throw new Error("DVD archive device is still active");
            await task();
          },
        },
      },
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_OWNERSHIP_LOST" });
    expect(f.access.archiveJobs.find(f.claim.id)?.claimToken).toBe(f.claim.claimToken);
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally { f.access.close(); }
});

it("rejects a nullable terminal timestamp even with a valid initial manifest present", async () => {
  const f = await jobFixture();
  const sqlite = new DatabaseSync(f.databasePath);
  try {
    sqlite.exec(`CREATE TRIGGER synthetic_invalid_completion AFTER INSERT ON dvd_archive_evidence_manifests BEGIN
      UPDATE archive_jobs SET status = 'completed', original_disc_archive_id = NEW.original_disc_archive_id,
        progress_phase = 'finalizing', progress_percent = 100, progress_bytes = NEW.boundary_published_size_bytes,
        progress_eta_seconds = NULL, last_progress_at = NEW.created_at,
        completed_at = NULL, error_message = NULL, updated_at = NEW.created_at
      WHERE id = '${f.claim.id}';
    END`);
    await expect(saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion, proven: f.proven }))
      .rejects.toMatchObject({ cause: { message: expect.stringMatching(/admission is closed/) } });
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally { sqlite.close(); f.access.close(); }
});

it("preserves downstream publication faults after safely replacing an expired claim", async () => {
  const f = await jobFixture();
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, exclusion: f.exclusion };
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ ...options, proven: f.proven, fault(point) {
      if (point === "after:pointer") throw new Error("synthetic restart");
    } })).rejects.toThrow("synthetic restart");
    const archiveId = `dvd-${f.claim.id}`;
    await rm(join(f.identity.originalsLibraryPath, ".dvd-evidence", archiveId, "initial-manifest.json"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * ARCHIVE_JOB_LEASE_DURATION_MS);
    await expect(reconcileDvdInitialArchiveForArchiveJob({ ...options,
      writer: { devicePath: f.boundary.devicePath, outputPath: f.proven.initialCopy.imagePath,
        runner: { isActive() { return false; }, async withDeviceInactive(_device, task) { await task(); } },
      },
    })).rejects.toMatchObject({ code: "DVD_PUBLICATION_CHECKPOINT_CONFLICT" });
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
  } finally { f.access.close(); }
});
