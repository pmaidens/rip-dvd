import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyDvdImageDamage } from "./dvd-layout-classifier.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function writeBothEndian32(buffer: Buffer, offset: number, value: number) {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

function writeBothEndian16(buffer: Buffer, offset: number, value: number) {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

function isoDirectoryRecord({
  byteCount = DVD_SECTOR_SIZE_BYTES,
  extendedAttributeSectorCount = 0,
  extentLba,
  identifier,
  isDirectory,
}: {
  byteCount?: number;
  extendedAttributeSectorCount?: number;
  extentLba: number;
  identifier: Buffer;
  isDirectory: boolean;
}): Buffer {
  const recordLength = 33 + identifier.byteLength +
    (identifier.byteLength % 2 === 0 ? 1 : 0);
  const record = Buffer.alloc(recordLength);
  record[0] = recordLength;
  record[1] = extendedAttributeSectorCount;
  writeBothEndian32(record, 2, extentLba);
  writeBothEndian32(record, 10, byteCount);
  record[25] = isDirectory ? 2 : 0;
  writeBothEndian16(record, 28, 1);
  record[32] = identifier.byteLength;
  identifier.copy(record, 33);
  return record;
}

function writeDirectory(image: Buffer, lba: number, records: readonly Buffer[]) {
  let offset = lba * DVD_SECTOR_SIZE_BYTES;
  for (const record of records) {
    record.copy(image, offset);
    offset += record.byteLength;
  }
}

function writeSyntheticIsoLayout(
  image: Buffer,
  {
    fileStartLba,
    lastFileExtendedAttributeSectorCount = 0,
    pathTableLba,
    rootLba,
    videoFiles,
    videoDirectoryLba,
    volumeSpaceSize,
  }: {
    fileStartLba: number;
    lastFileExtendedAttributeSectorCount?: number;
    pathTableLba: number;
    rootLba: number;
    videoFiles?: readonly {
      byteCount?: number;
      extentLba: number;
      name: string;
    }[];
    videoDirectoryLba: number;
    volumeSpaceSize: number;
  },
) {
  const primaryVolumeDescriptor = image.subarray(
    16 * DVD_SECTOR_SIZE_BYTES,
    17 * DVD_SECTOR_SIZE_BYTES,
  );
  primaryVolumeDescriptor[0] = 1;
  primaryVolumeDescriptor.write("CD001", 1, "ascii");
  primaryVolumeDescriptor[6] = 1;
  writeBothEndian32(primaryVolumeDescriptor, 80, volumeSpaceSize);
  writeBothEndian16(
    primaryVolumeDescriptor,
    128,
    DVD_SECTOR_SIZE_BYTES,
  );
  writeBothEndian32(primaryVolumeDescriptor, 132, 10);
  primaryVolumeDescriptor.writeUInt32LE(pathTableLba, 140);
  primaryVolumeDescriptor.writeUInt32BE(pathTableLba + 1, 148);
  isoDirectoryRecord({
    extentLba: rootLba,
    identifier: Buffer.from([0]),
    isDirectory: true,
  }).copy(primaryVolumeDescriptor, 156);

  const terminator = image.subarray(
    17 * DVD_SECTOR_SIZE_BYTES,
    18 * DVD_SECTOR_SIZE_BYTES,
  );
  terminator[0] = 255;
  terminator.write("CD001", 1, "ascii");
  terminator[6] = 1;

  const current = isoDirectoryRecord({
    extentLba: rootLba,
    identifier: Buffer.from([0]),
    isDirectory: true,
  });
  const parent = isoDirectoryRecord({
    extentLba: rootLba,
    identifier: Buffer.from([1]),
    isDirectory: true,
  });
  writeDirectory(image, rootLba, [
    current,
    parent,
    isoDirectoryRecord({
      extentLba: videoDirectoryLba,
      identifier: Buffer.from("VIDEO_TS"),
      isDirectory: true,
    }),
  ]);
  const defaultVideoFiles: readonly {
    byteCount?: number;
    extentLba: number;
    name: string;
  }[] = [
    { extentLba: fileStartLba, name: "VIDEO_TS.IFO" },
    { extentLba: fileStartLba + 1, name: "VIDEO_TS.BUP" },
    { extentLba: fileStartLba + 2, name: "VIDEO_TS.VOB" },
    { extentLba: fileStartLba + 3, name: "VTS_01_1.VOB" },
  ];
  writeDirectory(image, videoDirectoryLba, [
    isoDirectoryRecord({
      extentLba: videoDirectoryLba,
      identifier: Buffer.from([0]),
      isDirectory: true,
    }),
    isoDirectoryRecord({
      extentLba: rootLba,
      identifier: Buffer.from([1]),
      isDirectory: true,
    }),
    ...(videoFiles ?? defaultVideoFiles).map((file, index, files) =>
      isoDirectoryRecord({
        byteCount: file.byteCount,
        extendedAttributeSectorCount:
          index === files.length - 1
            ? lastFileExtendedAttributeSectorCount
            : 0,
        extentLba: file.extentLba,
        identifier: Buffer.from(`${file.name};1`),
        isDirectory: false,
      })
    ),
  ]);
}

function writeTitleVobuAddressMap(
  image: Buffer,
  ifoLba: number,
  vobuStartSectors: readonly number[],
) {
  const ifo = image.subarray(
    ifoLba * DVD_SECTOR_SIZE_BYTES,
    (ifoLba + 2) * DVD_SECTOR_SIZE_BYTES,
  );
  ifo.write("DVDVIDEO-VTS", 0, "ascii");
  ifo.writeUInt32BE(1, 0xe4);
  const addressMap = ifo.subarray(DVD_SECTOR_SIZE_BYTES);
  addressMap.writeUInt32BE(3 + vobuStartSectors.length * 4, 0);
  for (const [index, startSector] of vobuStartSectors.entries()) {
    addressMap.writeUInt32BE(startSector, 4 + index * 4);
  }
}

function writeUdfTag(buffer: Buffer, identifier: number) {
  buffer.writeUInt16LE(identifier, 0);
  buffer.writeUInt16LE(2, 2);
  buffer[4] = 0;
  buffer.writeUInt16LE(1, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(0, 10);
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) {
      checksum = (checksum + buffer[index]!) & 0xff;
    }
  }
  buffer[4] = checksum;
}

