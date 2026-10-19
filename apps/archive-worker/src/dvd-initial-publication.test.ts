import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { runDvdInitialArchiveBoundaryForArchiveJob } from "./dvd-initial-boundary.js";
import { isoProfileImage } from "./dvd-metadata-profile-fixtures.js";
import { DvdInitialCopyBoundaryError } from "./dvd-initial-copy.js";
import {
  publishDvdInitialArchive,
  reconcileDvdInitialArchivePublication,
} from "./dvd-initial-publication.js";

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
  const proven = await runDvdInitialArchiveBoundaryForArchiveJob({
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
    expectedTitleMap: { schemaVersion: 2, contentId: `dvdmeta-sha256:${"0".repeat(64)}`, titles: [] },
    onProgress() {},
    outputPath: join(staging, "image.partial"),
    completenessProver: { async prove() { return { maximumReferencedLba: 63 }; } },
    runner: {
      async copyInitial({ outputPath }) {
        await writeFile(outputPath, image);
        const result = {
          copyPolicyVersion: "dvd-initial-copy-v1" as const, declaredByteCount: corrected ? 80 * 2048 : image.length,
          recoveredByteCount: image.length - (damaged ? 2048 : 0), skippedRequestCount: damaged ? 1 : 0,
          diagnosticsTruncated: false, diagnostics: damaged ? [{
            classification: "tolerable_medium_error" as const, classifierVersion: "scsi-read-classifier-v2" as const,
            requestedLba: 32, requestedBlockCount: 1, retryOrdinal: 0,
            scsiStatus: 2, hostStatus: 0 as const, driverStatus: 8, senseResponseCode: 0x70 as const,
            senseKey: 3 as const, asc: 0x11, ascq: 0, informationLba: 32,
          }] : [], unrecoveredSourceRanges: damaged ? [{ startLba: 32, sectorCount: 1, classification: "skipped_untested" as const }] : [],
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
  });
  return {
    image, proven,
    identity: { originalsLibraryPath, originalDiscArchiveId: "synthetic-archive", sourceArchiveJobId: "synthetic-job", imageFingerprint: `dvdmeta-sha256:${"0".repeat(64)}` },
  };
}

it("publishes one durable initial checkpoint and preserves archive evidence after staging cleanup", async () => {
  const { identity, proven, image } = await fixture();
  const saved = await publishDvdInitialArchive({ ...identity, proven });
  expect(saved.manifest).toMatchObject({
    revision: 1, previousManifestId: null, recoveryReadId: null,
    acceptedEndLbaExclusive: 64, unrecoveredSourceRanges: [],
    integrity: { integrity: "clean_read", policyVersion: "dvd-recovery-evidence-v1" },
    policies: { copy: "dvd-initial-copy-v1", metadata: "dvd-full-extent-metadata-v1" },
  });
  expect(await readFile(saved.archivePath)).toEqual(image);
  await saved.finalizePublication();
  await expect(readFile(proven.initialCopy.imagePath)).rejects.toMatchObject({ code: "ENOENT" });
  const replay = await reconcileDvdInitialArchivePublication(identity);
  expect(replay.manifest).toEqual(saved.manifest);
  expect(replay.checkpoint).toEqual(saved.checkpoint);
});

it("preserves source-explained metadata gaps and their complete initial source evidence", async () => {
  const { identity, proven } = await fixture(true);
  const saved = await publishDvdInitialArchive({ ...identity, proven });
  expect(saved.manifest).toMatchObject({
    revision: 1, previousManifestId: null, recoveryReadId: null,
    unrecoveredSourceRanges: [{ startLba: 32, sectorCount: 1, classification: "skipped_untested" }],
    integrity: { integrity: "incomplete_read", badSectorCount: 1, badAreaCount: 1 },
    metadataDecision: { impact: "unknown", decision: "publishable" },
  });
});

it("publishes a strict corrected boundary without counting the excluded suffix as damage", async () => {
  const { identity, proven } = await fixture(false, true);
  const saved = await publishDvdInitialArchive({ ...identity, proven });
  expect(saved.manifest).toMatchObject({
    boundaryReportedSizeBytes: 80 * 2048, boundaryPublishedSizeBytes: 64 * 2048,
    acceptedEndLbaExclusive: 64, unrecoveredSourceRanges: [], metadataDecision: null,
    boundaryEvidence: { excludedSectorCount: 16, maximumReferencedLba: 63 },
    integrity: { integrity: "clean_read", badSectorCount: 0 }, policies: { metadata: null },
  });
  expect((await reconcileDvdInitialArchivePublication(identity)).checkpoint).toEqual(saved.checkpoint);
});

it.each(["after:intent", "before:image", "after:image", "before:manifest", "after:manifest", "before:link", "after:link", "before:pointer", "after:pointer"] as const)(
  "replays %s interruption to the same image and evidence checkpoint", async (interruption) => {
    const { identity, proven, image } = await fixture(true);
    await expect(publishDvdInitialArchive({ ...identity, proven, fault(point) {
      if (point === interruption) throw new Error("synthetic interruption");
    } })).rejects.toThrow("synthetic interruption");
    const saved = await reconcileDvdInitialArchivePublication(identity);
    const replay = await reconcileDvdInitialArchivePublication(identity);
    expect(replay.checkpoint).toEqual(saved.checkpoint);
    expect(replay.manifest.image.filesystemIdentity).toBe(proven.initialCopy.imageFilesystemIdentity);
    expect(await readFile(replay.archivePath)).toEqual(image);
    await replay.finalizePublication();
    expect((await reconcileDvdInitialArchivePublication(identity)).checkpoint).toEqual(saved.checkpoint);
  },
);

it("exposes missing intent when interrupted before its first durable write", async () => {
  const { identity, proven } = await fixture();
  await expect(publishDvdInitialArchive({ ...identity, proven, fault(point) {
    if (point === "before:intent") throw new Error("interruption");
  } })).rejects.toThrow("interruption");
  await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code: "DVD_PUBLICATION_INTENT_MISSING" });
  expect((await publishDvdInitialArchive({ ...identity, proven })).checkpoint.currentManifestRevision).toBe(1);
});

