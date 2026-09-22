import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { expect, it } from "vitest";

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
    expect(await pollFilesystemVerification(access)).toBe(false);
  } finally {
    access.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
