import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateDvdImageGeometry,
} from "./dvd-geometry-validator.js";
import { proveDvdImageLayoutCompleteness } from "./dvd-layout-classifier.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function writeBothEndian16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

function writeBothEndian32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

function writeIsoDescriptorGeometry(
  descriptor: Buffer,
  type: 1 | 2,
  volumeSpaceSize: number,
): void {
  descriptor[0] = type;
  descriptor.write("CD001", 1, "ascii");
  descriptor[6] = 1;
  writeBothEndian32(descriptor, 80, volumeSpaceSize);
  if (type === 2) {
    descriptor.write("%/E", 88, "ascii");
  }
  writeBothEndian16(descriptor, 120, 1);
  writeBothEndian16(descriptor, 124, 1);
  writeBothEndian16(descriptor, 128, DVD_SECTOR_SIZE_BYTES);
}

function writeIsoGeometry(
  image: Buffer,
  volumeSpaceSize: number,
  supplementaryVolumeSpaceSize?: number,
): void {
  writeIsoDescriptorGeometry(
    image.subarray(16 * DVD_SECTOR_SIZE_BYTES, 17 * DVD_SECTOR_SIZE_BYTES),
    1,
    volumeSpaceSize,
  );
  const terminatorLba = supplementaryVolumeSpaceSize === undefined ? 17 : 18;
  if (supplementaryVolumeSpaceSize !== undefined) {
    writeIsoDescriptorGeometry(
      image.subarray(17 * DVD_SECTOR_SIZE_BYTES, 18 * DVD_SECTOR_SIZE_BYTES),
      2,
      supplementaryVolumeSpaceSize,
    );
  }
  const terminator = image.subarray(
    terminatorLba * DVD_SECTOR_SIZE_BYTES,
    (terminatorLba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
  terminator[0] = 255;
  terminator.write("CD001", 1, "ascii");
  terminator[6] = 1;
}

function udfDescriptorCrcLength(buffer: Buffer, identifier: number): number {
  if ([1, 2, 4, 5, 8].includes(identifier)) {
    return 496;
  }
  if (identifier === 6) {
    return 424 + buffer.readUInt32LE(264);
  }
  if (identifier === 7) {
    return 8 + buffer.readUInt32LE(20) * 8;
  }
  throw new Error(`Unsupported test UDF descriptor ${identifier}`);
}

function writeUdfTag(
  buffer: Buffer,
  identifier: number,
  location: number,
): void {
  const crcLength = udfDescriptorCrcLength(buffer, identifier);
  buffer.writeUInt16LE(identifier, 0);
  buffer.writeUInt16LE(2, 2);
  buffer[4] = 0;
  buffer[5] = 0;
  buffer.writeUInt16LE(1, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(crcLength, 10);
  buffer.writeUInt32LE(location, 12);
  let crc = 0;
  for (let index = 16; index < 16 + crcLength; index += 1) {
    crc ^= buffer[index]! << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }
  buffer.writeUInt16LE(crc, 8);
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) {
      checksum = (checksum + buffer[index]!) & 0xff;
    }
  }
  buffer[4] = checksum;
}

function sector(image: Buffer, lba: number): Buffer {
  return image.subarray(
    lba * DVD_SECTOR_SIZE_BYTES,
    (lba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
}

function writeUdfSequence(
  image: Buffer,
  startLba: number,
  partitionSectorCount: number,
): void {
  const primary = sector(image, startLba);
  writeUdfTag(primary, 1, startLba);

  const partition = sector(image, startLba + 1);
  partition.writeUInt16LE(0, 22);
  partition.writeUInt32LE(300, 188);
  partition.writeUInt32LE(partitionSectorCount, 192);
  writeUdfTag(partition, 5, startLba + 1);

  const logicalVolume = sector(image, startLba + 2);
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 212);
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 248);
  logicalVolume.writeUInt32LE(0, 252);
  logicalVolume.writeUInt16LE(0, 256);
  logicalVolume.writeUInt32LE(6, 264);
  logicalVolume.writeUInt32LE(1, 268);
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 432);
  logicalVolume.writeUInt32LE(290, 436);
  logicalVolume[440] = 1;
  logicalVolume[441] = 6;
  logicalVolume.writeUInt16LE(1, 442);
  logicalVolume.writeUInt16LE(0, 444);
  writeUdfTag(logicalVolume, 6, startLba + 2);

  const unallocated = sector(image, startLba + 3);
  unallocated.writeUInt32LE(0, 20);
  writeUdfTag(unallocated, 7, startLba + 3);

  writeUdfTag(sector(image, startLba + 4), 8, startLba + 4);
}

function writeUdfGeometry(
  image: Buffer,
  {
    mainPartitionSectorCount = 200,
    reservePartitionSectorCount = mainPartitionSectorCount,
  }: {
    mainPartitionSectorCount?: number;
    reservePartitionSectorCount?: number;
  } = {},
): void {
  for (const [lba, identifier] of [
    [18, "BEA01"],
    [19, "NSR02"],
    [20, "TEA01"],
  ] as const) {
    const recognition = sector(image, lba);
    recognition.write(identifier, 1, "ascii");
    recognition[6] = 1;
  }

  const anchor = sector(image, 256);
  anchor.writeUInt32LE(5 * DVD_SECTOR_SIZE_BYTES, 16);
  anchor.writeUInt32LE(257, 20);
  anchor.writeUInt32LE(5 * DVD_SECTOR_SIZE_BYTES, 24);
  anchor.writeUInt32LE(273, 28);
  writeUdfTag(anchor, 2, 256);

  writeUdfSequence(image, 257, mainPartitionSectorCount);
  writeUdfSequence(image, 273, reservePartitionSectorCount);

  for (const lba of [image.byteLength / DVD_SECTOR_SIZE_BYTES - 257,
    image.byteLength / DVD_SECTOR_SIZE_BYTES - 1]) {
    anchor.copy(sector(image, lba));
    writeUdfTag(sector(image, lba), 2, lba);
  }
}

