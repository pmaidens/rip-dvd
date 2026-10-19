import { lstat } from "node:fs/promises";
import {
  createCorrectedDvdArchiveBoundaryEvidence,
  createNormalDvdArchiveBoundaryEvidence,
  type CorrectedDvdArchiveBoundaryEvidence,
  type NormalDvdArchiveBoundaryEvidence,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";
import type { DvdCompletenessProver } from "./dvd-completeness-prover.js";
import type { DvdEndpointProver } from "./dvd-endpoint-prover.js";
import {
  createNodeDvdFullExtentMetadataValidator,
  type DvdFullExtentMetadataDecision,
  type DvdFullExtentMetadataValidator,
} from "./dvd-full-extent-validator.js";
import {
  DvdInitialCopyBoundaryError,
  DVD_SECTOR_SIZE_BYTES,
  readDvdInitialCopyImageIdentity,
  runDvdInitialCopyForArchiveJob,
  validateDvdInitialCopyResult,
  type CompletedDvdInitialCopy,
  type DvdInitialCopyRunner,
} from "./dvd-initial-copy.js";
import { isProvenDvdBoundaryCandidate } from "./dvd-recovery-contracts.js";
export interface ProvenDvdInitialArchiveBoundary {
  boundaryEvidence:
    | CorrectedDvdArchiveBoundaryEvidence
    | NormalDvdArchiveBoundaryEvidence;
  initialCopy: CompletedDvdInitialCopy;
  imageMtimeNs: string;
  metadataDecision: DvdFullExtentMetadataDecision | null;
}
// This produces publication prerequisites for marked jobs. Admission remains closed.
export async function runDvdInitialArchiveBoundaryForArchiveJob({
  authorizeBoundaryProbe,
  authorizeCopy,
  completenessProver,
  devicePath,
  endpointProver,
  expectedTitleMap,
  fullExtentMetadataValidator = createNodeDvdFullExtentMetadataValidator(),
  onProgress,
  outputPath,
  runner,
  signal,
  sizeBytes,
}: {
  authorizeBoundaryProbe(): void | Promise<void>;
  authorizeCopy?(): void | Promise<void>;
  completenessProver?: DvdCompletenessProver;
  devicePath: string;
  endpointProver: DvdEndpointProver;
  expectedTitleMap: DvdTitleMap;
  fullExtentMetadataValidator?: DvdFullExtentMetadataValidator;
  onProgress: Parameters<
    typeof runDvdInitialCopyForArchiveJob
  >[0]["onProgress"];
  outputPath: string;
  runner: DvdInitialCopyRunner;
  signal: AbortSignal;
  sizeBytes: number;
}): Promise<ProvenDvdInitialArchiveBoundary> {
  let initialCopy: CompletedDvdInitialCopy;
  let boundary: DvdInitialCopyBoundaryError | undefined;
  try {
    initialCopy = await runDvdInitialCopyForArchiveJob({
      authorizeBoundaryProbe,
      authorizeCopy,
      devicePath,
      onProgress,
      outputPath,
      runner,
      signal,
      sizeBytes,
    });
  } catch (error) {
    if (!(error instanceof DvdInitialCopyBoundaryError)) throw error;
    boundary = error;
    if (!isProvenDvdBoundaryCandidate(error.boundaryFailure))
      throw new Error("DVD corrected boundary is unproved", { cause: error });
    validateDvdInitialCopyResult(
      error.initialCopyResult,
      sizeBytes,
      "DVD corrected initial-copy result is invalid",
      error.boundaryFailure.retainedImageByteCount,
    );
    if (error.boundaryFailure.declaredByteCount !== sizeBytes)
      throw new Error("DVD corrected boundary conflicts with declared extent");
    initialCopy = {
      ...error.initialCopyResult,
      imageFilesystemIdentity: await readDvdInitialCopyImageIdentity(
        outputPath,
        error.boundaryFailure.retainedImageByteCount,
        "DVD corrected image is invalid",
      ),
      imagePath: outputPath,
    };
  }
  const before = await lstat(outputPath, { bigint: true });
  const verifyImage = async () => {
    signal.throwIfAborted();
    const after = await lstat(outputPath, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      `${after.dev}:${after.ino}` !== initialCopy.imageFilesystemIdentity ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("DVD initial image changed during boundary validation");
  };
  await verifyImage();
  onProgress({ phase: "verifying", progressPercent: 99 });
  if (boundary) {
    if (!completenessProver)
      throw new Error("DVD corrected-boundary validation is unavailable");
    await authorizeBoundaryProbe();
    signal.throwIfAborted();
    const proof = await completenessProver.prove({
      candidateBoundaryLba: boundary.boundaryFailure.firstFailingLba,
      expectedTitleMap,
      imagePath: outputPath,
      signal,
      unrecoveredSourceRanges: initialCopy.unrecoveredSourceRanges,
    });
    await verifyImage();
    await authorizeBoundaryProbe();
    signal.throwIfAborted();
    const f = boundary.boundaryFailure;
    return {
      initialCopy,
      imageMtimeNs: before.mtimeNs.toString(),
      metadataDecision: null,
      boundaryEvidence: createCorrectedDvdArchiveBoundaryEvidence({
        reportedSizeBytes: sizeBytes,
        publishedSizeBytes: f.retainedImageByteCount,
        firstExcludedLba: f.firstFailingLba,
        maximumReferencedLba: proof.maximumReferencedLba,
        outOfRangeEvidence: {
          classifierVersion: f.classifierVersion,
          scsiStatus: f.scsiStatus,
          hostStatus: f.hostStatus,
          driverStatus: f.driverStatus,
          senseResponseCode: f.senseResponseCode,
          senseKey: f.senseKey,
          asc: f.asc,
          ascq: f.ascq,
        },
      }),
    };
  }
  await authorizeBoundaryProbe();
  signal.throwIfAborted();
  const endpointProof = await endpointProver.prove({
    authorizeProbe: authorizeBoundaryProbe,
    devicePath,
    firstExcludedLba: sizeBytes / DVD_SECTOR_SIZE_BYTES,
    signal,
  });
  // The constructor checks the normalized proof and its independently chosen address.
  const boundaryEvidence = createNormalDvdArchiveBoundaryEvidence({
    reportedSizeBytes: sizeBytes,
    endpointProof,
  });
  await verifyImage();
  await authorizeBoundaryProbe();
  signal.throwIfAborted();
  const metadataDecision = await fullExtentMetadataValidator.validate({
    expectedByteCount: sizeBytes,
    imagePath: outputPath,
    imageFilesystemIdentity: initialCopy.imageFilesystemIdentity,
    signal,
    unrecoveredSourceRanges: initialCopy.unrecoveredSourceRanges,
  });
  await verifyImage();
  await authorizeBoundaryProbe();
  signal.throwIfAborted();
  if (
    metadataDecision.policyVersion !== "dvd-full-extent-metadata-v1" ||
    metadataDecision.decision !== "publishable" ||
    metadataDecision.blockers.length
  )
    throw new Error("DVD full-extent metadata blocks publication", {
      cause: metadataDecision,
    });
  return { initialCopy, imageMtimeNs: before.mtimeNs.toString(), boundaryEvidence, metadataDecision };
}