it("can finish the same linked artifact when request staging is already gone", async () => {
  const { identity, proven } = await fixture();
  await expect(publishDvdInitialArchive({ ...identity, proven, fault(point) {
    if (point === "after:link") throw new Error("interruption");
  } })).rejects.toThrow("interruption");
  await rm(proven.initialCopy.imagePath);
  const saved = await reconcileDvdInitialArchivePublication(identity);
  expect(saved.manifest.image.filesystemIdentity).toBe(proven.initialCopy.imageFilesystemIdentity);
});

it("rejects an image changed after pointer installation", async () => {
  const { identity, proven, image } = await fixture();
  await expect(publishDvdInitialArchive({ ...identity, proven, async fault(point) {
    if (point === "after:pointer") { image[0] = 7; await writeFile(proven.initialCopy.imagePath, image); }
  } })).rejects.toMatchObject({ code: "DVD_PUBLICATION_IMAGE_CONFLICT" });
});

it("rejects a same-size replacement instead of inferring completion from size", async () => {
  const { identity, proven, image } = await fixture();
  await expect(publishDvdInitialArchive({ ...identity, proven, fault(point) {
    if (point === "after:intent") throw new Error("interruption");
  } })).rejects.toThrow("interruption");
  await rm(proven.initialCopy.imagePath);
  await writeFile(proven.initialCopy.imagePath, image);
  await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code: "DVD_PUBLICATION_IMAGE_CONFLICT" });
});

it("rejects writes between boundary proof and publication", async () => {
  const { identity, proven, image } = await fixture();
  image[0] = 1;
  await writeFile(proven.initialCopy.imagePath, image);
  await expect(publishDvdInitialArchive({ ...identity, proven })).rejects.toMatchObject({ code: "DVD_PUBLICATION_IMAGE_CONFLICT" });
});

it("keeps a database projection behind the durable pointer", async () => {
  const { identity, proven } = await fixture();
  await expect(publishDvdInitialArchive({ ...identity, proven, fault(point) {
    if (point === "after:link") throw new Error("interruption");
  } })).rejects.toThrow("interruption");
  await expect(reconcileDvdInitialArchivePublication({ ...identity, databaseProjection: {
    currentManifestId: "synthetic-archive:initial", currentManifestRevision: 1, currentManifestDigest: "0".repeat(64),
  } })).rejects.toMatchObject({ code: "DVD_PUBLICATION_PROJECTION_AHEAD" });
  const saved = await reconcileDvdInitialArchivePublication(identity);
  await expect(reconcileDvdInitialArchivePublication({ ...identity, databaseProjection: {
    ...saved.checkpoint, currentManifestRevision: 2,
  } })).rejects.toMatchObject({ code: "DVD_PUBLICATION_PROJECTION_AHEAD" });
  expect((await reconcileDvdInitialArchivePublication({ ...identity, databaseProjection: saved.checkpoint })).checkpoint).toEqual(saved.checkpoint);
});

function evidencePath(identity: { originalsLibraryPath: string; originalDiscArchiveId: string }, file: string) {
  return join(identity.originalsLibraryPath, ".dvd-evidence", identity.originalDiscArchiveId, file);
}

it.each([
  ["initial-manifest.json", "DVD_PUBLICATION_MANIFEST_CONFLICT"],
  ["checkpoint.json", "DVD_PUBLICATION_CHECKPOINT_CONFLICT"],
  ["publication-intent.json", "DVD_PUBLICATION_INTENT_CONFLICT"],
] as const)("reports corrupted %s and preserves both image links", async (file, code) => {
  const { identity, proven } = await fixture();
  const saved = await publishDvdInitialArchive({ ...identity, proven });
  await writeFile(evidencePath(identity, file), "{}");
  await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code });
  await expect(saved.finalizePublication()).rejects.toMatchObject({ code });
  expect(await readFile(proven.initialCopy.imagePath)).toEqual(await readFile(saved.archivePath));
});