function writeFixture(image: Buffer): {
  imagePath: string;
  sizeBytes: number;
} {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-geometry-"));
  temporaryDirectories.push(directory);
  const imagePath = join(directory, "partial.iso");
  writeFileSync(imagePath, image);
  return { imagePath, sizeBytes: image.byteLength };
}

function validateFixture(fixture: {
  imagePath: string;
  sizeBytes: number;
}): Promise<void> {
  return validateDvdImageGeometry({
    expectedByteCount: fixture.sizeBytes,
    imagePath: fixture.imagePath,
    signal: new AbortController().signal,
  });
}

describe("normal DVD volume geometry validation", () => {
  it("accepts exact ISO geometry without an optional UDF view", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600);

    await expect(validateFixture(writeFixture(image))).resolves.toBeUndefined();
  });

  it("rejects a malformed claimed UDF anchor behind a valid ISO view", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600);
    sector(image, 256).writeUInt16LE(2, 0);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF descriptor tag is malformed",
    );
  });

  it("rejects an ISO volume-space declaration beyond EOF", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 601);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD ISO volume-space declaration exceeds the image",
    );
  });

  it("fails closed when supported ISO geometry views disagree", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600, 599);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD ISO filesystem geometry views disagree",
    );
  });

  it("rejects malformed both-endian ISO numeric fields", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600);
    sector(image, 16).writeUInt32BE(599, 84);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD ISO volume-space declaration is malformed",
    );
  });

  it("bounds an unterminated ISO descriptor sequence", async () => {
    const image = Buffer.alloc(300 * DVD_SECTOR_SIZE_BYTES);
    for (let lba = 16; lba < 16 + 256; lba += 1) {
      const descriptor = sector(image, lba);
      descriptor[0] = 0;
      descriptor.write("CD001", 1, "ascii");
      descriptor[6] = 1;
    }
    writeIsoDescriptorGeometry(sector(image, 16), 1, 300);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD ISO volume descriptor sequence exceeds its read bound",
    );
  });

  it("ignores malformed path-table data that the strict prover traverses", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600);
    const primary = sector(image, 16);
    writeBothEndian32(primary, 132, DVD_SECTOR_SIZE_BYTES);
    primary.writeUInt32LE(700, 140);
    primary.writeUInt32BE(700, 148);
    const fixture = writeFixture(image);

    await expect(validateFixture(fixture)).resolves.toBeUndefined();
    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO path table is outside the volume");
  });

  it("accepts exact UDF geometry without an optional ISO view", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image);

    await expect(validateFixture(writeFixture(image))).resolves.toBeUndefined();
  });

  it("accepts agreeing ISO and UDF geometry views", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600);
    writeUdfGeometry(image);

    await expect(validateFixture(writeFixture(image))).resolves.toBeUndefined();
  });

  it("rejects a malformed claimed UDF alternate anchor", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 600);
    writeUdfGeometry(image);
    sector(image, 599)[16] = 1;

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF descriptor CRC is malformed",
    );
  });

  it("fails closed when ISO and UDF geometry views disagree", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeIsoGeometry(image, 599);
    writeUdfGeometry(image);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD ISO and UDF geometry views disagree",
    );
  });

  it("rejects a UDF partition declaration beyond EOF", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image, { mainPartitionSectorCount: 301 });

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF partition declaration exceeds the image",
    );
  });

  it("rejects overflowing UDF partition arithmetic", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image);
    for (const lba of [258, 274]) {
      const partition = sector(image, lba);
      partition.writeUInt32LE(0xffff_ffff, 188);
      partition.writeUInt32LE(0xffff_ffff, 192);
      writeUdfTag(partition, 5, lba);
    }

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF partition declaration exceeds the image",
    );
  });

  it("fails closed when main and reserve UDF geometry views disagree", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image, { reservePartitionSectorCount: 199 });

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF geometry views disagree",
    );
  });

  it("rejects an equivalent UDF primary-volume bound beyond EOF", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image);
    for (const lba of [257, 273]) {
      const primary = sector(image, lba);
      primary.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 328);
      primary.writeUInt32LE(600, 332);
      writeUdfTag(primary, 1, lba);
    }

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF primary-volume extent exceeds the image",
    );
  });

  it("rejects a UDF descriptor-sequence declaration beyond EOF", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image);
    const anchor = sector(image, 256);
    anchor.writeUInt32LE(2 * DVD_SECTOR_SIZE_BYTES, 16);
    anchor.writeUInt32LE(599, 20);
    writeUdfTag(anchor, 2, 256);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF main volume-descriptor sequence exceeds the image",
    );
  });

  it("bounds UDF volume-descriptor sequence reads", async () => {
    const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
    writeUdfGeometry(image);
    const anchor = sector(image, 256);
    anchor.writeUInt32LE(257 * DVD_SECTOR_SIZE_BYTES, 16);
    anchor.writeUInt32LE(300, 20);
    writeUdfTag(anchor, 2, 256);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD UDF volume descriptor sequence exceeds its read bound",
    );
  });

  it("rejects a non-sector-aligned partial image", async () => {
    const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES + 1);

    await expect(validateFixture(writeFixture(image))).rejects.toThrow(
      "DVD volume geometry image size is not sector aligned",
    );
  });
});
