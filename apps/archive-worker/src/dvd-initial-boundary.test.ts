import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { runDvdInitialArchiveBoundaryForArchiveJob } from "./dvd-initial-boundary.js";
import {
  DvdInitialCopyBoundaryError,
  type DvdInitialCopyResult,
} from "./dvd-initial-copy.js";
import {
  DvdReadableEndpointError,
  type DvdNormalEndpointProof,
} from "./dvd-endpoint-prover.js";
import { isoProfileImage } from "./dvd-metadata-profile-fixtures.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { force: true, recursive: true })),
  );
});
const evidence = {
  classifierVersion: "scsi-read-classifier-v2" as const,
  scsiStatus: 2,
  hostStatus: 0 as const,
  driverStatus: 8,
  senseResponseCode: 0x72 as const,
  senseKey: 5 as const,
  asc: 0x21 as const,
  ascq: 0 as const,
};
const titleMap = {
  schemaVersion: 2 as const,
  contentId: `dvdmeta-sha256:${"0".repeat(64)}`,
  titles: [],
};
async function request(damaged = true) {
  const image = isoProfileImage();
  const dir = await mkdtemp(join(tmpdir(), "dvd-initial-boundary-"));
  directories.push(dir);
  const copyResult: DvdInitialCopyResult = {
    copyPolicyVersion: "dvd-initial-copy-v1",
    declaredByteCount: image.length,
    recoveredByteCount: image.length - (damaged ? 2048 : 0),
    skippedRequestCount: damaged ? 1 : 0,
    diagnosticsTruncated: false,
    diagnostics: damaged
      ? [
          {
            classification: "tolerable_medium_error",
            classifierVersion: "scsi-read-classifier-v2",
            requestedLba: 32,
            requestedBlockCount: 1,
            retryOrdinal: 0,
            scsiStatus: 2,
            hostStatus: 0,
            driverStatus: 8,
            senseResponseCode: 0x70,
            senseKey: 3,
            asc: 0x11,
            ascq: 0,
            informationLba: 32,
          },
        ]
      : [],
    unrecoveredSourceRanges: damaged
      ? [{ startLba: 32, sectorCount: 1, classification: "skipped_untested" }]
      : [],
  };
  return {
    image,
    copyResult,
    args: {
      authorizeBoundaryProbe: vi.fn(async () => {}),
      devicePath: "/dev/dvd",
      endpointProver: {
        prove: vi.fn(
          async (): Promise<DvdNormalEndpointProof> => ({
            proofVersion: "dvd-normal-endpoint-proof-v1",
            confirmationCount: 2,
            firstExcludedLba: 64,
            outOfRangeEvidence: evidence,
          }),
        ),
      },
      expectedTitleMap: titleMap,
      onProgress: vi.fn(),
      outputPath: join(dir, "image.iso.partial"),
      runner: {
        copyInitial: vi.fn(async ({ outputPath }: { outputPath: string }) => {
          await writeFile(outputPath, image);
          return copyResult;
        }),
        waitForInactive: vi.fn(async () => {}),
      },
      signal: new AbortController().signal,
      sizeBytes: image.length,
    },
  };
}
it("requires endpoint proof and an independent metadata decision for a damaged full extent", async () => {
  const { args } = await request();
  const result = await runDvdInitialArchiveBoundaryForArchiveJob(args);
  expect(result.metadataDecision?.decision).toBe("publishable");
  expect(result.metadataDecision?.impact).toBe("unknown");
  expect(result.boundaryEvidence.excludedSectorCount).toBe(0);
  expect(result.initialCopy.unrecoveredSourceRanges).toEqual([
    { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
  ]);
});
it("blocks a malformed independently readable NAV before publication", async () => {
  const { args, image } = await request();
  image[40 * 2048] = 1;
  await expect(runDvdInitialArchiveBoundaryForArchiveJob(args)).rejects.toThrow(
    "metadata blocks publication",
  );
});
it.each(["unproved", "readable", "conflicting"])(
  "blocks %s endpoint evidence",
  async (kind) => {
    const { args } = await request(false);
    if (kind === "readable")
      args.endpointProver.prove.mockRejectedValue(
        new DvdReadableEndpointError(64),
      );
    else if (kind === "unproved")
      args.endpointProver.prove.mockRejectedValue(
        new Error("endpoint unproved"),
      );
    else
      args.endpointProver.prove.mockResolvedValue({
        proofVersion: "dvd-normal-endpoint-proof-v1",
        confirmationCount: 2,
        firstExcludedLba: 63,
        outOfRangeEvidence: evidence,
      });
    await expect(
      runDvdInitialArchiveBoundaryForArchiveJob(args),
    ).rejects.toThrow();
  },
);
it("keeps cancellation and current-source fences around endpoint proof", async () => {
  const { args } = await request();
  const controller = new AbortController();
  args.signal = controller.signal;
  args.authorizeBoundaryProbe.mockImplementation(async () => {
    controller.abort(new Error("source changed"));
  });
  await expect(runDvdInitialArchiveBoundaryForArchiveJob(args)).rejects.toThrow(
    "source changed",
  );
  expect(args.endpointProver.prove).not.toHaveBeenCalled();
});
it("detects image writes during endpoint proof", async () => {
  const { args, image } = await request();
  const proof = await args.endpointProver.prove();
  args.endpointProver.prove.mockImplementation(async () => {
    image[1] = 1;
    await writeFile(args.outputPath, image);
    return proof;
  });
  await expect(runDvdInitialArchiveBoundaryForArchiveJob(args)).rejects.toThrow(
    "image changed",
  );
});
it("requires strict corrected completeness and title-map proof without treating the suffix as damage", async () => {
  const { args, copyResult, image } = await request(false);
  args.sizeBytes = 80 * 2048;
  copyResult.declaredByteCount = args.sizeBytes;
  args.runner.copyInitial.mockImplementation(async ({ outputPath }) => {
    await writeFile(outputPath, image);
    throw new DvdInitialCopyBoundaryError(
      {
        protocolVersion: 1,
        category: "out_of_range",
        ...evidence,
        informationLba: 64,
        requestedLba: 64,
        requestedBlockCount: 1,
        retryOrdinal: 1,
        declaredByteCount: args.sizeBytes,
        firstFailingLba: 64,
        retainedImageByteCount: image.length,
        boundaryProofVersion: "dvd-sector-boundary-proof-v1",
        candidateConfirmationCount: 2,
        precedingSectorLba: 63,
      },
      copyResult,
    );
  });
  const completenessProver = {
    prove: vi.fn(async () => ({ maximumReferencedLba: 63 })),
  };
  const result = await runDvdInitialArchiveBoundaryForArchiveJob({
    ...args,
    completenessProver,
  });
  expect(result.metadataDecision).toBeNull();
  expect(result.boundaryEvidence.excludedSectorCount).toBe(16);
  expect(result.initialCopy.unrecoveredSourceRanges).toEqual([]);
  expect(completenessProver.prove).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedTitleMap: titleMap,
      candidateBoundaryLba: 64,
      unrecoveredSourceRanges: [],
    }),
  );
  expect(args.endpointProver.prove).not.toHaveBeenCalled();
  completenessProver.prove.mockRejectedValue(new Error("strict proof failed"));
  await expect(
    runDvdInitialArchiveBoundaryForArchiveJob({ ...args, completenessProver }),
  ).rejects.toThrow("strict proof failed");
});
