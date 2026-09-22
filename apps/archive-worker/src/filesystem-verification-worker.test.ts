import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { expect, it, vi } from "vitest";

import { pollFilesystemVerification } from "./filesystem-verification-worker.js";

it("executes queued verification and retains its result for later readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-worker-verification-"));
  const archivePath = join(directory, "synthetic-archive.iso");
  writeFileSync(archivePath, "synthetic archive");
  const access = createLegacySidecarDataAccess({
    databasePath: join(directory, "catalog.sqlite"),
    mediaLibraryPath: directory,
    originalsLibraryPath: directory,
  });
  try {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/synthetic-drive", isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-verification-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath,
      fingerprint: disc.fingerprint,
    });
    const run = access.filesystemVerification.submit({
      mutationKey: "synthetic-worker-invocation",
      target: "original_disc_archive",
      targetId: archive.id,
    });
    expect(await pollFilesystemVerification(access)).toBe(true);
    expect(access.filesystemVerification.find(run.id)).toMatchObject({
      status: "completed", progressPhase: "completed", resultStatus: "accessible",
    });
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({ verificationStatus: "accessible" });
    const media = access.catalog.createMediaItem({ kind: "movie", title: "Synthetic Movie" });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: media.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "synthetic-verification-profile", displayName: "Synthetic Profile",
      mediaDomain: "dvd_video", settings: {},
    });
    const outputPath = join(directory, "synthetic-output.mkv");
    writeFileSync(outputPath, "synthetic output");
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath,
    });
    const outputRun = access.filesystemVerification.submit({
      mutationKey: "synthetic-output-invocation",
      target: "encode_job_output",
      targetId: job.id,
    });
    expect(await pollFilesystemVerification(access)).toBe(true);
    expect(access.filesystemVerification.find(outputRun.id)).toMatchObject({
      status: "completed", resultStatus: "accessible",
    });
    expect(access.encodeJobs.find(job.id)).toMatchObject({ verificationStatus: "accessible" });
    expect(await pollFilesystemVerification(access)).toBe(false);

    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let releaseProbe!: () => void;
    const blockedProbe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const execute = access.filesystemVerification.execute.bind(access.filesystemVerification);
    vi.spyOn(access.filesystemVerification, "execute").mockImplementation(async (claim) => {
      await blockedProbe;
      return execute(claim);
    });
    const slowRun = access.filesystemVerification.submit({
      mutationKey: "synthetic-slow-invocation",
      target: "original_disc_archive",
      targetId: archive.id,
    });
    const slowPoll = pollFilesystemVerification(access);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(access.filesystemVerification.recoverExpiredClaims()).toBe(0);
    releaseProbe();
    expect(await slowPoll).toBe(true);
    expect(access.filesystemVerification.find(slowRun.id)?.status).toBe("completed");
  } finally {
    vi.useRealTimers();
    access.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("records and resolves verification polling and recovery failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-worker-incidents-"));
  const access = createLegacySidecarDataAccess({
    databasePath: join(directory, "catalog.sqlite"),
    mediaLibraryPath: directory,
    originalsLibraryPath: directory,
  });
  try {
    const recovery = vi.spyOn(access.filesystemVerification, "recoverExpiredClaims")
      .mockImplementation(() => { throw new Error("synthetic recovery failure"); });
    await expect(pollFilesystemVerification(access)).rejects.toThrow(
      "Filesystem verification claim recovery failed",
    );
    expect(access.workerIncidents.list({ workerKind: "archive", resolvedLimit: 10 }))
      .toEqual([expect.objectContaining({
        reasonCode: "claim_recovery_failure",
        evidence: { recoveryArea: "filesystem_verification" },
        resolvedAt: null,
      })]);
    recovery.mockRestore();
    const claim = vi.spyOn(access.filesystemVerification, "claimNext")
      .mockImplementation(() => { throw new Error("synthetic poll failure"); });
    await expect(pollFilesystemVerification(access)).rejects.toThrow(
      "Filesystem verification poll failed",
    );
    expect(access.workerIncidents.list({ workerKind: "archive", resolvedLimit: 10 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        reasonCode: "poll_failure",
        evidence: { recoveryArea: "filesystem_verification" },
        resolvedAt: null,
      })]));
    claim.mockRestore();
    expect(await pollFilesystemVerification(access)).toBe(false);
    expect(access.workerIncidents.list({ workerKind: "archive", resolvedLimit: 10 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        reasonCode: "poll_failure",
        evidence: { recoveryArea: "filesystem_verification" },
        resolvedAt: expect.any(Date),
      })]));
  } finally {
    access.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