it("never overwrites a competing image with the same size", async () => {
  const { identity, proven, image } = await fixture();
  await expect(publishDvdInitialArchive({ ...identity, proven, fault(point) {
    if (point === "after:manifest") throw new Error("interruption");
  } })).rejects.toThrow("interruption");
  const archivePath = join(identity.originalsLibraryPath, `${identity.originalDiscArchiveId}.iso`);
  image[0] = 19;
  await writeFile(archivePath, image);
  const competing = await lstat(archivePath);
  await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code: "DVD_PUBLICATION_IMAGE_CONFLICT" });
  expect((await lstat(archivePath)).ino).toBe(competing.ino);
  expect(await readFile(archivePath)).toEqual(image);
});

it("requires persisted intent even when image size and checkpoint appear complete", async () => {
  const { identity, proven } = await fixture();
  const saved = await publishDvdInitialArchive({ ...identity, proven });
  await rm(evidencePath(identity, "publication-intent.json"));
  await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code: "DVD_PUBLICATION_INTENT_MISSING" });
  await expect(publishDvdInitialArchive({ ...identity, proven })).rejects.toMatchObject({ code: "DVD_PUBLICATION_INTENT_MISSING" });
  expect(await readFile(saved.archivePath)).toEqual(await readFile(proven.initialCopy.imagePath));
});

it("rejects an intent belonging to another source job", async () => {
  const { identity, proven } = await fixture();
  await publishDvdInitialArchive({ ...identity, proven });
  await expect(reconcileDvdInitialArchivePublication({ ...identity, sourceArchiveJobId: "another-job" })).rejects.toMatchObject({ code: "DVD_PUBLICATION_INTENT_CONFLICT" });
});

it("rejects symlink evidence directories without writing through them", async () => {
  const { identity, proven } = await fixture();
  await symlink(join(identity.originalsLibraryPath, "..", "request"), join(identity.originalsLibraryPath, ".dvd-evidence"));
  await expect(publishDvdInitialArchive({ ...identity, proven })).rejects.toMatchObject({ code: "DVD_PUBLICATION_PATH_CONFLICT" });
});

it.each(["after:link", "before:pointer"] as const)("does not complete a save after ownership or cancellation is lost at %s", async (pointToAbort) => {
  const { identity, proven } = await fixture();
  const controller = new AbortController();
  await expect(publishDvdInitialArchive({ ...identity, proven, signal: controller.signal, fault(point) {
    if (point === pointToAbort) controller.abort(new Error("claim lost"));
  } })).rejects.toThrow("claim lost");
  await expect(readFile(evidencePath(identity, "checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await reconcileDvdInitialArchivePublication(identity)).checkpoint.currentManifestRevision).toBe(1);
});

it.each(["boundary", "source-map", "integrity", "policy", "image-identity"] as const)(
  "binds %s evidence to the immutable intent digest", async (field) => {
    const { identity, proven } = await fixture();
    await publishDvdInitialArchive({ ...identity, proven });
    const path = evidencePath(identity, "publication-intent.json");
    const intent = JSON.parse(await readFile(path, "utf8"));
    if (field === "boundary") intent.manifest.boundaryEvidence.endpointProof.confirmationCount = 1;
    if (field === "source-map") intent.manifest.unrecoveredSourceRangesDigest = "0".repeat(64);
    if (field === "integrity") intent.manifest.integrity.integrity = "incomplete_read";
    if (field === "policy") intent.manifest.policies.copy = "unsupported-copy-policy";
    if (field === "image-identity") intent.manifest.image.filesystemIdentity = "1:2";
    await writeFile(path, JSON.stringify(intent));
    await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code: "DVD_PUBLICATION_INTENT_CONFLICT" });
  },
);

it("does not recreate evidence missing behind an authoritative pointer", async () => {
  const { identity, proven } = await fixture();
  await publishDvdInitialArchive({ ...identity, proven });
  const path = evidencePath(identity, "initial-manifest.json");
  await rm(path);
  await expect(reconcileDvdInitialArchivePublication(identity)).rejects.toMatchObject({ code: "DVD_PUBLICATION_CHECKPOINT_CONFLICT" });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("can clean request staging after the Archive Job claim has completed", async () => {
  const { identity, proven } = await fixture();
  let jobCompleted = false;
  const saved = await publishDvdInitialArchive({ ...identity, proven, authorizeMutation() {
    if (jobCompleted) throw new Error("Archive Job claim completed");
  } });
  jobCompleted = true;
  await saved.finalizePublication();
  await expect(readFile(proven.initialCopy.imagePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await reconcileDvdInitialArchivePublication(identity)).checkpoint).toEqual(saved.checkpoint);
});
