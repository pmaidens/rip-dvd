import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createDataAccess, type RunningArchiveJob } from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";
import { runDvdInitialArchiveBoundaryForArchiveJob } from "./dvd-initial-boundary.js";
import { isoProfileImage } from "./dvd-metadata-profile-fixtures.js";
import { createInProcessDvdRescueWorkspaceLock } from "./dvd-rescue-workspace-lock.js";
import { DvdInitialCopyBoundaryError } from "./dvd-initial-copy.js";
import { saveDvdInitialArchiveForArchiveJob, reconcileDvdInitialArchiveForArchiveJob, runDvdInitialArchiveJob } from "./dvd-initial-save.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(damaged = false, corrected = false) {
  const directory = await mkdtemp(join(tmpdir(), "dvd-initial-publication-"));
  directories.push(directory);
  const originalsLibraryPath = join(directory, "originals");
  const staging = join(directory, "request");
  await mkdir(originalsLibraryPath);
  await mkdir(staging);
  const image = isoProfileImage();
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
        firstExcludedLba: 64,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2", scsiStatus: 2,
          hostStatus: 0, driverStatus: 8, senseResponseCode: 0x72,
          senseKey: 5, asc: 0x21, ascq: 0,
        },
      };
    } },
    expectedTitleMap: { schemaVersion: 2, contentId: `dvdmeta-sha256:${"0".repeat(64)}`, titles: [{ number: 1, durationSeconds: 60, chapters: 1, audioStreams: [], subtitles: [] }] },
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


async function jobFixture(damaged = false, corrected = false) {
  const f = await fixture(damaged, corrected);
  const databasePath = join(f.identity.originalsLibraryPath, "..", "catalog.sqlite");
  const access = createDataAccess({ databasePath });
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
  const reopened = createDataAccess({ databasePath });
  return { ...f, access: reopened, claim: reopened.archiveJobs.find(claim.id) as RunningArchiveJob, databasePath };
}

it.each([false, true])("saves the initial image, full evidence, job, request and separate Recovery together, damaged=%s", async (damaged) => {
  const f = await jobFixture(damaged);
  try {
    const saved = await saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, proven: f.proven });
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
    expect((await reconcileDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath })).originalDiscArchiveId).toBe(id);
    expect(f.access.catalog.listOriginalDiscArchives({})).toHaveLength(1);
  } finally { f.access.close(); }
});

it.each(["after:intent", "after:image", "after:manifest", "after:link", "before:pointer", "after:pointer", "before:database", "after:database", "before:cleanup", "after:cleanup"] as const)(
  "reconciles %s to the same complete save without losing evidence", async (interruption) => {
    const f = await jobFixture(true);
    const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath };
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
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath };
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
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath };
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
    const completed = await saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, proven: f.proven });
    expect(() => f.access.archiveJobs.fail(f.claim, "synthetic recovery failure")).toThrow();
    expect(f.access.archiveJobs.find(f.claim.id)).toEqual(completed);
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("fulfilled");
  } finally { f.access.close(); }
});

it("does not advance the database when image bytes change before the save", async () => {
  const f = await jobFixture(true);
  try {
    await expect(saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, proven: f.proven,
      async fault(point) {
        if (point === "before:database") await writeFile(f.proven.initialCopy.imagePath, Buffer.alloc(f.image.length, 7));
      },
    })).rejects.toMatchObject({ code: "DVD_PUBLICATION_IMAGE_CONFLICT" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
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
    access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath,
    exclusion: { async withLock(options) {
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
    const completed = await saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, proven: f.proven });
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
  const options = { access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath };
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
    await expect(saveDvdInitialArchiveForArchiveJob({ access: f.access, claim: f.claim, originalsLibraryPath: f.identity.originalsLibraryPath, proven: f.proven,
      fault(point) { if (point === "before:database") f.access.archiveRequests.cancel(f.claim.archiveRequestId); },
    })).rejects.toMatchObject({ code: "DVD_INITIAL_SAVE_OWNERSHIP_LOST" });
    expect(f.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(f.access.archiveJobs.find(f.claim.id)?.status).toBe("running");
    expect(f.access.archiveRequests.find(f.claim.archiveRequestId)?.status).toBe("cancellation_requested");
  } finally { f.access.close(); }
});
