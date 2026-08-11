import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCatalogReview } from "./catalog.test-support.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ArchiveFixtureOptions extends Pick<
  Parameters<typeof createLegacySidecarDataAccess>[0],
  "filesystemPathProbe"
> {
  libraryDirectory?: string;
  verificationRoots?: {
    mediaLibraryPath: string;
    originalsLibraryPath: string;
  };
}

function createArchiveFixture(options: ArchiveFixtureOptions = {}) {
  const directory =
    options.libraryDirectory ??
    mkdtempSync(join(tmpdir(), "rip-dvd-verification-"));
  if (options.libraryDirectory === undefined) {
    temporaryDirectories.push(directory);
  }
  const archivePath = join(directory, "Original Disc.iso");
  writeFileSync(archivePath, "preserved disc");
  const access = createLegacySidecarDataAccess({
    databasePath: join(directory, "catalog.sqlite"),
    filesystemPathProbe: options.filesystemPathProbe,
    mediaLibraryPath:
      options.verificationRoots?.mediaLibraryPath ?? directory,
    originalsLibraryPath:
      options.verificationRoots?.originalsLibraryPath ?? directory,
  });
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: "verification-archive",
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
  return { access, archive, directory };
}

function createEncodeJobFixture(
  fixture: ReturnType<typeof createArchiveFixture>,
  { createOutput = true }: { createOutput?: boolean } = {},
) {
  const { access, archive, directory } = fixture;
  const mediaItem = access.catalog.createMediaItem({
    kind: "movie",
    title: "Verified Movie",
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: mediaItem.id,
    sourceIdentity: { kind: "main_feature" },
  });
  completeCatalogReview(access, archive.id);
  const profile = access.encodingProfiles.create({
    key: "verification-profile",
    displayName: "Verification profile",
    mediaDomain: "dvd_video",
    settings: {},
  });
  const outputPath = join(directory, "Verified Movie.mkv");
  if (createOutput) {
    writeFileSync(outputPath, "encoded movie");
  }
  const job = access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath,
  });
  return { job, outputPath };
}