function writeUdfLongAd(
  buffer: Buffer,
  offset: number,
  extentLength: number,
  logicalBlockNumber: number,
  partitionReferenceNumber = 0,
) {
  buffer.writeUInt32LE(extentLength, offset);
  buffer.writeUInt32LE(logicalBlockNumber, offset + 4);
  buffer.writeUInt16LE(partitionReferenceNumber, offset + 8);
}

function udfFileIdentifier({
  childLba,
  fileCharacteristics,
  name,
}: {
  childLba: number;
  fileCharacteristics: number;
  name?: string;
}): Buffer {
  const identifier = name === undefined
    ? Buffer.alloc(0)
    : Buffer.concat([Buffer.from([8]), Buffer.from(name, "ascii")]);
  const recordLength = Math.ceil((38 + identifier.byteLength) / 4) * 4;
  const record = Buffer.alloc(recordLength);
  record[18] = fileCharacteristics;
  record[19] = identifier.byteLength;
  writeUdfLongAd(record, 20, DVD_SECTOR_SIZE_BYTES, childLba);
  identifier.copy(record, 38);
  writeUdfTag(record, 257);
  return record;
}

function writeUdfFileEntry(
  image: Buffer,
  {
    dataLba,
    fileEntryLba,
    fileType,
    informationLength,
    allocationByteCount = DVD_SECTOR_SIZE_BYTES,
  }: {
    allocationByteCount?: number;
    dataLba: number;
    fileEntryLba: number;
    fileType: 4 | 5;
    informationLength: number;
  },
) {
  const entry = image.subarray(
    fileEntryLba * DVD_SECTOR_SIZE_BYTES,
    (fileEntryLba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
  entry[27] = fileType;
  entry.writeBigUInt64LE(BigInt(informationLength), 56);
  entry.writeUInt32LE(0, 168);
  entry.writeUInt32LE(8, 172);
  entry.writeUInt32LE(allocationByteCount, 176);
  entry.writeUInt32LE(dataLba, 180);
  writeUdfTag(entry, 261);
}

function writeUdfDirectory(
  image: Buffer,
  lba: number,
  records: readonly Buffer[],
): number {
  let offset = lba * DVD_SECTOR_SIZE_BYTES;
  const start = offset;
  for (const record of records) {
    record.copy(image, offset);
    offset += record.byteLength;
  }
  return offset - start;
}

function writeSyntheticUdfLayout(
  image: Buffer,
  {
    payloadTitleVobStartLba,
  }: { payloadTitleVobStartLba?: number } = {},
) {
  for (const [lba, identifier] of [
    [18, "BEA01"],
    [19, "NSR02"],
    [20, "TEA01"],
  ] as const) {
    image.write(identifier, lba * DVD_SECTOR_SIZE_BYTES + 1, "ascii");
  }
  const anchor = image.subarray(
    256 * DVD_SECTOR_SIZE_BYTES,
    257 * DVD_SECTOR_SIZE_BYTES,
  );
  anchor.writeUInt32LE(4 * DVD_SECTOR_SIZE_BYTES, 16);
  anchor.writeUInt32LE(257, 20);
  anchor.writeUInt32LE(4 * DVD_SECTOR_SIZE_BYTES, 24);
  anchor.writeUInt32LE(273, 28);
  writeUdfTag(anchor, 2);

  const primary = image.subarray(
    257 * DVD_SECTOR_SIZE_BYTES,
    258 * DVD_SECTOR_SIZE_BYTES,
  );
  writeUdfTag(primary, 1);
  const partition = image.subarray(
    258 * DVD_SECTOR_SIZE_BYTES,
    259 * DVD_SECTOR_SIZE_BYTES,
  );
  partition.writeUInt16LE(0, 22);
  partition.writeUInt32LE(300, 188);
  partition.writeUInt32LE(300, 192);
  writeUdfTag(partition, 5);
  const logicalVolume = image.subarray(
    259 * DVD_SECTOR_SIZE_BYTES,
    260 * DVD_SECTOR_SIZE_BYTES,
  );
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 212);
  writeUdfLongAd(logicalVolume, 248, DVD_SECTOR_SIZE_BYTES, 0);
  logicalVolume.writeUInt32LE(6, 264);
  logicalVolume.writeUInt32LE(1, 268);
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 432);
  logicalVolume.writeUInt32LE(290, 436);
  logicalVolume[440] = 1;
  logicalVolume[441] = 6;
  logicalVolume.writeUInt16LE(1, 442);
  logicalVolume.writeUInt16LE(0, 444);
  writeUdfTag(logicalVolume, 6);
  writeUdfTag(
    image.subarray(
      290 * DVD_SECTOR_SIZE_BYTES,
      291 * DVD_SECTOR_SIZE_BYTES,
    ),
    9,
  );
  writeUdfTag(
    image.subarray(
      260 * DVD_SECTOR_SIZE_BYTES,
      261 * DVD_SECTOR_SIZE_BYTES,
    ),
    8,
  );
  for (let offset = 0; offset < 4; offset += 1) {
    image.copy(
      image,
      (273 + offset) * DVD_SECTOR_SIZE_BYTES,
      (257 + offset) * DVD_SECTOR_SIZE_BYTES,
      (258 + offset) * DVD_SECTOR_SIZE_BYTES,
    );
  }

  const fileSet = image.subarray(
    300 * DVD_SECTOR_SIZE_BYTES,
    301 * DVD_SECTOR_SIZE_BYTES,
  );
  writeUdfLongAd(fileSet, 400, DVD_SECTOR_SIZE_BYTES, 1);
  writeUdfTag(fileSet, 256);
  const rootDirectoryBytes = writeUdfDirectory(image, 302, [
    udfFileIdentifier({ childLba: 1, fileCharacteristics: 8 }),
    udfFileIdentifier({
      childLba: 3,
      fileCharacteristics: 2,
      name: "VIDEO_TS",
    }),
  ]);
  writeUdfFileEntry(image, {
    dataLba: 2,
    fileEntryLba: 301,
    fileType: 4,
    informationLength: rootDirectoryBytes,
  });
  const videoDirectoryEntries = payloadTitleVobStartLba === undefined
    ? [
        { childLba: 5, name: "VIDEO_TS.IFO" },
        { childLba: 6, name: "VIDEO_TS.BUP" },
        { childLba: 7, name: "VIDEO_TS.VOB" },
        { childLba: 8, name: "VTS_01_1.VOB" },
      ]
    : [
        { childLba: 5, name: "VIDEO_TS.IFO" },
        { childLba: 6, name: "VIDEO_TS.BUP" },
        { childLba: 7, name: "VIDEO_TS.VOB" },
        { childLba: 8, name: "VTS_01_0.IFO" },
        { childLba: 9, name: "VTS_01_0.BUP" },
        { childLba: 10, name: "VTS_01_1.VOB" },
      ];
  const videoDirectoryBytes = writeUdfDirectory(image, 304, [
    udfFileIdentifier({ childLba: 1, fileCharacteristics: 8 }),
    ...videoDirectoryEntries.map(({ childLba, name }) =>
      udfFileIdentifier({ childLba, fileCharacteristics: 0, name })
    ),
  ]);
  writeUdfFileEntry(image, {
    dataLba: 4,
    fileEntryLba: 303,
    fileType: 4,
    informationLength: videoDirectoryBytes,
  });
  if (payloadTitleVobStartLba === undefined) {
    for (let offset = 0; offset < 4; offset += 1) {
      writeUdfFileEntry(image, {
        dataLba: 10 + offset,
        fileEntryLba: 305 + offset,
        fileType: 5,
        informationLength: DVD_SECTOR_SIZE_BYTES,
      });
    }
  } else {
    for (const file of [
      { dataLba: 30, fileEntryLba: 305, sectorCount: 1 },
      { dataLba: 31, fileEntryLba: 306, sectorCount: 1 },
      { dataLba: 32, fileEntryLba: 307, sectorCount: 1 },
      { dataLba: 33, fileEntryLba: 308, sectorCount: 2 },
      { dataLba: 50, fileEntryLba: 309, sectorCount: 1 },
      {
        dataLba: payloadTitleVobStartLba - 300,
        fileEntryLba: 310,
        sectorCount: 6,
      },
    ]) {
      const byteCount = file.sectorCount * DVD_SECTOR_SIZE_BYTES;
      writeUdfFileEntry(image, {
        allocationByteCount: byteCount,
        dataLba: file.dataLba,
        fileEntryLba: file.fileEntryLba,
        fileType: 5,
        informationLength: byteCount,
      });
    }
  }
}

