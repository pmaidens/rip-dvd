import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  createDvdSourceSampleDigest,
  createDvdSourceSampleManifestDigest,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
  DVD_SOURCE_SAMPLE_SECTOR_BYTES,
  DVD_SOURCE_SAMPLE_SECTOR_COUNT,
  DVD_SOURCE_VERIFICATION_POLICY_VERSION,
  dvdSourceSampleCandidates,
  hasSuitableDvdSourceSampleContent,
  validateDvdSourceSampleManifest,
  type DvdSourceSampleManifest,
  type DvdSourceSampleReference,
  type DvdUnrecoveredSourceRange,
} from "@rip-dvd/data-access";

const MAX_CANDIDATE_READS_PER_BAND = 64;

async function readExactSample(
  descriptor: Awaited<ReturnType<typeof open>>,
  startLba: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(DVD_SOURCE_SAMPLE_BYTE_COUNT);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await descriptor.read(
      bytes,
      offset,
      bytes.length - offset,
      startLba * DVD_SOURCE_SAMPLE_SECTOR_BYTES + offset,
    );
    if (result.bytesRead === 0) {
      throw new Error("DVD source sample ended before its declared extent");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

/**
 * Builds the reference manifest from the durable initial image. No Optical
 * Drive read occurs here. Missing or uniform bands remain absent so a later
 * verifier reports inconclusive coverage instead of overstating identity.
 */
export async function createInitialDvdSourceSampleManifest(input: {
  imagePath: string;
  image: {
    filesystemIdentity: string;
    mtimeNs: string;
    sizeBytes: number;
  };
  sourceMetadataFingerprint: string;
  acceptedEndLbaExclusive: number;
  checkpointRevision: number;
  checkpointDigest: string;
  unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
  authorizeRead(): void | Promise<void>;
}): Promise<DvdSourceSampleManifest> {
  const samples: DvdSourceSampleReference[] = [];
  const image = await open(
    input.imagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const assertProvenImage = async () => {
    const opened = await image.stat({ bigint: true });
    const named = await lstat(input.imagePath, { bigint: true });
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      `${opened.dev}:${opened.ino}` !== input.image.filesystemIdentity ||
      opened.size !== BigInt(input.image.sizeBytes) ||
      opened.mtimeNs.toString() !== input.image.mtimeNs ||
      named.size !== opened.size ||
      named.mtimeNs !== opened.mtimeNs
    ) {
      throw new Error("DVD source sample image differs from the proven image");
    }
  };
  try {
    await assertProvenImage();
    for (
      let bandIndex = 0;
      bandIndex < DVD_SOURCE_SAMPLE_BAND_COUNT;
      bandIndex += 1
    ) {
      const candidates = dvdSourceSampleCandidates({
        acceptedEndLbaExclusive: input.acceptedEndLbaExclusive,
        bandIndex,
        unrecoveredSourceRanges: input.unrecoveredSourceRanges,
      }).slice(0, MAX_CANDIDATE_READS_PER_BAND);
      for (const startLba of candidates) {
        await input.authorizeRead();
        const bytes = await readExactSample(image, startLba);
        await input.authorizeRead();
        if (!hasSuitableDvdSourceSampleContent(bytes)) continue;
        samples.push({
          bandIndex,
          startLba,
          sectorCount: DVD_SOURCE_SAMPLE_SECTOR_COUNT,
          digest: createDvdSourceSampleDigest(bytes),
        });
        break;
      }
    }
    await assertProvenImage();
  } finally {
    await image.close();
  }
  const payload = {
    policyVersion: DVD_SOURCE_VERIFICATION_POLICY_VERSION,
    byteRepresentation: DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
    sourceMetadataFingerprint: input.sourceMetadataFingerprint,
    acceptedEndLbaExclusive: input.acceptedEndLbaExclusive,
    checkpointRevision: input.checkpointRevision,
    checkpointDigest: input.checkpointDigest,
    samples,
  } as const;
  return validateDvdSourceSampleManifest({
    ...payload,
    manifestDigest: createDvdSourceSampleManifestDigest(payload),
  });
}
