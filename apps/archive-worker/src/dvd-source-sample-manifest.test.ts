import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  dvdSourceSampleCandidates,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_SAMPLE_SECTOR_BYTES,
} from "@rip-dvd/data-access";

import { createInitialDvdSourceSampleManifest } from "./dvd-source-sample-manifest.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

it("searches past uniform midpoint windows for suitable content in every band", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dvd-source-samples-"));
  directories.push(directory);
  const acceptedEndLbaExclusive = 1_024;
  const image = Buffer.alloc(
    acceptedEndLbaExclusive * DVD_SOURCE_SAMPLE_SECTOR_BYTES,
  );
  const selectedStarts: number[] = [];
  for (
    let bandIndex = 0;
    bandIndex < DVD_SOURCE_SAMPLE_BAND_COUNT;
    bandIndex += 1
  ) {
    const candidates = dvdSourceSampleCandidates({
      acceptedEndLbaExclusive,
      bandIndex,
      unrecoveredSourceRanges: [],
    });
    const selected = candidates[32]!;
    selectedStarts.push(selected);
    image[selected * DVD_SOURCE_SAMPLE_SECTOR_BYTES +
      DVD_SOURCE_SAMPLE_BYTE_COUNT - 1] = bandIndex + 1;
  }
  const imagePath = join(directory, "image.iso");
  await writeFile(imagePath, image);
  const authorizeRead = vi.fn();

  const manifest = await createInitialDvdSourceSampleManifest({
    imagePath,
    sourceMetadataFingerprint: `dvdmeta-sha256:${"a".repeat(64)}`,
    acceptedEndLbaExclusive,
    checkpointRevision: 1,
    checkpointDigest: "b".repeat(64),
    unrecoveredSourceRanges: [],
    authorizeRead,
  });

  expect(manifest.samples).toHaveLength(DVD_SOURCE_SAMPLE_BAND_COUNT);
  expect(manifest.samples.map((sample) => sample.startLba))
    .toEqual(selectedStarts);
  expect(authorizeRead).toHaveBeenCalledTimes(
    DVD_SOURCE_SAMPLE_BAND_COUNT * 33 * 2,
  );
});