function writeFixture(image: Buffer, badLba: number) {
  image.fill(
    0,
    badLba * DVD_SECTOR_SIZE_BYTES,
    (badLba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-layout-"));
  temporaryDirectories.push(directory);
  const imagePath = join(directory, "synthetic-dvd.iso");
  writeFileSync(imagePath, image);
  return { imagePath, sizeBytes: image.byteLength };
}

function createSyntheticDvdImage(badLba: number): {
  imagePath: string;
  sizeBytes: number;
} {
  const image = Buffer.alloc(64 * DVD_SECTOR_SIZE_BYTES);
  writeSyntheticIsoLayout(image, {
    fileStartLba: 22,
    pathTableLba: 18,
    rootLba: 20,
    videoDirectoryLba: 21,
    volumeSpaceSize: 60,
  });
  return writeFixture(image, badLba);
}

function createSyntheticPayloadDvdImage(
  badLba: number,
  vobuStartSectors: readonly number[] = [0, 3],
): {
  imagePath: string;
  sizeBytes: number;
} {
  const image = Buffer.alloc(96 * DVD_SECTOR_SIZE_BYTES);
  writeSyntheticIsoLayout(image, {
    fileStartLba: 22,
    pathTableLba: 18,
    rootLba: 20,
    videoDirectoryLba: 21,
    videoFiles: [
      { extentLba: 22, name: "VIDEO_TS.IFO" },
      { extentLba: 23, name: "VIDEO_TS.BUP" },
      { extentLba: 24, name: "VIDEO_TS.VOB" },
      {
        byteCount: 2 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 25,
        name: "VTS_01_0.IFO",
      },
      { extentLba: 27, name: "VTS_01_0.BUP" },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 28,
        name: "VTS_01_1.VOB",
      },
    ],
    volumeSpaceSize: 90,
  });
  writeTitleVobuAddressMap(image, 25, vobuStartSectors);
  return writeFixture(image, badLba);
}

function createSyntheticUdfDvdImage(badLba: number): {
  imagePath: string;
  sizeBytes: number;
} {
  const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
  writeSyntheticIsoLayout(image, {
    fileStartLba: 310,
    pathTableLba: 40,
    rootLba: 42,
    videoDirectoryLba: 43,
    volumeSpaceSize: 600,
  });
  writeSyntheticUdfLayout(image);
  return writeFixture(image, badLba);
}

function createSyntheticContradictoryUdfPayloadDvdImage(badLba: number): {
  imagePath: string;
  sizeBytes: number;
} {
  const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
  writeSyntheticIsoLayout(image, {
    fileStartLba: 330,
    pathTableLba: 40,
    rootLba: 42,
    videoDirectoryLba: 43,
    videoFiles: [
      { extentLba: 330, name: "VIDEO_TS.IFO" },
      { extentLba: 331, name: "VIDEO_TS.BUP" },
      { extentLba: 332, name: "VIDEO_TS.VOB" },
      {
        byteCount: 2 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 333,
        name: "VTS_01_0.IFO",
      },
      { extentLba: 335, name: "VTS_01_0.BUP" },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 336,
        name: "VTS_01_1.VOB",
      },
    ],
    volumeSpaceSize: 600,
  });
  writeSyntheticUdfLayout(image, { payloadTitleVobStartLba: 335 });
  writeTitleVobuAddressMap(image, 333, [0, 3]);
  return writeFixture(image, badLba);
}