describe("explicit filesystem verification", () => {
  it("does not touch the Media Library while constructing or reading the facade", () => {
    const directory = mkdtempSync(join(tmpdir(), "rip-dvd-verification-open-"));
    temporaryDirectories.push(directory);
    const inspect = vi.fn(async () => "file" as const);
    const access = createLegacySidecarDataAccess({
      databasePath: join(directory, "catalog.sqlite"),
      filesystemPathProbe: { inspect },
      mediaLibraryPath: join(directory, "missing-media-library"),
      originalsLibraryPath: directory,
    });

    expect(access.checkHealth()).toMatchObject({ status: "ok" });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
    access.close();
  });

  it("verifies canonical paths through symlinked configured library roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-verification-alias-"));
    temporaryDirectories.push(root);
    const libraryDirectory = join(root, "canonical-library");
    const mediaLibraryAlias = join(root, "media-library-alias");
    const originalsLibraryAlias = join(root, "originals-library-alias");
    mkdirSync(libraryDirectory);
    symlinkSync(libraryDirectory, mediaLibraryAlias, "dir");
    symlinkSync(libraryDirectory, originalsLibraryAlias, "dir");
    const fixture = createArchiveFixture({
      libraryDirectory,
      verificationRoots: {
        mediaLibraryPath: mediaLibraryAlias,
        originalsLibraryPath: originalsLibraryAlias,
      },
    });
    const { access, archive } = fixture;
    const { job } = createEncodeJobFixture(fixture);

    const [archiveVerification, outputVerification] = await Promise.all([
      access.filesystemVerification.verifyOriginalDiscArchive(archive.id),
      access.filesystemVerification.verifyEncodeJobOutput(job.id),
    ]);

    expect([archiveVerification, outputVerification]).toEqual([
      expect.objectContaining({
        verificationStatus: "accessible",
        verificationMessage: "File is accessible.",
      }),
      expect.objectContaining({
        verificationStatus: "accessible",
        verificationMessage: "File is accessible.",
      }),
    ]);
    access.close();
  });

  it("does not inspect files during normal catalog and queue reads", async () => {
    const inspect = vi.fn(async () => "file" as const);
    const fixture = createArchiveFixture({
      filesystemPathProbe: { inspect },
    });
    const { access, archive } = fixture;
    const { job, outputPath } = createEncodeJobFixture(fixture);

    access.catalog.listOriginalDiscArchives();
    access.encodeJobs.list();
    access.readConsistentSnapshot((snapshot) => ({
      archives: snapshot.catalog.listOriginalDiscArchives(),
      encodeJobs: snapshot.encodeJobs.list(),
    }));

    expect(inspect).not.toHaveBeenCalled();

    await access.filesystemVerification.verifyOriginalDiscArchive(archive.id);
    await access.filesystemVerification.verifyEncodeJobOutput(job.id);

    expect(inspect).toHaveBeenNthCalledWith(
      1,
      archive.archivePath,
      expect.any(String),
    );
    expect(inspect).toHaveBeenNthCalledWith(
      2,
      outputPath,
      expect.any(String),
    );
    access.close();
  });

  it("refuses paths the isolated probe finds outside configured libraries", async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "rip-dvd-allowed-root-"));
    temporaryDirectories.push(allowedRoot);
    const inspect = vi.fn(async () => "unsafe" as const);
    const fixture = createArchiveFixture({
      filesystemPathProbe: { inspect },
      verificationRoots: {
        mediaLibraryPath: allowedRoot,
        originalsLibraryPath: allowedRoot,
      },
    });
    const { access, archive } = fixture;
    const { job } = createEncodeJobFixture(fixture);

    expect(
      await access.filesystemVerification.verifyOriginalDiscArchive(archive.id),
    ).toMatchObject({
      verificationStatus: "error",
      verificationMessage:
        "Recorded path is outside the configured library.",
    });
    expect(
      await access.filesystemVerification.verifyEncodeJobOutput(job.id),
    ).toMatchObject({
      verificationStatus: "error",
      verificationMessage:
        "Recorded path is outside the configured library.",
    });
    expect(inspect).toHaveBeenNthCalledWith(1, archive.archivePath, allowedRoot);
    expect(inspect).toHaveBeenNthCalledWith(2, job.outputPath, allowedRoot);
    access.close();
  });

  it("does not follow a symlink stored as an archive path", async () => {
    const fixture = createArchiveFixture();
    const { access, archive, directory } = fixture;
    const outsideDirectory = mkdtempSync(join(tmpdir(), "rip-dvd-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outsidePath = join(outsideDirectory, "outside.iso");
    writeFileSync(outsidePath, "outside library");
    rmSync(archive.archivePath);
    symlinkSync(outsidePath, archive.archivePath);

    expect(
      await access.filesystemVerification.verifyOriginalDiscArchive(archive.id),
    ).toMatchObject({
      verificationStatus: "error",
      verificationMessage: "Recorded path is not a regular file.",
    });
    expect(directory).not.toBe(outsideDirectory);
    access.close();
  });

  it("records an accessible Original Disc Archive only when explicitly requested", async () => {
    const { access, archive } = createArchiveFixture();

    expect(access.catalog.listOriginalDiscArchives()[0]).toMatchObject({
      id: archive.id,
      verificationStatus: null,
      verificationMessage: null,
      verifiedAt: null,
    });

    const verified =
      await access.filesystemVerification.verifyOriginalDiscArchive(archive.id);

    expect(verified).toMatchObject({
      id: archive.id,
      verificationStatus: "accessible",
      verificationMessage: "File is accessible.",
    });
    expect(verified.verifiedAt).toBeInstanceOf(Date);
    expect(verified.updatedAt).toEqual(archive.updatedAt);
    expect(access.catalog.listOriginalDiscArchives()[0]).toEqual(verified);
    access.close();
  });

  it("records an accessible Encode Job output only when explicitly requested", async () => {
    const fixture = createArchiveFixture();
    const { access } = fixture;
    const { job } = createEncodeJobFixture(fixture);

    expect(access.encodeJobs.list()[0]).toMatchObject({
      id: job.id,
      verificationStatus: null,
      verificationMessage: null,
      verifiedAt: null,
    });

    const verified =
      await access.filesystemVerification.verifyEncodeJobOutput(job.id);

    expect(verified).toMatchObject({
      id: job.id,
      verificationStatus: "accessible",
      verificationMessage: "File is accessible.",
    });
    expect(verified.verifiedAt).toBeInstanceOf(Date);
    expect(verified.updatedAt).toEqual(job.updatedAt);
    expect(access.encodeJobs.list()[0]).toEqual(verified);
    access.close();
  });

  it("clears verification when an Encode Job is explicitly requeued to a different path", async () => {
    const fixture = createArchiveFixture();
    const { access, directory } = fixture;
    const { job } = createEncodeJobFixture(fixture);
    await access.filesystemVerification.verifyEncodeJobOutput(job.id);
    const claim = access.encodeJobs.claimNext("verification-worker");
    expect(claim).not.toBeNull();
    access.encodeJobs.fail(claim!, "retry elsewhere");
    const requeued = access.encodeJobs.requeue(job.id, {
      outputPath: join(directory, "Replacement Output.mkv"),
    });

    expect(requeued).toMatchObject({
      id: job.id,
      verificationStatus: null,
      verificationMessage: null,
      verifiedAt: null,
    });
    expect(
      await access.filesystemVerification.verifyEncodeJobOutput(job.id),
    ).toMatchObject({
      verificationStatus: "missing",
      verificationMessage: "File is missing at the recorded path.",
    });
    access.close();
  });

  it("persists an unexpected error when the isolated probe fails", async () => {
    const fixture = createArchiveFixture({
      filesystemPathProbe: {
        inspect() {
          return Promise.reject(
            Object.assign(new Error("sensitive helper failure"), {
              code: "ETIMEDOUT",
            }),
          );
        },
      },
    });
    const { access, archive } = fixture;

    await expect(
      access.filesystemVerification.verifyOriginalDiscArchive(archive.id),
    ).resolves.toMatchObject({
      id: archive.id,
      verificationStatus: "error",
      verificationMessage: "Verification failed unexpectedly.",
    });
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        verificationStatus: "error",
        verificationMessage: "Verification failed unexpectedly.",
      });
    access.close();
  });

  it("records missing archive and output paths without failing verification", async () => {
    const fixture = createArchiveFixture();
    const { access, archive } = fixture;
    const { job } = createEncodeJobFixture(fixture, { createOutput: false });
    rmSync(archive.archivePath);
    const results: unknown[] = [];

    for (const verify of [
      () =>
        access.filesystemVerification.verifyOriginalDiscArchive(archive.id),
      () => access.filesystemVerification.verifyEncodeJobOutput(job.id),
    ]) {
      try {
        results.push(await verify());
      } catch (error) {
        results.push(error);
      }
    }

    expect(results).toEqual([
      expect.objectContaining({
        id: archive.id,
        verificationStatus: "missing",
        verificationMessage: "File is missing at the recorded path.",
      }),
      expect.objectContaining({
        id: job.id,
        verificationStatus: "missing",
        verificationMessage: "File is missing at the recorded path.",
      }),
    ]);
    access.close();
  });

  it.each([
    {
      code: "EACCES",
      expectedStatus: "inaccessible",
      expectedMessage: "The web process cannot access the recorded path.",
    },
    {
      code: "EIO",
      expectedStatus: "error",
      expectedMessage: "Verification failed unexpectedly.",
    },
  ])(
    "records $code verification failures without leaking error details",
    async ({ code, expectedStatus, expectedMessage }) => {
      const failure = Object.assign(new Error(`sensitive ${code} detail`), {
        code,
      });
      const fixture = createArchiveFixture({
        filesystemPathProbe: {
          inspect() {
            throw failure;
          },
        },
      });
      const { access, archive } = fixture;
      const { job } = createEncodeJobFixture(fixture);
      const results: unknown[] = [];

      for (const verify of [
        () =>
          access.filesystemVerification.verifyOriginalDiscArchive(archive.id),
        () => access.filesystemVerification.verifyEncodeJobOutput(job.id),
      ]) {
        try {
          results.push(await verify());
        } catch (error) {
          results.push(error);
        }
      }

      expect(results).toEqual([
        expect.objectContaining({
          id: archive.id,
          verificationStatus: expectedStatus,
          verificationMessage: expectedMessage,
        }),
        expect.objectContaining({
          id: job.id,
          verificationStatus: expectedStatus,
          verificationMessage: expectedMessage,
        }),
      ]);
      expect(JSON.stringify(results)).not.toContain("sensitive");
      access.close();
    },
  );
});