describe("DVD layout damage classification", () => {
  it("accepts a substituted sector proved outside filesystem allocation", async () => {
    const fixture = createSyntheticDvdImage(50);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 50, sectorCount: 1 }],
    })).resolves.toEqual({ outcome: "accepted" });
  });

  it("identifies isolated MPEG payload damage in a title VOB", async () => {
    const fixture = createSyntheticPayloadDvdImage(29);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 29, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleSetNumbers: [1],
      outcome: "accepted",
    });
  });

  it("rejects a substituted VOB navigation pack", async () => {
    const fixture = createSyntheticPayloadDvdImage(31);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 31, sectorCount: 1 }],
    })).resolves.toEqual({ outcome: "rejected", reason: "navigation" });
  });

  it("fails closed when the title VOBU address map is malformed", async () => {
    const fixture = createSyntheticPayloadDvdImage(29, [0, 0]);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 29, sectorCount: 1 }],
    })).rejects.toThrow("DVD title VOBU address map is malformed");
  });

  it("rejects contradictory ISO and UDF title VOB layouts as ambiguous", async () => {
    const fixture = createSyntheticContradictoryUdfPayloadDvdImage(337);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 337, sectorCount: 1 }],
    })).resolves.toEqual({ outcome: "rejected", reason: "ambiguous" });
  });

  it.each([
    [1, "ambiguous"],
    [30, "ambiguous"],
    [16, "filesystem_metadata"],
    [20, "directory_data"],
    [22, "ifo"],
    [23, "bup"],
    [24, "menu"],
    [25, "ambiguous"],
    [63, "unmappable"],
  ] as const)("rejects structural damage at LBA %i as %s", async (badLba, reason) => {
    const fixture = createSyntheticDvdImage(badLba);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: badLba, sectorCount: 1 }],
    })).resolves.toEqual({ outcome: "rejected", reason });
  });

  it("accepts unused space only after traversing the UDF allocation tree", async () => {
    const fixture = createSyntheticUdfDvdImage(500);

    await expect(classifyDvdImageDamage({
      expectedByteCount: fixture.sizeBytes,
      imagePath: fixture.imagePath,
      unreadableSectorRanges: [{ startLba: 500, sectorCount: 1 }],
    })).resolves.toEqual({ outcome: "accepted" });
  });

  it("rejects damage to a UDF file entry as filesystem metadata", async () => {
    const fixture = createSyntheticUdfDvdImage(301);

    await expect(classifyDvdImageDamage({
      expectedByteCount: fixture.sizeBytes,
      imagePath: fixture.imagePath,
      unreadableSectorRanges: [{ startLba: 301, sectorCount: 1 }],
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "filesystem_metadata",
    });
  });

  it("classifies file data after an ISO extended-attribute record", async () => {
    const image = Buffer.alloc(64 * DVD_SECTOR_SIZE_BYTES);
    writeSyntheticIsoLayout(image, {
      fileStartLba: 22,
      lastFileExtendedAttributeSectorCount: 1,
      pathTableLba: 18,
      rootLba: 20,
      videoDirectoryLba: 21,
      volumeSpaceSize: 60,
    });
    const fixture = writeFixture(image, 26);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 26, sectorCount: 1 }],
    })).resolves.toEqual({
      outcome: "rejected",
      reason: "ambiguous",
    });
  });
});
