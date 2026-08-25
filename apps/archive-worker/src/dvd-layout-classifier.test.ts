import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyDvdImageDamage,
  proveDvdImageLayoutCompleteness,
} from "./dvd-layout-classifier.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";

const DVD_NAV_PCI_PAYLOAD_OFFSET = 45;
const DVD_NAV_DSI_PAYLOAD_OFFSET = 1_031;
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

function isoPathTable(
  entries: readonly { extentLba: number; identifier: Buffer; parent: number }[],
  byteOrder: "big-endian" | "little-endian",
): Buffer {
  const table = Buffer.alloc(entries.reduce(
    (total, entry) => total + 8 + entry.identifier.byteLength +
      entry.identifier.byteLength % 2,
    0,
  ));
  let offset = 0;
  for (const entry of entries) {
    table[offset] = entry.identifier.byteLength;
    if (byteOrder === "little-endian") {
      table.writeUInt32LE(entry.extentLba, offset + 2);
      table.writeUInt16LE(entry.parent, offset + 6);
    } else {
      table.writeUInt32BE(entry.extentLba, offset + 2);
      table.writeUInt16BE(entry.parent, offset + 6);
    }
    entry.identifier.copy(table, offset + 8);
    offset += 8 + entry.identifier.byteLength + entry.identifier.byteLength % 2;
  }
  return table;
}

function jolietIdentifier(value: string): Buffer {
  const identifier = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    identifier.writeUInt16BE(value.charCodeAt(index), index * 2);
  }
  return identifier;
}

function writeSyntheticIsoLayout(
  image: Buffer,
  {
    fileStartLba,
    lastFileExtendedAttributeSectorCount = 0,
    legacySalvage = false,
    pathTableLba,
    rootLba,
    videoFiles,
    videoDirectoryLba,
    volumeSpaceSize,
  }: {
    fileStartLba: number;
    lastFileExtendedAttributeSectorCount?: number;
    legacySalvage?: boolean;
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
  if (!legacySalvage) {
    writeBothEndian16(primaryVolumeDescriptor, 120, 1);
    writeBothEndian16(primaryVolumeDescriptor, 124, 1);
  }
  writeBothEndian16(
    primaryVolumeDescriptor,
    128,
    DVD_SECTOR_SIZE_BYTES,
  );
  const pathTableEntries = [
    { extentLba: rootLba, identifier: Buffer.from([0]), parent: 1 },
    {
      extentLba: videoDirectoryLba,
      identifier: Buffer.from("VIDEO_TS"),
      parent: 1,
    },
  ];
  const littleEndianPathTable = isoPathTable(
    pathTableEntries,
    "little-endian",
  );
  const bigEndianPathTable = isoPathTable(pathTableEntries, "big-endian");
  writeBothEndian32(
    primaryVolumeDescriptor,
    132,
    legacySalvage ? 10 : littleEndianPathTable.byteLength,
  );
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

  if (!legacySalvage) {
    littleEndianPathTable.copy(image, pathTableLba * DVD_SECTOR_SIZE_BYTES);
    bigEndianPathTable.copy(image, (pathTableLba + 1) * DVD_SECTOR_SIZE_BYTES);
  }

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

function writeSyntheticJolietView(
  image: Buffer,
  videoFiles: readonly {
    byteCount?: number;
    extentLba: number;
    name: string;
  }[],
  rootFiles: readonly {
    byteCount?: number;
    extentLba: number;
    name: string;
  }[] = [],
) {
  image.copy(
    image,
    18 * DVD_SECTOR_SIZE_BYTES,
    17 * DVD_SECTOR_SIZE_BYTES,
    18 * DVD_SECTOR_SIZE_BYTES,
  );
  image.copy(
    image,
    17 * DVD_SECTOR_SIZE_BYTES,
    16 * DVD_SECTOR_SIZE_BYTES,
    17 * DVD_SECTOR_SIZE_BYTES,
  );
  const descriptor = image.subarray(
    17 * DVD_SECTOR_SIZE_BYTES,
    18 * DVD_SECTOR_SIZE_BYTES,
  );
  descriptor[0] = 2;
  descriptor.write("%/E", 88, "ascii");
  const pathEntries = [
    { extentLba: 52, identifier: Buffer.from([0]), parent: 1 },
    {
      extentLba: 53,
      identifier: jolietIdentifier("VIDEO_TS"),
      parent: 1,
    },
  ];
  const littleEndianPathTable = isoPathTable(
    pathEntries,
    "little-endian",
  );
  const bigEndianPathTable = isoPathTable(pathEntries, "big-endian");
  writeBothEndian32(descriptor, 132, littleEndianPathTable.byteLength);
  descriptor.writeUInt32LE(50, 140);
  descriptor.writeUInt32BE(51, 148);
  isoDirectoryRecord({
    extentLba: 52,
    identifier: Buffer.from([0]),
    isDirectory: true,
  }).copy(descriptor, 156);
  littleEndianPathTable.copy(image, 50 * DVD_SECTOR_SIZE_BYTES);
  bigEndianPathTable.copy(image, 51 * DVD_SECTOR_SIZE_BYTES);
  writeDirectory(image, 52, [
    isoDirectoryRecord({
      extentLba: 52,
      identifier: Buffer.from([0]),
      isDirectory: true,
    }),
    isoDirectoryRecord({
      extentLba: 52,
      identifier: Buffer.from([1]),
      isDirectory: true,
    }),
    isoDirectoryRecord({
      extentLba: 53,
      identifier: jolietIdentifier("VIDEO_TS"),
      isDirectory: true,
    }),
    ...rootFiles.map((file) =>
      isoDirectoryRecord({
        byteCount: file.byteCount,
        extentLba: file.extentLba,
        identifier: jolietIdentifier(`${file.name};1`),
        isDirectory: false,
      })
    ),
  ]);
  writeDirectory(image, 53, [
    isoDirectoryRecord({
      extentLba: 53,
      identifier: Buffer.from([0]),
      isDirectory: true,
    }),
    isoDirectoryRecord({
      extentLba: 52,
      identifier: Buffer.from([1]),
      isDirectory: true,
    }),
    ...videoFiles.map((file) =>
      isoDirectoryRecord({
        byteCount: file.byteCount,
        extentLba: file.extentLba,
        identifier: jolietIdentifier(`${file.name};1`),
        isDirectory: false,
      })
    ),
  ]);
}

interface SyntheticGlobalTitle {
  angleCount?: number;
  parts: readonly { pgcNumber: number; programNumber: number }[];
  titleSetTitleNumber: number;
}

interface SyntheticProgramChain {
  cells: readonly {
    blockMode?: 0 | 1 | 2 | 3;
    blockType?: 0 | 1;
    firstSector: number;
    lastSector: number;
    lastVobuStartSector?: number;
  }[];
  programStartCells: readonly number[];
}

function writeCellAddressTable(
  table: Buffer,
  cells: readonly {
    cellNumber: number;
    firstSector: number;
    lastSector: number;
    vobId: number;
  }[],
) {
  table.writeUInt16BE(new Set(cells.map((cell) => cell.vobId)).size, 0);
  table.writeUInt32BE(8 + cells.length * 12 - 1, 4);
  for (const [index, cell] of cells.entries()) {
    const offset = 8 + index * 12;
    table.writeUInt16BE(cell.vobId, offset);
    table[offset + 2] = cell.cellNumber;
    table.writeUInt32BE(cell.firstSector, offset + 4);
    table.writeUInt32BE(cell.lastSector, offset + 8);
  }
}

function syntheticCellNumberForSector(
  programChains: readonly SyntheticProgramChain[],
  sector: number,
): number {
  const cells = [...new Map(
    programChains.flatMap((chain) => chain.cells).map((cell) => [
      `${cell.firstSector}:${cell.lastSector}`,
      cell,
    ]),
  ).values()];
  const cellNumber = cells.findIndex((cell) =>
    sector >= cell.firstSector && sector <= cell.lastSector
  ) + 1;
  if (cellNumber <= 0) {
    throw new Error("Synthetic DVD VOBU has no cell");
  }
  return cellNumber;
}

function writeDvdNavigationRelationships(
  image: Buffer,
  {
    globalTitles,
    includeMenuNavigation = false,
    managerIfoLba,
    managerLastSector,
    managerMenuVobLba,
    programChains,
    titleSetIfoLba,
    titleSetLastSector,
    titleVobLba,
    vobuStartSectors,
  }: {
    globalTitles: readonly SyntheticGlobalTitle[];
    includeMenuNavigation?: boolean;
    managerIfoLba: number;
    managerLastSector: number;
    managerMenuVobLba: number;
    programChains: readonly SyntheticProgramChain[];
    titleSetIfoLba: number;
    titleSetLastSector: number;
    titleVobLba: number;
    vobuStartSectors: readonly number[];
  },
) {
  const managerIfo = image.subarray(
    managerIfoLba * DVD_SECTOR_SIZE_BYTES,
    (managerIfoLba + (includeMenuNavigation ? 6 : 2)) *
      DVD_SECTOR_SIZE_BYTES,
  );
  managerIfo.write("DVDVIDEO-VMG", 0, "ascii");
  managerIfo.writeUInt32BE(managerLastSector, 0x0c);
  managerIfo.writeUInt32BE(
    (includeMenuNavigation ? 6 : 2) - 1,
    0x1c,
  );
  managerIfo.writeUInt16BE(1, 0x3e);
  managerIfo.writeUInt32BE(0x1ff, 0x80);
  managerIfo.writeUInt32BE(managerMenuVobLba - managerIfoLba, 0xc0);
  managerIfo.writeUInt32BE(1, 0xc4);
  const titleSearchTable = managerIfo.subarray(DVD_SECTOR_SIZE_BYTES);
  titleSearchTable.writeUInt16BE(globalTitles.length, 0);
  titleSearchTable.writeUInt32BE(8 + globalTitles.length * 12 - 1, 4);
  for (const [index, title] of globalTitles.entries()) {
    const offset = 8 + index * 12;
    titleSearchTable[offset + 1] = title.angleCount ?? 1;
    titleSearchTable.writeUInt16BE(title.parts.length, offset + 2);
    titleSearchTable[offset + 6] = 1;
    titleSearchTable[offset + 7] = title.titleSetTitleNumber;
    titleSearchTable.writeUInt32BE(titleSetIfoLba, offset + 8);
  }
  if (includeMenuNavigation) {
    managerIfo.writeUInt32BE(2, 0xc8);
    managerIfo.writeUInt32BE(5, 0xd0);
    managerIfo.writeUInt32BE(4, 0xd8);
    managerIfo.writeUInt32BE(3, 0xdc);
    const programChainUnits = managerIfo.subarray(
      2 * DVD_SECTOR_SIZE_BYTES,
    );
    programChainUnits.writeUInt16BE(1, 0);
    programChainUnits.writeUInt32BE(296, 4);
    programChainUnits.write("en", 8, "ascii");
    programChainUnits[11] = 1;
    programChainUnits.writeUInt32BE(16, 12);
    const programChainTable = programChainUnits.subarray(16);
    programChainTable.writeUInt16BE(1, 0);
    programChainTable.writeUInt32BE(280, 4);
    programChainTable.writeUInt32BE(16, 12);
    const programChain = programChainTable.subarray(16);
    programChain[2] = 1;
    programChain[3] = 1;
    programChain.writeUInt16BE(236, 230);
    programChain.writeUInt16BE(237, 232);
    programChain.writeUInt16BE(261, 234);
    programChain[236] = 1;
    programChain.writeUInt32BE(0, 237 + 8);
    programChain.writeUInt32BE(0, 237 + 12);
    programChain.writeUInt32BE(0, 237 + 16);
    programChain.writeUInt32BE(0, 237 + 20);
    programChain.writeUInt16BE(1, 261);
    programChain[264] = 1;
    const menuAddressMap = managerIfo.subarray(
      3 * DVD_SECTOR_SIZE_BYTES,
    );
    menuAddressMap.writeUInt32BE(7, 0);
    menuAddressMap.writeUInt32BE(0, 4);
    writeCellAddressTable(
      managerIfo.subarray(4 * DVD_SECTOR_SIZE_BYTES),
      [{ cellNumber: 1, firstSector: 0, lastSector: 0, vobId: 1 }],
    );
    const titleSetAttributes = managerIfo.subarray(
      5 * DVD_SECTOR_SIZE_BYTES,
    );
    titleSetAttributes.writeUInt16BE(1, 0);
    titleSetAttributes.writeUInt32BE(367, 4);
    titleSetAttributes.writeUInt32BE(12, 8);
    titleSetAttributes.writeUInt32BE(355, 12);
  }

  const titleCells = [...new Map(
    programChains.flatMap((chain) => chain.cells).map((cell) => [
      `${cell.firstSector}:${cell.lastSector}`,
      cell,
    ]),
  ).values()].map((cell, index) => ({
    cellNumber: index + 1,
    firstSector: cell.firstSector,
    lastSector: cell.lastSector,
    vobId: 1,
  }));

  const ifo = image.subarray(
    titleSetIfoLba * DVD_SECTOR_SIZE_BYTES,
    (titleSetIfoLba + (includeMenuNavigation ? 6 : 5)) *
      DVD_SECTOR_SIZE_BYTES,
  );
  ifo.write("DVDVIDEO-VTS", 0, "ascii");
  ifo.writeUInt32BE(titleSetLastSector, 0x0c);
  ifo.writeUInt32BE((includeMenuNavigation ? 6 : 5) - 1, 0x1c);
  ifo.writeUInt32BE(0x3d7, 0x80);
  ifo.writeUInt32BE(titleVobLba - titleSetIfoLba, 0xc4);
  ifo.writeUInt32BE(1, 0xc8);
  ifo.writeUInt32BE(2, 0xcc);
  if (includeMenuNavigation) {
    ifo.writeUInt32BE(5, 0xd4);
  }
  ifo.writeUInt32BE(4, 0xe0);
  ifo.writeUInt32BE(3, 0xe4);

  const partTable = ifo.subarray(DVD_SECTOR_SIZE_BYTES);
  const localTitleCount = Math.max(
    ...globalTitles.map((title) => title.titleSetTitleNumber),
  );
  partTable.writeUInt16BE(localTitleCount, 0);
  let partOffset = 8 + localTitleCount * 4;
  for (let localTitleNumber = 1; localTitleNumber <= localTitleCount; localTitleNumber += 1) {
    const title = globalTitles.find((candidate) =>
      candidate.titleSetTitleNumber === localTitleNumber
    );
    if (title === undefined) {
      throw new Error("Synthetic DVD titles must be contiguous");
    }
    partTable.writeUInt32BE(partOffset, 8 + (localTitleNumber - 1) * 4);
    for (const part of title.parts) {
      partTable.writeUInt16BE(part.pgcNumber, partOffset);
      partTable.writeUInt16BE(part.programNumber, partOffset + 2);
      partOffset += 4;
    }
  }
  partTable.writeUInt32BE(partOffset - 1, 4);

  const programChainTable = ifo.subarray(2 * DVD_SECTOR_SIZE_BYTES);
  programChainTable.writeUInt16BE(programChains.length, 0);
  let pgcOffset = 8 + programChains.length * 8;
  for (const [index, chain] of programChains.entries()) {
    programChainTable.writeUInt32BE(pgcOffset, 8 + index * 8 + 4);
    programChainTable[pgcOffset + 2] = chain.programStartCells.length;
    programChainTable[pgcOffset + 3] = chain.cells.length;
    const programMapOffset = 236;
    const cellPlaybackOffset = programMapOffset + chain.programStartCells.length;
    const cellPositionOffset = cellPlaybackOffset + chain.cells.length * 24;
    programChainTable.writeUInt16BE(programMapOffset, pgcOffset + 230);
    programChainTable.writeUInt16BE(cellPlaybackOffset, pgcOffset + 232);
    programChainTable.writeUInt16BE(cellPositionOffset, pgcOffset + 234);
    for (const [programIndex, startCell] of chain.programStartCells.entries()) {
      programChainTable[pgcOffset + programMapOffset + programIndex] = startCell;
    }
    for (const [cellIndex, cell] of chain.cells.entries()) {
      const playbackOffset = pgcOffset + cellPlaybackOffset + cellIndex * 24;
      programChainTable[playbackOffset] =
        ((cell.blockMode ?? 0) << 6) | ((cell.blockType ?? 0) << 4);
      programChainTable.writeUInt32BE(cell.firstSector, playbackOffset + 8);
      programChainTable.writeUInt32BE(cell.firstSector, playbackOffset + 12);
      const lastVobuStartSector = cell.lastVobuStartSector ??
        vobuStartSectors.filter((sector) =>
          sector >= cell.firstSector && sector <= cell.lastSector
        ).at(-1);
      if (lastVobuStartSector === undefined) {
        throw new Error("Synthetic DVD cell has no VOBU");
      }
      programChainTable.writeUInt32BE(lastVobuStartSector, playbackOffset + 16);
      programChainTable.writeUInt32BE(cell.lastSector, playbackOffset + 20);
      const positionOffset = pgcOffset + cellPositionOffset + cellIndex * 4;
      programChainTable.writeUInt16BE(1, positionOffset);
      programChainTable[positionOffset + 3] = titleCells.find((candidate) =>
        candidate.firstSector === cell.firstSector &&
        candidate.lastSector === cell.lastSector
      )!.cellNumber;
    }
    pgcOffset += cellPositionOffset + chain.cells.length * 4;
  }
  programChainTable.writeUInt32BE(pgcOffset - 1, 4);

  const addressMap = ifo.subarray(3 * DVD_SECTOR_SIZE_BYTES);
  addressMap.writeUInt32BE(3 + vobuStartSectors.length * 4, 0);
  for (const [index, startSector] of vobuStartSectors.entries()) {
    addressMap.writeUInt32BE(startSector, 4 + index * 4);
  }
  writeCellAddressTable(
    ifo.subarray(4 * DVD_SECTOR_SIZE_BYTES),
    titleCells,
  );
  if (includeMenuNavigation) {
    const timeMaps = ifo.subarray(5 * DVD_SECTOR_SIZE_BYTES);
    timeMaps.writeUInt16BE(localTitleCount, 0);
    let timeMapOffset = 8 + localTitleCount * 4;
    for (let index = 0; index < localTitleCount; index += 1) {
      timeMaps.writeUInt32BE(timeMapOffset, 8 + index * 4);
      timeMaps[timeMapOffset] = 1;
      timeMaps.writeUInt16BE(vobuStartSectors.length, timeMapOffset + 2);
      for (const [entry, sector] of vobuStartSectors.entries()) {
        timeMaps.writeUInt32BE(sector, timeMapOffset + 4 + entry * 4);
      }
      timeMapOffset += 4 + vobuStartSectors.length * 4;
    }
    timeMaps.writeUInt32BE(timeMapOffset - 1, 4);
  }
}

function writeDvdNavPack(
  image: Buffer,
  absoluteLba: number,
  relativeLba: number,
  vobuEndAddress: number,
  nextVobuOffset?: number,
  { cellNumber = 1, vobId = 1 }: { cellNumber?: number; vobId?: number } = {},
) {
  const navPack = image.subarray(
    absoluteLba * DVD_SECTOR_SIZE_BYTES,
    (absoluteLba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
  navPack.writeUInt32BE(0x0000_01ba, 0);
  navPack.writeUInt32BE(0x0000_01bf, 38);
  navPack.writeUInt16BE(0x03d4, 42);
  navPack[44] = 0;
  navPack.writeUInt32BE(relativeLba, 45);
  navPack.writeUInt32BE(relativeLba + 1, 57);
  navPack.writeUInt32BE(relativeLba + 2, 61);
  navPack.writeUInt32BE(0x0000_01bf, 1_024);
  navPack.writeUInt16BE(0x03fa, 1_028);
  navPack[1_030] = 1;
  navPack.writeUInt32BE(relativeLba, 1_035);
  navPack.writeUInt32BE(vobuEndAddress, 1_039);
  navPack.writeUInt16BE(vobId, 1_055);
  navPack[1_058] = cellNumber;
  navPack.writeUInt32BE(nextVobuOffset ?? 0x3fff_ffff, 1_345);
}

function writeSingleTitleProgramChainCommand(
  image: Buffer,
  command: bigint,
  section: "cell" | "post" | "pre" = "pre",
  targetProgramChainNumber = 1,
) {
  const programChainTableOffset = 360 * DVD_SECTOR_SIZE_BYTES +
    2 * DVD_SECTOR_SIZE_BYTES;
  const programChainStartByte = image.readUInt32BE(
    programChainTableOffset + 8 + (targetProgramChainNumber - 1) * 8 + 4,
  );
  const programChainOffset = programChainTableOffset + programChainStartByte;
  image.writeUInt32BE(
    programChainStartByte + 280,
    programChainTableOffset + 4,
  );
  image.copy(
    image,
    programChainOffset + 252,
    programChainOffset + 236,
    programChainOffset + 265,
  );
  image.writeUInt16BE(236, programChainOffset + 228);
  image.writeUInt16BE(252, programChainOffset + 230);
  image.writeUInt16BE(253, programChainOffset + 232);
  image.writeUInt16BE(277, programChainOffset + 234);
  image.fill(0, programChainOffset + 236, programChainOffset + 244);
  image.writeUInt16BE(
    1,
    programChainOffset + 236 + ["pre", "post", "cell"].indexOf(section) * 2,
  );
  image.writeBigUInt64BE(command, programChainOffset + 244);
  image.copy(
    image,
    370 * DVD_SECTOR_SIZE_BYTES,
    360 * DVD_SECTOR_SIZE_BYTES,
    366 * DVD_SECTOR_SIZE_BYTES,
  );
}

function writeTitleSetMenuCommand(image: Buffer, command: bigint) {
  const ifoOffset = 360 * DVD_SECTOR_SIZE_BYTES;
  image.writeUInt32BE(5, ifoOffset + 0xd0);
  image.writeUInt32BE(0, ifoOffset + 0xd4);
  const unitTable = image.subarray(
    (360 + 5) * DVD_SECTOR_SIZE_BYTES,
    (360 + 6) * DVD_SECTOR_SIZE_BYTES,
  );
  unitTable.fill(0);
  unitTable.writeUInt16BE(1, 0);
  unitTable.writeUInt32BE(283, 4);
  unitTable.write("en", 8, "ascii");
  unitTable.writeUInt32BE(16, 12);
  const programChainTable = unitTable.subarray(16);
  programChainTable.writeUInt16BE(1, 0);
  programChainTable.writeUInt32BE(267, 4);
  programChainTable[8] = 0x82;
  programChainTable.writeUInt32BE(16, 12);
  const programChain = programChainTable.subarray(16);
  programChain.writeUInt16BE(236, 228);
  programChain.writeUInt16BE(1, 236);
  programChain.writeBigUInt64BE(command, 244);
  image.copy(
    image,
    370 * DVD_SECTOR_SIZE_BYTES,
    360 * DVD_SECTOR_SIZE_BYTES,
    366 * DVD_SECTOR_SIZE_BYTES,
  );
}

function writeSyntheticTitleSetAttributeCounts(
  image: Buffer,
  {
    audioStreamCount,
    subpictureStreamCount = 0,
  }: { audioStreamCount: number; subpictureStreamCount?: number },
) {
  for (const managerLba of [330, 347]) {
    const attributesOffset = (managerLba + 5) * DVD_SECTOR_SIZE_BYTES + 12;
    image[attributesOffset + 267] = audioStreamCount;
    image[attributesOffset + 349] = subpictureStreamCount;
  }
}

function udfDescriptorCrcLength(buffer: Buffer, identifier: number): number {
  if ([1, 2, 3, 4, 5, 8, 256].includes(identifier)) {
    return 496;
  }
  if (identifier === 6) {
    return 424 + buffer.readUInt32LE(264);
  }
  if (identifier === 7) {
    return 8 + buffer.readUInt32LE(20) * 8;
  }
  if (identifier === 9) {
    return 64 + buffer.readUInt32LE(72) * 8 + buffer.readUInt32LE(76);
  }
  if (identifier === 257) {
    return buffer.byteLength - 16;
  }
  if (identifier === 261 || identifier === 266) {
    const extendedAttributeLengthOffset = identifier === 261 ? 168 : 208;
    const allocationDescriptorLengthOffset = identifier === 261 ? 172 : 212;
    const descriptorBaseOffset = identifier === 261 ? 176 : 216;
    return descriptorBaseOffset - 16 +
      buffer.readUInt32LE(extendedAttributeLengthOffset) +
      buffer.readUInt32LE(allocationDescriptorLengthOffset);
  }
  if (identifier === 262) {
    return 8;
  }
  throw new Error(`unsupported synthetic UDF descriptor ${identifier}`);
}

function writeUdfTag(
  buffer: Buffer,
  identifier: number,
  location = 0,
  {
    crcLength = udfDescriptorCrcLength(buffer, identifier),
    reserved = 0,
    version = 2,
  }: { crcLength?: number; reserved?: number; version?: number } = {},
) {
  buffer.writeUInt16LE(identifier, 0);
  buffer.writeUInt16LE(version, 2);
  buffer[4] = 0;
  buffer[5] = reserved;
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

function writeLegacyUdfTag(buffer: Buffer, identifier: number) {
  buffer.fill(0, 0, 16);
  buffer.writeUInt16LE(identifier, 0);
  buffer.writeUInt16LE(2, 2);
  buffer.writeUInt16LE(1, 6);
  buffer[4] = buffer.subarray(0, 16).reduce(
    (checksum, byte, index) =>
      index === 4 ? checksum : (checksum + byte) & 0xff,
    0,
  );
}

function writeUdfSectorTag(
  image: Buffer,
  lba: number,
  identifier: number,
  location = lba,
): void {
  writeUdfTag(
    image.subarray(
      lba * DVD_SECTOR_SIZE_BYTES,
      (lba + 1) * DVD_SECTOR_SIZE_BYTES,
    ),
    identifier,
    location,
  );
}

function refreshUdfDirectoryTags(image: Buffer, lba: number): void {
  const directory = image.subarray(
    lba * DVD_SECTOR_SIZE_BYTES,
    (lba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
  let offset = 0;
  while (directory.readUInt16LE(offset) === 257) {
    const recordLength = Math.ceil(
      (38 + directory.readUInt16LE(offset + 36) + directory[offset + 19]!) / 4,
    ) * 4;
    writeUdfTag(
      directory.subarray(offset, offset + recordLength),
      257,
      lba - 300,
    );
    offset += recordLength;
  }
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
  legacySalvage = false,
  name,
}: {
  childLba: number;
  fileCharacteristics: number;
  legacySalvage?: boolean;
  name?: string;
}): Buffer {
  const identifier = name === undefined
    ? Buffer.alloc(0)
    : Buffer.concat([Buffer.from([8]), Buffer.from(name, "ascii")]);
  const recordLength = Math.ceil((38 + identifier.byteLength) / 4) * 4;
  const record = Buffer.alloc(recordLength);
  if (!legacySalvage) {
    record.writeUInt16LE(1, 16);
  }
  record[18] = fileCharacteristics;
  record[19] = identifier.byteLength;
  writeUdfLongAd(record, 20, DVD_SECTOR_SIZE_BYTES, childLba);
  identifier.copy(record, 38);
  if (legacySalvage) {
    writeLegacyUdfTag(record, 257);
  } else {
    writeUdfTag(record, 257);
  }
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
    legacySalvage = false,
  }: {
    allocationByteCount?: number;
    dataLba: number;
    fileEntryLba: number;
    fileType: 4 | 5;
    informationLength: number;
    legacySalvage?: boolean;
  },
) {
  const entry = image.subarray(
    fileEntryLba * DVD_SECTOR_SIZE_BYTES,
    (fileEntryLba + 1) * DVD_SECTOR_SIZE_BYTES,
  );
  if (!legacySalvage) {
    entry.writeUInt16LE(4, 20);
    entry.writeUInt16LE(1, 24);
  }
  entry[27] = fileType;
  entry.writeBigUInt64LE(BigInt(informationLength), 56);
  if (!legacySalvage) {
    entry.writeBigUInt64LE(
      BigInt(Math.ceil(allocationByteCount / DVD_SECTOR_SIZE_BYTES)),
      64,
    );
  }
  entry.writeUInt32LE(0, 168);
  entry.writeUInt32LE(8, 172);
  entry.writeUInt32LE(allocationByteCount, 176);
  entry.writeUInt32LE(dataLba, 180);
  if (legacySalvage) {
    writeLegacyUdfTag(entry, 261);
  } else {
    writeUdfTag(entry, 261, fileEntryLba - 300);
  }
}

function addDvdCopyrightExtendedAttribute(
  fileEntry: Buffer,
  logicalBlockNumber: number,
) {
  const originalAllocationLength = fileEntry.readUInt32LE(172);
  const originalAllocation = Buffer.from(fileEntry.subarray(
    176,
    176 + originalAllocationLength,
  ));
  const extendedAttributeLength = 80;
  fileEntry.fill(0, 176, 176 + extendedAttributeLength);
  const header = fileEntry.subarray(176, 200);
  header.writeUInt32LE(24, 16);
  header.writeUInt32LE(extendedAttributeLength, 20);
  writeUdfTag(header, 262, logicalBlockNumber);
  const attribute = fileEntry.subarray(200, 256);
  attribute.writeUInt32LE(2_048, 0);
  attribute[4] = 1;
  attribute.writeUInt32LE(attribute.byteLength, 8);
  attribute.writeUInt32LE(8, 12);
  attribute.write("*UDF DVD CGMS Info", 17, "ascii");
  attribute.writeUInt16LE(
    attribute.subarray(0, 48).reduce(
      (checksum, byte) => (checksum + byte) & 0xffff,
      0,
    ),
    48,
  );
  fileEntry.writeUInt32LE(extendedAttributeLength, 168);
  fileEntry.writeUInt32LE(originalAllocationLength, 172);
  originalAllocation.copy(fileEntry, 176 + extendedAttributeLength);
  writeUdfTag(fileEntry, 261, logicalBlockNumber);
}

function writeUdfDirectory(
  image: Buffer,
  lba: number,
  records: readonly Buffer[],
  legacySalvage = false,
): number {
  let offset = lba * DVD_SECTOR_SIZE_BYTES;
  const start = offset;
  for (const record of records) {
    if (legacySalvage) {
      writeLegacyUdfTag(record, 257);
    } else {
      writeUdfTag(
        record,
        257,
        lba - 300 + Math.floor((offset - start) / DVD_SECTOR_SIZE_BYTES),
      );
    }
    record.copy(image, offset);
    offset += record.byteLength;
  }
  return offset - start;
}

function writeSyntheticUdfLayout(
  image: Buffer,
  {
    completeNavigation = false,
    extraEmptyDirectoryName,
    legacySalvage = false,
    payloadTitleVobStartLba,
    volumeLastLba,
  }: {
    completeNavigation?: boolean;
    extraEmptyDirectoryName?: string;
    legacySalvage?: boolean;
    payloadTitleVobStartLba?: number;
    volumeLastLba?: number;
  } = {},
) {
  for (const [lba, identifier] of [
    [18, "BEA01"],
    [19, "NSR02"],
    [20, "TEA01"],
  ] as const) {
    image.write(identifier, lba * DVD_SECTOR_SIZE_BYTES + 1, "ascii");
    if (!legacySalvage) {
      image[lba * DVD_SECTOR_SIZE_BYTES + 6] = 1;
    }
  }
  const anchor = image.subarray(
    256 * DVD_SECTOR_SIZE_BYTES,
    257 * DVD_SECTOR_SIZE_BYTES,
  );
  anchor.writeUInt32LE(
    (legacySalvage ? 4 : 16) * DVD_SECTOR_SIZE_BYTES,
    16,
  );
  anchor.writeUInt32LE(257, 20);
  anchor.writeUInt32LE(
    (legacySalvage ? 4 : 16) * DVD_SECTOR_SIZE_BYTES,
    24,
  );
  anchor.writeUInt32LE(273, 28);
  if (legacySalvage) {
    writeLegacyUdfTag(anchor, 2);
  } else {
    writeUdfTag(anchor, 2, 256);
  }

  const primary = image.subarray(
    257 * DVD_SECTOR_SIZE_BYTES,
    258 * DVD_SECTOR_SIZE_BYTES,
  );
  if (legacySalvage) {
    writeLegacyUdfTag(primary, 1);
  } else {
    writeUdfTag(primary, 1, 257);
  }
  const partition = image.subarray(
    258 * DVD_SECTOR_SIZE_BYTES,
    259 * DVD_SECTOR_SIZE_BYTES,
  );
  if (!legacySalvage) {
    partition.writeUInt16LE(1, 20);
  }
  partition.writeUInt16LE(0, 22);
  if (!legacySalvage) {
    partition[24] = 2;
    partition.write("+NSR02", 25, "ascii");
    partition.writeUInt32LE(1, 184);
  }
  partition.writeUInt32LE(300, 188);
  partition.writeUInt32LE(300, 192);
  if (legacySalvage) {
    writeLegacyUdfTag(partition, 5);
  } else {
    writeUdfTag(partition, 5, 258);
  }
  const logicalVolume = image.subarray(
    259 * DVD_SECTOR_SIZE_BYTES,
    260 * DVD_SECTOR_SIZE_BYTES,
  );
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 212);
  if (!legacySalvage) {
    logicalVolume.write("*OSTA UDF Compliant", 217, "ascii");
    logicalVolume.writeUInt16LE(0x0102, 240);
  }
  writeUdfLongAd(logicalVolume, 248, DVD_SECTOR_SIZE_BYTES, 0);
  logicalVolume.writeUInt32LE(6, 264);
  logicalVolume.writeUInt32LE(1, 268);
  logicalVolume.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 432);
  logicalVolume.writeUInt32LE(290, 436);
  logicalVolume[440] = 1;
  logicalVolume[441] = 6;
  logicalVolume.writeUInt16LE(1, 442);
  logicalVolume.writeUInt16LE(0, 444);
  if (legacySalvage) {
    writeLegacyUdfTag(logicalVolume, 6);
  } else {
    writeUdfTag(logicalVolume, 6, 259);
  }
  const integrity = image.subarray(
    290 * DVD_SECTOR_SIZE_BYTES,
    291 * DVD_SECTOR_SIZE_BYTES,
  );
  if (legacySalvage) {
    writeLegacyUdfTag(integrity, 9);
    writeLegacyUdfTag(
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
  } else {
    integrity.writeUInt32LE(1, 28);
    integrity.writeUInt32LE(1, 72);
    integrity.writeUInt32LE(46, 76);
    integrity.writeUInt32LE(0, 80);
    integrity.writeUInt32LE(300, 84);
    integrity.write("*UDF LV Info", 89, "ascii");
    integrity.writeUInt16LE(0x0102, 128);
    integrity.writeUInt16LE(0x0102, 130);
    integrity.writeUInt16LE(0x0260, 132);
    writeUdfTag(integrity, 9, 290);
    writeUdfTag(
      image.subarray(
        260 * DVD_SECTOR_SIZE_BYTES,
        261 * DVD_SECTOR_SIZE_BYTES,
      ),
      7,
      260,
    );
    const implementationUseVolume = image.subarray(
      261 * DVD_SECTOR_SIZE_BYTES,
      262 * DVD_SECTOR_SIZE_BYTES,
    );
    implementationUseVolume.write("*UDF LV Info", 21, "ascii");
    implementationUseVolume.write("OSTA Compressed Unicode", 53, "ascii");
    implementationUseVolume.write("*synthetic", 353, "ascii");
    writeUdfTag(implementationUseVolume, 4, 261);
    writeUdfTag(
      image.subarray(
        262 * DVD_SECTOR_SIZE_BYTES,
        263 * DVD_SECTOR_SIZE_BYTES,
      ),
      8,
      262,
    );
    for (let offset = 0; offset < 16; offset += 1) {
      image.copy(
        image,
        (273 + offset) * DVD_SECTOR_SIZE_BYTES,
        (257 + offset) * DVD_SECTOR_SIZE_BYTES,
        (258 + offset) * DVD_SECTOR_SIZE_BYTES,
      );
    }
    for (let offset = 0; offset < 6; offset += 1) {
      const descriptor = image.subarray(
        (273 + offset) * DVD_SECTOR_SIZE_BYTES,
        (274 + offset) * DVD_SECTOR_SIZE_BYTES,
      );
      writeUdfTag(descriptor, descriptor.readUInt16LE(0), 273 + offset);
    }
  }

  const fileSet = image.subarray(
    300 * DVD_SECTOR_SIZE_BYTES,
    301 * DVD_SECTOR_SIZE_BYTES,
  );
  writeUdfLongAd(fileSet, 400, DVD_SECTOR_SIZE_BYTES, 1);
  if (legacySalvage) {
    writeLegacyUdfTag(fileSet, 256);
  } else {
    fileSet.write("*OSTA UDF Compliant", 417, "ascii");
    fileSet.writeUInt16LE(0x0102, 440);
    writeUdfTag(fileSet, 256);
  }
  const rootDirectoryBytes = writeUdfDirectory(image, 302, [
    udfFileIdentifier({
      childLba: 1,
      fileCharacteristics: 8,
      legacySalvage,
    }),
    udfFileIdentifier({
      childLba: 3,
      fileCharacteristics: 2,
      legacySalvage,
      name: "VIDEO_TS",
    }),
    ...(extraEmptyDirectoryName === undefined
      ? []
      : [udfFileIdentifier({
          childLba: 15,
          fileCharacteristics: 2,
          legacySalvage,
          name: extraEmptyDirectoryName,
        })]),
  ], legacySalvage);
  writeUdfFileEntry(image, {
    dataLba: 2,
    fileEntryLba: 301,
    fileType: 4,
    informationLength: rootDirectoryBytes,
    legacySalvage,
  });
  if (extraEmptyDirectoryName !== undefined) {
    const extraDirectoryBytes = writeUdfDirectory(image, 316, [
      udfFileIdentifier({
        childLba: 1,
        fileCharacteristics: 8,
        legacySalvage,
      }),
    ], legacySalvage);
    writeUdfFileEntry(image, {
      dataLba: 16,
      fileEntryLba: 315,
      fileType: 4,
      informationLength: extraDirectoryBytes,
      legacySalvage,
    });
  }
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
    udfFileIdentifier({
      childLba: 1,
      fileCharacteristics: 8,
      legacySalvage,
    }),
    ...videoDirectoryEntries.map(({ childLba, name }) =>
      udfFileIdentifier({
        childLba,
        fileCharacteristics: 0,
        legacySalvage,
        name,
      })
    ),
  ], legacySalvage);
  writeUdfFileEntry(image, {
    dataLba: 4,
    fileEntryLba: 303,
    fileType: 4,
    informationLength: videoDirectoryBytes,
    legacySalvage,
  });
  if (payloadTitleVobStartLba === undefined) {
    for (let offset = 0; offset < 4; offset += 1) {
      writeUdfFileEntry(image, {
        dataLba: 10 + offset,
        fileEntryLba: 305 + offset,
        fileType: 5,
        informationLength: DVD_SECTOR_SIZE_BYTES,
        legacySalvage,
      });
    }
  } else {
    const controlFiles = completeNavigation
      ? [
          { dataLba: 30, fileEntryLba: 305, sectorCount: 6 },
          { dataLba: 47, fileEntryLba: 306, sectorCount: 6 },
          { dataLba: 38, fileEntryLba: 307, sectorCount: 1 },
          { dataLba: 60, fileEntryLba: 308, sectorCount: 6 },
          { dataLba: 70, fileEntryLba: 309, sectorCount: 6 },
        ]
      : [
          { dataLba: 30, fileEntryLba: 305, sectorCount: 2 },
          { dataLba: 32, fileEntryLba: 306, sectorCount: 1 },
          { dataLba: 33, fileEntryLba: 307, sectorCount: 1 },
          { dataLba: 34, fileEntryLba: 308, sectorCount: 5 },
          { dataLba: 39, fileEntryLba: 309, sectorCount: 1 },
        ];
    for (const file of [
      ...controlFiles,
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
        legacySalvage,
      });
    }
  }
  if (volumeLastLba !== undefined) {
    for (const anchorLba of [volumeLastLba - 256, volumeLastLba]) {
      image.copy(
        image,
        anchorLba * DVD_SECTOR_SIZE_BYTES,
        256 * DVD_SECTOR_SIZE_BYTES,
        257 * DVD_SECTOR_SIZE_BYTES,
      );
      writeUdfTag(
        image.subarray(
          anchorLba * DVD_SECTOR_SIZE_BYTES,
          (anchorLba + 1) * DVD_SECTOR_SIZE_BYTES,
        ),
        2,
        anchorLba,
      );
    }
  }
}

function relocateSyntheticUdfRootDirectory(
  image: Buffer,
  childOffset: number,
) {
  const parent = udfFileIdentifier({ childLba: 1, fileCharacteristics: 8 });
  const child = udfFileIdentifier({
    childLba: 3,
    fileCharacteristics: 2,
    name: "VIDEO_TS",
  });
  const directoryOffset = 500 * DVD_SECTOR_SIZE_BYTES;
  image.fill(0, directoryOffset, directoryOffset + 2 * DVD_SECTOR_SIZE_BYTES);
  writeUdfTag(parent, 257, 200);
  writeUdfTag(
    child,
    257,
    200 + Math.floor(childOffset / DVD_SECTOR_SIZE_BYTES),
  );
  parent.copy(image, directoryOffset);
  child.copy(image, directoryOffset + childOffset);
  const rootFileEntryOffset = 301 * DVD_SECTOR_SIZE_BYTES;
  image.writeBigUInt64LE(BigInt(childOffset + child.byteLength), rootFileEntryOffset + 56);
  image.writeBigUInt64LE(2n, rootFileEntryOffset + 64);
  image.writeUInt32LE(2 * DVD_SECTOR_SIZE_BYTES, rootFileEntryOffset + 176);
  image.writeUInt32LE(200, rootFileEntryOffset + 180);
  writeUdfSectorTag(image, 301, 261, 1);
}

function writeFixture(image: Buffer, badLba?: number) {
  if (badLba !== undefined) {
    image.fill(
      0,
      badLba * DVD_SECTOR_SIZE_BYTES,
      (badLba + 1) * DVD_SECTOR_SIZE_BYTES,
    );
  }
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
    legacySalvage: true,
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
  {
    globalTitles = [{
      parts: [{ pgcNumber: 1, programNumber: 1 }],
      titleSetTitleNumber: 1,
    }],
    programChains = [{
      cells: [{ firstSector: 0, lastSector: 5 }],
      programStartCells: [1],
    }],
  }: {
    globalTitles?: readonly SyntheticGlobalTitle[];
    programChains?: readonly SyntheticProgramChain[];
  } = {},
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
      {
        byteCount: 2 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 22,
        name: "VIDEO_TS.IFO",
      },
      { extentLba: 24, name: "VIDEO_TS.BUP" },
      { extentLba: 25, name: "VIDEO_TS.VOB" },
      {
        byteCount: 5 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 26,
        name: "VTS_01_0.IFO",
      },
      { extentLba: 37, name: "VTS_01_0.BUP" },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 31,
        name: "VTS_01_1.VOB",
      },
    ],
    volumeSpaceSize: 90,
  });
  writeDvdNavigationRelationships(image, {
    globalTitles,
    managerIfoLba: 22,
    managerLastSector: 3,
    managerMenuVobLba: 25,
    programChains,
    titleSetIfoLba: 26,
    titleSetLastSector: 11,
    titleVobLba: 31,
    vobuStartSectors,
  });
  for (const [index, relativeLba] of vobuStartSectors.entries()) {
    const nextRelativeLba = vobuStartSectors
      .slice(index + 1)
      .find((candidate) => candidate > relativeLba);
    writeDvdNavPack(
      image,
      31 + relativeLba,
      relativeLba,
      (nextRelativeLba ?? 6) - relativeLba - 1,
      nextRelativeLba === undefined ? undefined : nextRelativeLba - relativeLba,
      { cellNumber: syntheticCellNumberForSector(programChains, relativeLba) },
    );
  }
  return writeFixture(image, badLba);
}

function syntheticLegacyUdfSalvageImage(): Buffer {
  const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
  writeSyntheticIsoLayout(image, {
    fileStartLba: 310,
    legacySalvage: true,
    pathTableLba: 40,
    rootLba: 42,
    videoDirectoryLba: 43,
    volumeSpaceSize: 600,
  });
  writeSyntheticUdfLayout(image, { legacySalvage: true });
  return image;
}

function createSyntheticUdfDvdImage(badLba: number): {
  imagePath: string;
  sizeBytes: number;
} {
  return writeFixture(syntheticLegacyUdfSalvageImage(), badLba);
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
      {
        byteCount: 2 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 330,
        name: "VIDEO_TS.IFO",
      },
      { extentLba: 332, name: "VIDEO_TS.BUP" },
      { extentLba: 333, name: "VIDEO_TS.VOB" },
      {
        byteCount: 5 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 334,
        name: "VTS_01_0.IFO",
      },
      { extentLba: 339, name: "VTS_01_0.BUP" },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 340,
        name: "VTS_01_1.VOB",
      },
    ],
    volumeSpaceSize: 600,
  });
  writeSyntheticUdfLayout(image, { payloadTitleVobStartLba: 341 });
  writeDvdNavigationRelationships(image, {
    globalTitles: [{
      parts: [{ pgcNumber: 1, programNumber: 1 }],
      titleSetTitleNumber: 1,
    }],
    managerIfoLba: 330,
    managerLastSector: 3,
    managerMenuVobLba: 333,
    programChains: [{
      cells: [{ firstSector: 0, lastSector: 5 }],
      programStartCells: [1],
    }],
    titleSetIfoLba: 334,
    titleSetLastSector: 11,
    titleVobLba: 340,
    vobuStartSectors: [0, 3],
  });
  return writeFixture(image, badLba);
}

function syntheticCompleteDvdImage({
  globalTitles = [{
    parts: [{ pgcNumber: 1, programNumber: 1 }],
    titleSetTitleNumber: 1,
  }],
  includeIso,
  includeUdf,
  programChains = [{
    cells: [{ firstSector: 0, lastSector: 5 }],
    programStartCells: [1],
  }],
  udfExtraEmptyDirectoryName,
  udfTitleVobStartLba = 400,
}: {
  globalTitles?: readonly SyntheticGlobalTitle[];
  includeIso: boolean;
  includeUdf: boolean;
  programChains?: readonly SyntheticProgramChain[];
  udfExtraEmptyDirectoryName?: string;
  udfTitleVobStartLba?: number;
}): Buffer {
  const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
  if (includeIso) {
    writeSyntheticIsoLayout(image, {
      fileStartLba: 330,
      pathTableLba: 40,
      rootLba: 42,
      videoDirectoryLba: 43,
      videoFiles: [
        {
          byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
          extentLba: 330,
          name: "VIDEO_TS.IFO",
        },
        {
          byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
          extentLba: 347,
          name: "VIDEO_TS.BUP",
        },
        { extentLba: 338, name: "VIDEO_TS.VOB" },
        {
          byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
          extentLba: 360,
          name: "VTS_01_0.IFO",
        },
        {
          byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
          extentLba: 370,
          name: "VTS_01_0.BUP",
        },
        {
          byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
          extentLba: 400,
          name: "VTS_01_1.VOB",
        },
      ],
      volumeSpaceSize: 600,
    });
  }
  if (includeUdf) {
    writeSyntheticUdfLayout(image, {
      completeNavigation: true,
      extraEmptyDirectoryName: udfExtraEmptyDirectoryName,
      payloadTitleVobStartLba: udfTitleVobStartLba,
      volumeLastLba: 599,
    });
  }
  writeDvdNavigationRelationships(image, {
    globalTitles,
    includeMenuNavigation: true,
    managerIfoLba: 330,
    managerLastSector: 22,
    managerMenuVobLba: 338,
    programChains,
    titleSetIfoLba: 360,
    titleSetLastSector: 45,
    titleVobLba: 400,
    vobuStartSectors: [0, 3],
  });
  writeDvdNavPack(image, 338, 0, 0);
  for (const titleVobStartLba of new Set([
    includeIso ? 400 : udfTitleVobStartLba,
    includeUdf ? udfTitleVobStartLba : 400,
  ])) {
    writeDvdNavPack(image, titleVobStartLba, 0, 2, 3, {
      cellNumber: syntheticCellNumberForSector(programChains, 0),
    });
    writeDvdNavPack(image, titleVobStartLba + 3, 3, 2, undefined, {
      cellNumber: syntheticCellNumberForSector(programChains, 3),
    });
  }
  image.copy(
    image,
    347 * DVD_SECTOR_SIZE_BYTES,
    330 * DVD_SECTOR_SIZE_BYTES,
    336 * DVD_SECTOR_SIZE_BYTES,
  );
  image.copy(
    image,
    370 * DVD_SECTOR_SIZE_BYTES,
    360 * DVD_SECTOR_SIZE_BYTES,
    366 * DVD_SECTOR_SIZE_BYTES,
  );
  return image;
}

function createSyntheticCompleteDvdImage(options: {
  globalTitles?: readonly SyntheticGlobalTitle[];
  includeIso: boolean;
  includeUdf: boolean;
  programChains?: readonly SyntheticProgramChain[];
  udfExtraEmptyDirectoryName?: string;
  udfTitleVobStartLba?: number;
}): {
  imagePath: string;
  sizeBytes: number;
} {
  return writeFixture(syntheticCompleteDvdImage(options));
}

describe("retained DVD image layout completeness", () => {
  it("accepts an ISO layout whose highest reference is the final retained LBA", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("rejects an ISO volume that crosses the candidate boundary", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 599,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO volume geometry is invalid");
  });

  it("fails closed on a multi-volume ISO descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeBothEndian16(image, 16 * DVD_SECTOR_SIZE_BYTES + 120, 2);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO volume geometry is invalid");
  });

  it("fails closed on a multi-volume ISO directory record", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeBothEndian16(image, 42 * DVD_SECTOR_SIZE_BYTES + 28, 2);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO directory record is unsupported");
  });

  it(
    "fails closed when ISO file and directory names collide by case",
    async () => {
      const image = syntheticCompleteDvdImage({
        includeIso: true,
        includeUdf: false,
      });
      isoDirectoryRecord({
        extentLba: 500,
        identifier: Buffer.from("video_ts;1"),
        isDirectory: false,
      }).copy(image, 42 * DVD_SECTOR_SIZE_BYTES + 110);
      const fixture = writeFixture(image);

      await expect(proveDvdImageLayoutCompleteness({
        candidateBoundaryLba: 600,
        imagePath: fixture.imagePath,
      })).rejects.toThrow("DVD ISO file layout is ambiguous");
    },
  );

  it("rejects an ISO path-table directory outside the volume", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32LE(600, 40 * DVD_SECTOR_SIZE_BYTES + 12);
    image.writeUInt32BE(600, 41 * DVD_SECTOR_SIZE_BYTES + 12);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO path table directory is outside the volume");
  });

  it("fails closed on nonzero ISO directory-sector padding", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[42 * DVD_SECTOR_SIZE_BYTES + 1_000] = 1;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO directory padding is malformed");
  });

  it("fails closed on nonzero ISO directory-identifier padding", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[42 * DVD_SECTOR_SIZE_BYTES + 109] = 1;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO directory record is unsupported");
  });

  it("fails closed on an ISO continuation System Use entry", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const recordOffset = 42 * DVD_SECTOR_SIZE_BYTES + 68;
    image[recordOffset] = 70;
    const continuationOffset = recordOffset + 42;
    image.write("CE", continuationOffset, "ascii");
    image[continuationOffset + 2] = 28;
    image[continuationOffset + 3] = 1;
    writeBothEndian32(image, continuationOffset + 4, 600);
    writeBothEndian32(image, continuationOffset + 12, 0);
    writeBothEndian32(
      image,
      continuationOffset + 20,
      DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO directory record is unsupported");
  });

  it("rejects disagreeing ISO path-table copies", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(44, 41 * DVD_SECTOR_SIZE_BYTES + 12);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO path table copies disagree");
  });

  it("fails closed on nonzero ISO path-table identifier padding", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[40 * DVD_SECTOR_SIZE_BYTES + 9] = 1;
    image[41 * DVD_SECTOR_SIZE_BYTES + 9] = 1;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO path table is malformed");
  });

  it("bounds ISO path-table hierarchy expansion", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const entries = [
      { extentLba: 42, identifier: Buffer.from([0]), parent: 1 },
      ...Array.from({ length: 257 }, (_, index) => ({
        extentLba: 42,
        identifier: Buffer.from("A"),
        parent: index + 1,
      })),
    ];
    const littleEndian = isoPathTable(entries, "little-endian");
    const bigEndian = isoPathTable(entries, "big-endian");
    const primaryVolumeDescriptorOffset = 16 * DVD_SECTOR_SIZE_BYTES;
    writeBothEndian32(
      image,
      primaryVolumeDescriptorOffset + 132,
      littleEndian.byteLength,
    );
    image.writeUInt32LE(40, primaryVolumeDescriptorOffset + 140);
    image.writeUInt32BE(44, primaryVolumeDescriptorOffset + 148);
    littleEndian.copy(image, 40 * DVD_SECTOR_SIZE_BYTES);
    bigEndian.copy(image, 44 * DVD_SECTOR_SIZE_BYTES);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD ISO path table hierarchy exceeds its safety bound",
    );
  });

  it("accepts an agreeing Joliet supplementary filesystem view", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSyntheticJolietView(image, [
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 330,
        name: "VIDEO_TS.IFO",
      },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 347,
        name: "VIDEO_TS.BUP",
      },
      { extentLba: 338, name: "VIDEO_TS.VOB" },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 360,
        name: "VTS_01_0.IFO",
      },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 370,
        name: "VTS_01_0.BUP",
      },
      {
        byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
        extentLba: 400,
        name: "VTS_01_1.VOB",
      },
    ]);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("rejects high-bit corruption in a Joliet escape sequence", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSyntheticJolietView(image, [
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 330, name: "VIDEO_TS.IFO" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 347, name: "VIDEO_TS.BUP" },
      { extentLba: 338, name: "VIDEO_TS.VOB" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 360, name: "VTS_01_0.IFO" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 370, name: "VTS_01_0.BUP" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 400, name: "VTS_01_1.VOB" },
    ]);
    for (let offset = 88; offset < 91; offset += 1) {
      image[17 * DVD_SECTOR_SIZE_BYTES + offset] =
        image[17 * DVD_SECTOR_SIZE_BYTES + offset]! | 0x80;
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO supplementary volume is unsupported");
  });

  it("rejects a Joliet inventory that differs outside VIDEO_TS", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSyntheticJolietView(
      image,
      [
        { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 330, name: "VIDEO_TS.IFO" },
        { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 347, name: "VIDEO_TS.BUP" },
        { extentLba: 338, name: "VIDEO_TS.VOB" },
        { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 360, name: "VTS_01_0.IFO" },
        { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 370, name: "VTS_01_0.BUP" },
        { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 400, name: "VTS_01_1.VOB" },
      ],
      [{ extentLba: 500, name: "README.TXT" }],
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO filesystem views disagree");
  });

  it("rejects a Joliet view with a partial DVD-Video inventory", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSyntheticJolietView(image, [
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 330, name: "VIDEO_TS.IFO" },
      { extentLba: 338, name: "VIDEO_TS.VOB" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 360, name: "VTS_01_0.IFO" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 370, name: "VTS_01_0.BUP" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 400, name: "VTS_01_1.VOB" },
    ]);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD-Video control structures are missing");
  });

  it("rejects a conflicting Joliet supplementary filesystem view", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSyntheticJolietView(image, [
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 331, name: "VIDEO_TS.IFO" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 347, name: "VIDEO_TS.BUP" },
      { extentLba: 338, name: "VIDEO_TS.VOB" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 360, name: "VTS_01_0.IFO" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 370, name: "VTS_01_0.BUP" },
      { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 400, name: "VTS_01_1.VOB" },
    ]);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO file layout is ambiguous");
  });

  it("rejects an ISO identifier that spoofs a nested DVD path", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const rootOffset = 42 * DVD_SECTOR_SIZE_BYTES;
    let offset = 0;
    while (image[rootOffset + offset] !== 0) {
      offset += image[rootOffset + offset]!;
    }
    isoDirectoryRecord({
      extentLba: 500,
      identifier: Buffer.from("VIDEO_TS/VIDEO_TS.IFO;1"),
      isDirectory: false,
    }).copy(image, rootOffset + offset);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO file identifier is malformed");
  });

  it("rejects an ISO parent record that points at the wrong directory", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeBothEndian32(
      image,
      43 * DVD_SECTOR_SIZE_BYTES + 34 + 2,
      44,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO special directory record is malformed");
  });

  it("rejects a zero-byte ISO file whose extended attributes cross the boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const directoryOffset = 43 * DVD_SECTOR_SIZE_BYTES;
    let entryOffset = 0;
    while (image[directoryOffset + entryOffset] !== 0) {
      entryOffset += image[directoryOffset + entryOffset]!;
    }
    isoDirectoryRecord({
      byteCount: 0,
      extendedAttributeSectorCount: 2,
      extentLba: 599,
      identifier: Buffer.from("EMPTY.DAT;1"),
      isDirectory: false,
    }).copy(image, directoryOffset + entryOffset);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO file extent is outside the volume");
  });

  it("rejects duplicate ISO file identifiers with identical extents", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const directoryOffset = 43 * DVD_SECTOR_SIZE_BYTES;
    let entryOffset = 0;
    while (image[directoryOffset + entryOffset] !== 0) {
      entryOffset += image[directoryOffset + entryOffset]!;
    }
    isoDirectoryRecord({
      byteCount: 6 * DVD_SECTOR_SIZE_BYTES,
      extentLba: 330,
      identifier: Buffer.from("VIDEO_TS.IFO;1"),
      isDirectory: false,
    }).copy(image, directoryOffset + entryOffset);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO file layout is ambiguous");
  });

  it.each([
    ["directory flag", 25, 0],
    ["file unit size", 26, 1],
    ["root identifier", 33, 1],
  ])("rejects an ISO root record with an invalid %s", async (_field, offset, value) => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[16 * DVD_SECTOR_SIZE_BYTES + 156 + offset] = value;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO root directory record is invalid");
  });

  it("accepts a complete UDF-only layout", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("fails closed when a UDF descriptor tag names the wrong location", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    writeUdfTag(
      image.subarray(
        256 * DVD_SECTOR_SIZE_BYTES,
        257 * DVD_SECTOR_SIZE_BYTES,
      ),
      2,
      255,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF descriptor tag location is invalid");
  });

  it.each([
    ["descriptor version", { version: 0 }],
    ["reserved byte", { reserved: 1 }],
  ])("fails closed on a malformed UDF tag %s", async (
    _field,
    tagOptions,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    writeUdfTag(
      image.subarray(
        256 * DVD_SECTOR_SIZE_BYTES,
        257 * DVD_SECTOR_SIZE_BYTES,
      ),
      2,
      256,
      tagOptions,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF descriptor tag is malformed");
  });

  it.each([
    ["zero", 0],
    ["shortened", 495],
    ["oversized", 497],
  ])("fails closed on a %s UDF descriptor CRC length", async (
    _lengthKind,
    crcLength,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    writeUdfTag(
      image.subarray(
        256 * DVD_SECTOR_SIZE_BYTES,
        257 * DVD_SECTOR_SIZE_BYTES,
      ),
      2,
      256,
      { crcLength },
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF descriptor CRC length is invalid");
  });

  it("rejects multi-field corruption in an ISO descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: true,
    });
    for (let offset = 1; offset < 6; offset += 1) {
      image[16 * DVD_SECTOR_SIZE_BYTES + offset] =
        image[16 * DVD_SECTOR_SIZE_BYTES + offset]! | 0x80;
    }
    image[16 * DVD_SECTOR_SIZE_BYTES] = 4;
    image[16 * DVD_SECTOR_SIZE_BYTES + 6] = 2;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO volume descriptor signature is malformed");
  });

  it("rejects high-bit corruption in the UDF recognition sequence", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (let offset = 1; offset < 6; offset += 1) {
      image[18 * DVD_SECTOR_SIZE_BYTES + offset] =
        image[18 * DVD_SECTOR_SIZE_BYTES + offset]! | 0x80;
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF recognition sequence is incomplete");
  });

  it("rejects a malformed UDF recognition sequence behind an ISO view", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: true,
    });
    for (const lba of [18, 19, 20]) {
      for (let offset = 1; offset < 6; offset += 1) {
        image[lba * DVD_SECTOR_SIZE_BYTES + offset] =
          image[lba * DVD_SECTOR_SIZE_BYTES + offset]! | 0x80;
      }
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF recognition sequence is incomplete");
  });

  it("rejects a reserve UDF partition that crosses the candidate boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.writeUInt32LE(590, 274 * DVD_SECTOR_SIZE_BYTES + 188);
    image.writeUInt32LE(20, 274 * DVD_SECTOR_SIZE_BYTES + 192);
    writeUdfSectorTag(image, 274, 5);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD filesystem extent is invalid");
  });

  it("rejects aliased UDF main and reserve descriptor sequences", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const anchorLba of [256, 343, 599]) {
      const anchor = image.subarray(
        anchorLba * DVD_SECTOR_SIZE_BYTES,
        (anchorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      anchor.writeUInt32LE(257, 28);
      writeUdfTag(anchor, 2, anchorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF descriptor sequences overlap");
  });

  it("fails closed on UDF volume descriptor continuations", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const [pointerLba, terminatorLba] of [[260, 261], [276, 277]]) {
      const pointer = image.subarray(
        pointerLba * DVD_SECTOR_SIZE_BYTES,
        (pointerLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      pointer.fill(0);
      pointer.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 20);
      pointer.writeUInt32LE(599, 24);
      writeUdfTag(pointer, 3, pointerLba);
      const terminator = image.subarray(
        terminatorLba * DVD_SECTOR_SIZE_BYTES,
        (terminatorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      terminator.fill(0);
      writeUdfTag(terminator, 8, terminatorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF volume descriptor continuation is unsupported",
    );
  });

  it("fails closed when a UDF descriptor sequence omits its primary descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const lba of [257, 273]) {
      const descriptor = image.subarray(
        lba * DVD_SECTOR_SIZE_BYTES,
        (lba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      writeUdfTag(descriptor, 8, lba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF main volume descriptor sequence is incomplete",
    );
  });

  it("fails closed when a UDF descriptor sequence omits its unallocated-space descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const descriptorLba of [260, 276]) {
      const descriptor = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      writeUdfTag(descriptor, 8, descriptorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF main volume descriptor sequence is incomplete",
    );
  });

  it("fails closed when a UDF descriptor sequence omits its implementation-use descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const descriptorLba of [261, 277]) {
      const descriptor = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      writeUdfTag(descriptor, 8, descriptorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF main volume descriptor sequence is incomplete",
    );
  });

  it("fails closed when a UDF descriptor sequence duplicates its unallocated-space descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const [descriptorLba, terminatorLba] of [[261, 262], [277, 278]]) {
      const descriptor = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      writeUdfTag(descriptor, 7, descriptorLba);
      const terminator = image.subarray(
        terminatorLba * DVD_SECTOR_SIZE_BYTES,
        (terminatorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      terminator.fill(0);
      writeUdfTag(terminator, 8, terminatorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF unallocated-space descriptor is duplicated",
    );
  });

  it("fails closed on an unsupported UDF implementation-use descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const [descriptorLba, terminatorLba] of [[260, 261], [276, 277]]) {
      const descriptor = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      descriptor.write("*UNKNOWN", 21, "ascii");
      writeUdfTag(descriptor, 4, descriptorLba);
      const terminator = image.subarray(
        terminatorLba * DVD_SECTOR_SIZE_BYTES,
        (terminatorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      terminator.fill(0);
      writeUdfTag(terminator, 8, terminatorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF implementation-use volume descriptor is unsupported",
    );
  });

  it("fails closed when a UDF unallocated extent crosses the boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const [descriptorLba, terminatorLba] of [[260, 261], [276, 277]]) {
      const descriptor = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      descriptor.writeUInt32LE(1, 20);
      descriptor.writeUInt32LE(2 * DVD_SECTOR_SIZE_BYTES, 24);
      descriptor.writeUInt32LE(599, 28);
      writeUdfTag(descriptor, 7, descriptorLba);
      const terminator = image.subarray(
        terminatorLba * DVD_SECTOR_SIZE_BYTES,
        (terminatorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      terminator.fill(0);
      writeUdfTag(terminator, 8, terminatorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD filesystem extent is invalid");
  });

  it("fails closed on a malformed UDF logical-volume integrity table", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const integrity = image.subarray(
      290 * DVD_SECTOR_SIZE_BYTES,
      291 * DVD_SECTOR_SIZE_BYTES,
    );
    integrity.writeUInt32LE(2, 72);
    writeUdfTag(integrity, 9, 290);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF logical volume integrity is malformed");
  });

  it("fails closed on an open DVD read-only logical volume", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const integrity = image.subarray(
      290 * DVD_SECTOR_SIZE_BYTES,
      291 * DVD_SECTOR_SIZE_BYTES,
    );
    integrity.writeUInt32LE(0, 28);
    writeUdfTag(integrity, 9, 290);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF logical volume integrity is malformed");
  });

  it("fails closed on a multi-volume UDF partition map", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const logicalVolumeLba of [259, 275]) {
      image.writeUInt16LE(
        2,
        logicalVolumeLba * DVD_SECTOR_SIZE_BYTES + 442,
      );
      writeUdfSectorTag(image, logicalVolumeLba, 6);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF partition map type is unsupported");
  });

  it("fails closed on unsupported UDF partition contents", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const partitionLba of [258, 274]) {
      image.write(
        "+NSR03",
        partitionLba * DVD_SECTOR_SIZE_BYTES + 25,
        "ascii",
      );
      writeUdfSectorTag(image, partitionLba, 5);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF partition contents are unsupported");
  });

  it.each([
    ["partition flags", 20, 2, "DVD UDF partition contents are unsupported"],
    [
      "partition contents flags",
      24,
      1,
      "DVD UDF entity identifier is malformed",
    ],
    [
      "partition access type",
      184,
      4,
      "DVD UDF partition contents are unsupported",
    ],
  ])("fails closed on unsupported UDF %s", async (
    _field,
    fieldOffset,
    fieldLength,
    expectedError,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const partitionLba of [258, 274]) {
      image.fill(
        0,
        partitionLba * DVD_SECTOR_SIZE_BYTES + fieldOffset,
        partitionLba * DVD_SECTOR_SIZE_BYTES + fieldOffset + fieldLength,
      );
      writeUdfSectorTag(image, partitionLba, 5);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(expectedError);
  });

  it("fails closed on an unsupported UDF domain identifier", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const logicalVolumeLba of [259, 275]) {
      image.write(
        "X",
        logicalVolumeLba * DVD_SECTOR_SIZE_BYTES + 217,
        "ascii",
      );
      writeUdfSectorTag(image, logicalVolumeLba, 6);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF logical volume is unsupported");
  });

  it("fails closed on an unsupported UDF file set domain", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const fileSet = image.subarray(
      300 * DVD_SECTOR_SIZE_BYTES,
      301 * DVD_SECTOR_SIZE_BYTES,
    );
    fileSet.write("X", 417, "ascii");
    writeUdfTag(fileSet, 256);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF file set descriptor is unsupported");
  });

  it("follows the first next UDF integrity extent", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const logicalVolumeLba of [259, 275]) {
      const logicalVolume = image.subarray(
        logicalVolumeLba * DVD_SECTOR_SIZE_BYTES,
        (logicalVolumeLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      logicalVolume.writeUInt32LE(2 * DVD_SECTOR_SIZE_BYTES, 432);
      writeUdfTag(logicalVolume, 6, logicalVolumeLba);
    }
    const firstIntegrity = image.subarray(
      290 * DVD_SECTOR_SIZE_BYTES,
      291 * DVD_SECTOR_SIZE_BYTES,
    );
    firstIntegrity.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 32);
    firstIntegrity.writeUInt32LE(600, 36);
    writeUdfTag(firstIntegrity, 9, 290);
    const secondIntegrity = image.subarray(
      291 * DVD_SECTOR_SIZE_BYTES,
      292 * DVD_SECTOR_SIZE_BYTES,
    );
    firstIntegrity.copy(secondIntegrity);
    secondIntegrity.writeUInt32LE(0, 32);
    secondIntegrity.writeUInt32LE(0, 36);
    writeUdfTag(secondIntegrity, 9, 291);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD filesystem extent is invalid");
  });

  it("fails closed when a UDF primary-volume extent crosses the boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const descriptorLba of [257, 273]) {
      const primary = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      primary.writeUInt32LE(2 * DVD_SECTOR_SIZE_BYTES, 328);
      primary.writeUInt32LE(599, 332);
      writeUdfTag(primary, 1, descriptorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD filesystem extent is invalid");
  });

  it("fails closed on a UDF predecessor volume descriptor sequence", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const descriptorLba of [257, 273]) {
      const primary = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      primary.writeUInt32LE(600, 484);
      writeUdfTag(primary, 1, descriptorLba);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF predecessor volume descriptor sequence is unsupported",
    );
  });

  it("fails closed when a UDF directory parent points at the wrong ICB", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.writeUInt32LE(2, 302 * DVD_SECTOR_SIZE_BYTES + 24);
    refreshUdfDirectoryTags(image, 302);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF parent directory reference is invalid");
  });

  it.each([
    ["strategy", 20],
    ["parent ICB", 28],
  ])("fails closed on an unsupported UDF ICB %s", async (
    _field,
    fieldOffset,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image[301 * DVD_SECTOR_SIZE_BYTES + fieldOffset] = 1;
    writeUdfSectorTag(image, 301, 261, 1);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF ICB hierarchy is unsupported");
  });

  it("fails closed when distinct UDF names collide after normalization", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.write(
      "video_ts.ifo",
      304 * DVD_SECTOR_SIZE_BYTES + 131,
      "ascii",
    );
    refreshUdfDirectoryTags(image, 304);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF file layout is ambiguous");
  });

  it("accepts UDF directory padding between logical blocks", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    relocateSyntheticUdfRootDirectory(image, DVD_SECTOR_SIZE_BYTES);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("rejects a UDF directory entry that crosses a logical-block boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    relocateSyntheticUdfRootDirectory(image, DVD_SECTOR_SIZE_BYTES - 8);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF directory padding is malformed");
  });

  it("rejects a UDF directory-entry CRC that crosses its record boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const directory = image.subarray(
      302 * DVD_SECTOR_SIZE_BYTES,
      303 * DVD_SECTOR_SIZE_BYTES,
    );
    writeUdfTag(directory, 257, 2, { crcLength: 40 });
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF directory entry length is invalid");
  });

  it("fails closed on an unrecorded UDF file-set descriptor extent", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const logicalVolumeLba of [259, 275]) {
      image.writeUInt32LE(
        0x4000_0000 | DVD_SECTOR_SIZE_BYTES,
        logicalVolumeLba * DVD_SECTOR_SIZE_BYTES + 248,
      );
      writeUdfSectorTag(image, logicalVolumeLba, 6);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF partition address is invalid");
  });

  it("fails closed on a shortened UDF file-set descriptor extent", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const logicalVolumeLba of [259, 275]) {
      image.writeUInt32LE(
        1,
        logicalVolumeLba * DVD_SECTOR_SIZE_BYTES + 248,
      );
      writeUdfSectorTag(image, logicalVolumeLba, 6);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF file set descriptor extent is truncated");
  });

  it.each([
    ["next file-set extent", 448],
    ["system stream directory", 464],
  ])("fails closed on an unsupported UDF %s reference", async (
    _reference,
    descriptorOffset,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image[300 * DVD_SECTOR_SIZE_BYTES + descriptorOffset] = 1;
    writeUdfSectorTag(image, 300, 256, 0);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF file set descriptor references are unsupported",
    );
  });

  it.each([
    ["file-entry extended attributes", 261, 112],
    ["extended-file-entry extended attributes", 266, 136],
    ["extended-file-entry stream directory", 266, 152],
  ])("fails closed on unsupported UDF %s references", async (
    _reference,
    identifier,
    referenceOffset,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const fileEntry = image.subarray(
      301 * DVD_SECTOR_SIZE_BYTES,
      302 * DVD_SECTOR_SIZE_BYTES,
    );
    fileEntry[referenceOffset] = 1;
    writeUdfTag(fileEntry, identifier, 1);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF file entry references are unsupported");
  });

  it("fails closed on UDF extended allocation descriptors", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const rootFileEntryOffset = 301 * DVD_SECTOR_SIZE_BYTES;
    image.writeUInt16LE(
      image.readUInt16LE(rootFileEntryOffset + 34) | 2,
      rootFileEntryOffset + 34,
    );
    writeUdfSectorTag(image, 301, 261, 1);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF allocation descriptors are unsupported");
  });

  it("fails closed when UDF logical-block accounting disagrees", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.writeBigUInt64LE(2n, 301 * DVD_SECTOR_SIZE_BYTES + 64);
    writeUdfSectorTag(image, 301, 261, 1);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF file allocation accounting is malformed");
  });

  it("fails closed before an oversized UDF file entry can exhaust allocation work", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const descriptorCount = 50_001;
    const allocationDescriptorLength = descriptorCount * 8;
    const fileEntryByteCount = Math.ceil(
      (176 + allocationDescriptorLength) / DVD_SECTOR_SIZE_BYTES,
    ) * DVD_SECTOR_SIZE_BYTES;
    const fileEntry = image.subarray(
      350 * DVD_SECTOR_SIZE_BYTES,
      350 * DVD_SECTOR_SIZE_BYTES + fileEntryByteCount,
    );
    fileEntry.fill(0);
    fileEntry.writeUInt16LE(4, 20);
    fileEntry.writeUInt16LE(1, 24);
    fileEntry[27] = 4;
    fileEntry.writeUInt32LE(allocationDescriptorLength, 172);
    writeUdfTag(fileEntry, 261, 50, { crcLength: 0 });
    writeUdfLongAd(
      image,
      300 * DVD_SECTOR_SIZE_BYTES + 400,
      fileEntryByteCount,
      50,
    );
    writeUdfSectorTag(image, 300, 256, 0);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF descriptor CRC length is invalid");
  });

  it("accepts a well-formed DVD copyright extended attribute", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    addDvdCopyrightExtendedAttribute(
      image.subarray(
        301 * DVD_SECTOR_SIZE_BYTES,
        302 * DVD_SECTOR_SIZE_BYTES,
      ),
      1,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("fails closed on a malformed inline UDF extended attribute", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const rootFileEntry = image.subarray(
      301 * DVD_SECTOR_SIZE_BYTES,
      302 * DVD_SECTOR_SIZE_BYTES,
    );
    addDvdCopyrightExtendedAttribute(rootFileEntry, 1);
    rootFileEntry.writeUInt32LE(55, 200 + 8);
    writeUdfTag(rootFileEntry, 261, 1);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF inline extended attribute is malformed");
  });

  it("bounds UDF volume descriptor sequence reads", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const anchorLba of [256, 343, 599]) {
      image.writeUInt32LE(
        257 * DVD_SECTOR_SIZE_BYTES,
        anchorLba * DVD_SECTOR_SIZE_BYTES + 16,
      );
      writeUdfSectorTag(image, anchorLba, 2);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF volume descriptor sequence exceeds its safety bound",
    );
  });

  it("bounds UDF integrity sequence reads", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const logicalVolumeLba of [259, 275]) {
      image.writeUInt32LE(
        257 * DVD_SECTOR_SIZE_BYTES,
        logicalVolumeLba * DVD_SECTOR_SIZE_BYTES + 432,
      );
      writeUdfSectorTag(image, logicalVolumeLba, 6);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF integrity sequence exceeds its safety bound",
    );
  });

  it("fails closed on a DVD read-only UDF partition space table", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const partitionLba of [258, 274]) {
      image.writeUInt32LE(
        DVD_SECTOR_SIZE_BYTES,
        partitionLba * DVD_SECTOR_SIZE_BYTES + 56,
      );
      image.writeUInt32LE(
        150,
        partitionLba * DVD_SECTOR_SIZE_BYTES + 60,
      );
      writeUdfSectorTag(image, partitionLba, 5);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF partition metadata extent is unsupported",
    );
  });

  it("rejects UDF unallocated space that overlaps a partition", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const descriptorLba of [260, 276]) {
      const descriptor = image.subarray(
        descriptorLba * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
      descriptor.fill(0);
      descriptor.writeUInt32LE(1, 20);
      descriptor.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 24);
      descriptor.writeUInt32LE(400, 28);
      writeUdfTag(descriptor, 7, descriptorLba);
      const terminator = image.subarray(
        (descriptorLba + 2) * DVD_SECTOR_SIZE_BYTES,
        (descriptorLba + 3) * DVD_SECTOR_SIZE_BYTES,
      );
      terminator.fill(0);
      writeUdfTag(terminator, 8, descriptorLba + 2);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD UDF unallocated space overlaps allocated layout",
    );
  });

  it("accepts agreeing ISO and UDF views", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: true,
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("rejects ISO and UDF views with different empty directories", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: true,
      udfExtraEmptyDirectoryName: "EXTRA",
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD filesystem views disagree");
  });

  it("rejects conflicting ISO and UDF DVD-Video layouts", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: true,
      udfTitleVobStartLba: 401,
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD title-set extent fields are malformed");
  });

  it("fails closed when a DVD-Video backup differs from its IFO", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[347 * DVD_SECTOR_SIZE_BYTES + 512] ^= 0xff;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD-Video backup does not match its IFO");
  });

  it("fails closed on malformed menu program-chain navigation", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const lastSectorOffset = 330 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 16 + 237 + 20;
    image.writeUInt32BE(1, lastSectorOffset);
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain cell table is malformed");
  });

  it("fails closed on a video-manager extent beyond its files", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(600, 330 * DVD_SECTOR_SIZE_BYTES + 0x0c);
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD video manager extent fields are malformed");
  });

  it.each([
    ["parental management", 0xcc],
    ["title-set attribute", 0xd0],
    ["text data manager", 0xd4],
  ])("fails closed on a %s table outside the video manager", async (
    description,
    pointerOffset,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    for (const managerLba of [330, 347]) {
      image.writeUInt32BE(
        270,
        managerLba * DVD_SECTOR_SIZE_BYTES + pointerOffset,
      );
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(`DVD ${description} table is outside the video manager`);
  });

  it("fails closed when top-level video-manager tables overlap", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      DVD_SECTOR_SIZE_BYTES,
      332 * DVD_SECTOR_SIZE_BYTES + 4,
    );
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD manager tables overlap ambiguously");
  });

  it("fails closed when first-play navigation overlaps the manager table", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    for (const managerLba of [330, 347]) {
      image.writeUInt32BE(
        0x1ff,
        managerLba * DVD_SECTOR_SIZE_BYTES + 0x84,
      );
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD manager tables overlap ambiguously");
  });

  it("fails closed when a sector table overlaps the manager table", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    for (const managerLba of [330, 347]) {
      image.writeUInt32BE(
        DVD_SECTOR_SIZE_BYTES,
        managerLba * DVD_SECTOR_SIZE_BYTES + 0x80,
      );
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD manager tables overlap ambiguously");
  });

  it("accepts a padded 0x308-byte title-set attribute entry", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    for (const managerLba of [330, 347]) {
      const tableOffset = (managerLba + 5) * DVD_SECTOR_SIZE_BYTES;
      image.writeUInt32BE(787, tableOffset + 4);
      image.writeUInt32BE(775, tableOffset + 12);
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("fails closed when title-set attributes disagree with the manager inventory", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    for (const managerLba of [330, 347]) {
      image.writeUInt16BE(
        2,
        (managerLba + 5) * DVD_SECTOR_SIZE_BYTES,
      );
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD title-set attribute table is malformed");
  });

  it("fails closed on a title-set sector outside its filesystem extent", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      599,
      330 * DVD_SECTOR_SIZE_BYTES + DVD_SECTOR_SIZE_BYTES + 16,
    );
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD title search table is malformed");
  });

  it("fails closed on a title-set last sector beyond its files", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(600, 360 * DVD_SECTOR_SIZE_BYTES + 0x0c);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD title-set extent fields are malformed");
  });

  it("fails closed on a backward VOBU reference before the VOB", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      100,
      400 * DVD_SECTOR_SIZE_BYTES + DVD_NAV_DSI_PAYLOAD_OFFSET + 318,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB navigation reference is invalid");
  });

  it("fails closed on an invalid menu-button VM target", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const highlightOffset = 338 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_PCI_PAYLOAD_OFFSET + 96;
    image.writeUInt16BE(1, highlightOffset);
    image.writeUInt16BE(0x1000, highlightOffset + 14);
    image[highlightOffset + 17] = 1;
    image[highlightOffset + 18] = 1;
    const buttonOffset = highlightOffset + 46;
    image.writeBigUInt64BE(
      1n << 61n | 4n << 48n | 2n,
      buttonOffset + 10,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM link command target is invalid");
  });

  it("fails closed on a malformed menu command table", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const commandTablePointerOffset = 330 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 16 + 228;
    image.writeUInt16BE(236, commandTablePointerOffset);
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain command table is malformed");
  });

  it("fails closed on a malformed first-play program chain", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(1, 330 * DVD_SECTOR_SIZE_BYTES + 0x84);
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD menu program chain table is malformed");
  });

  it("fails closed on a malformed title cell-address table", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      6,
      360 * DVD_SECTOR_SIZE_BYTES + 4 * DVD_SECTOR_SIZE_BYTES + 16,
    );
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD title cell address table is malformed");
  });

  it("fails closed on a title time-map entry beyond the title VOB", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      6,
      360 * DVD_SECTOR_SIZE_BYTES + 5 * DVD_SECTOR_SIZE_BYTES + 16,
    );
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD title time map entry is invalid");
  });

  it("fails closed on an invalid menu command target", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const programChainOffset = 330 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 16;
    image.writeUInt32BE(
      312,
      330 * DVD_SECTOR_SIZE_BYTES + 2 * DVD_SECTOR_SIZE_BYTES + 4,
    );
    image.writeUInt32BE(
      296,
      330 * DVD_SECTOR_SIZE_BYTES + 2 * DVD_SECTOR_SIZE_BYTES + 16 + 4,
    );
    image.copy(
      image,
      programChainOffset + 252,
      programChainOffset + 236,
      programChainOffset + 265,
    );
    image.writeUInt16BE(236, programChainOffset + 228);
    image.writeUInt16BE(252, programChainOffset + 230);
    image.writeUInt16BE(253, programChainOffset + 232);
    image.writeUInt16BE(277, programChainOffset + 234);
    image.writeUInt16BE(1, programChainOffset + 236);
    image.fill(0, programChainOffset + 238, programChainOffset + 244);
    image.writeBigUInt64BE(
      1n << 61n | 4n << 48n | 2n,
      programChainOffset + 244,
    );
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM link command target is invalid");
  });

  it("fails closed on a reserved VM system-set operation", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(image, 2n << 61n | 4n << 56n);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM system-set command is unsupported");
  });

  it("fails closed when SetSTN selects an absent audio stream", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[360 * DVD_SECTOR_SIZE_BYTES + 0x203] = 1;
    writeSyntheticTitleSetAttributeCounts(image, { audioStreamCount: 1 });
    writeSingleTitleProgramChainCommand(
      image,
      2n << 61n | 1n << 60n | 1n << 56n | 1n << 39n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM audio stream target is invalid");
  });

  it("accepts SetSTN targets enabled by the current PGC", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const programChainOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16;
    image[360 * DVD_SECTOR_SIZE_BYTES + 0x203] = 1;
    image[360 * DVD_SECTOR_SIZE_BYTES + 0x255] = 1;
    writeSyntheticTitleSetAttributeCounts(image, {
      audioStreamCount: 1,
      subpictureStreamCount: 1,
    });
    image.writeUInt16BE(0x8000, programChainOffset + 12);
    image.writeUInt32BE(0x8000_0000, programChainOffset + 28);
    writeSingleTitleProgramChainCommand(
      image,
      2n << 61n | 1n << 60n | 1n << 56n |
        1n << 39n | 1n << 31n | 64n << 24n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("fails closed when PGC controls enable an undeclared stream", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const programChainOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16;
    image[360 * DVD_SECTOR_SIZE_BYTES + 0x203] = 1;
    writeSyntheticTitleSetAttributeCounts(image, { audioStreamCount: 1 });
    image.writeUInt16BE(0x8000, programChainOffset + 14);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain stream controls are malformed");
  });

  it("fails closed when SetNVTMR targets an absent program chain", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(
      image,
      2n << 61n | 1n << 60n | 2n << 56n | 1n << 32n | 2n << 16n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM navigation timer target is invalid");
  });

  it("validates the complete 15-bit SetNVTMR program-chain target", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(
      image,
      2n << 61n | 1n << 60n | 2n << 56n | 1n << 32n | 257n << 16n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM navigation timer target is invalid");
  });

  it.each([3n, 4n, 5n, 6n])(
    "fails closed on a reserved class-%s VM set operation",
    async (commandClass) => {
      const image = syntheticCompleteDvdImage({
        includeIso: true,
        includeUdf: false,
      });
      writeSingleTitleProgramChainCommand(
        image,
        commandClass << 61n | 12n << 56n,
      );
      const fixture = writeFixture(image);

      await expect(proveDvdImageLayoutCompleteness({
        candidateBoundaryLba: 600,
        imagePath: fixture.imagePath,
      })).rejects.toThrow("DVD VM set command is unsupported");
    },
  );

  it.each(
    [1n, 4n, 5n, 6n].flatMap((commandClass) =>
      [4n, 8n, 14n, 15n, 32n].map((linkSubOperation) => [
        commandClass,
        linkSubOperation,
      ] as const)
    ),
  )(
    "fails closed on reserved class-%s VM LinkSub operation %s",
    async (commandClass, linkSubOperation) => {
      const image = syntheticCompleteDvdImage({
        includeIso: true,
        includeUdf: false,
      });
      const command = commandClass === 1n
        ? commandClass << 61n | 1n << 48n | linkSubOperation
        : commandClass << 61n | linkSubOperation;
      writeSingleTitleProgramChainCommand(image, command);
      const fixture = writeFixture(image);

      await expect(proveDvdImageLayoutCompleteness({
        candidateBoundaryLba: 600,
        imagePath: fixture.imagePath,
      })).rejects.toThrow("DVD VM link command target is invalid");
    },
  );

  it("fails closed on an out-of-range PGC adjacency reference", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt16BE(
      2,
      360 * DVD_SECTOR_SIZE_BYTES + 2 * DVD_SECTOR_SIZE_BYTES + 16 + 156,
    );
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain reference is invalid");
  });

  it("fails closed on an out-of-range part-of-title PGC", async () => {
    const fixture = createSyntheticCompleteDvdImage({
      globalTitles: [{
        parts: [{ pgcNumber: 2, programNumber: 1 }],
        titleSetTitleNumber: 1,
      }],
      includeIso: true,
      includeUdf: false,
    });

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD part-of-title table is malformed");
  });

  it("fails closed on a JumpTT command in the title domain", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(
      image,
      1n << 61n | 1n << 60n | 2n << 48n | 1n << 16n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM jump command is illegal in this domain");
  });

  it("fails closed on Goto in a PGC cell-command section", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(image, 1n << 48n | 1n, "cell");
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM special command target is invalid");
  });

  it("fails closed when a cell selects an absent cell command", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(image, 0n, "cell");
    const cellPlaybackOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 253;
    image[cellPlaybackOffset + 3] = 2;
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain cell table is malformed");
  });

  it("fails closed when VMGI declares the wrong title-set count", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt16BE(0, 330 * DVD_SECTOR_SIZE_BYTES + 0x3e);
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD video manager title-set count is malformed");
  });

  it("fails closed when filesystem structures partially overlap", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeBothEndian32(
      image,
      16 * DVD_SECTOR_SIZE_BYTES + 156 + 10,
      2 * DVD_SECTOR_SIZE_BYTES,
    );
    writeBothEndian32(
      image,
      42 * DVD_SECTOR_SIZE_BYTES + 10,
      2 * DVD_SECTOR_SIZE_BYTES,
    );
    writeBothEndian32(
      image,
      42 * DVD_SECTOR_SIZE_BYTES + 34 + 10,
      2 * DVD_SECTOR_SIZE_BYTES,
    );
    writeBothEndian32(
      image,
      43 * DVD_SECTOR_SIZE_BYTES + 34 + 10,
      2 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO special directory record is malformed");
  });

  it("fails closed when a title command targets a missing VMGM PGC", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(
      image,
      1n << 61n | 1n << 60n | 8n << 48n | 2n << 32n | 3n << 22n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM program chain target is invalid");
  });

  it("fails closed when a command targets an absent menu entry", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeSingleTitleProgramChainCommand(
      image,
      1n << 61n | 1n << 60n | 8n << 48n | 1n << 22n | 2n << 16n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VM menu command target is invalid");
  });

  it("accepts a command targeting a present menu entry", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[
      330 * DVD_SECTOR_SIZE_BYTES + 2 * DVD_SECTOR_SIZE_BYTES + 24
    ] = 0x82;
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    writeSingleTitleProgramChainCommand(
      image,
      1n << 61n | 1n << 60n | 8n << 48n | 1n << 22n | 2n << 16n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it("accepts JumpSS VTSM zero as the current title set", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    writeTitleSetMenuCommand(
      image,
      1n << 61n | 1n << 60n | 6n << 48n | 1n << 32n |
        2n << 22n | 2n << 16n,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
  });

  it.each([
    ["LinkPTT", 1n << 61n | 5n << 48n | 2n],
    [
      "SetSTN angle",
      2n << 61n | 1n << 60n | 1n << 56n | 1n << 23n | 2n << 16n,
    ],
  ])("validates %s against every title that can execute its PGC", async (
    _description,
    command,
  ) => {
    const image = syntheticCompleteDvdImage({
      globalTitles: [
        {
          parts: [{ pgcNumber: 2, programNumber: 1 }],
          titleSetTitleNumber: 1,
        },
        {
          angleCount: 2,
          parts: [
            { pgcNumber: 1, programNumber: 1 },
            { pgcNumber: 1, programNumber: 2 },
          ],
          titleSetTitleNumber: 2,
        },
      ],
      includeIso: true,
      includeUdf: false,
      programChains: [
        {
          cells: [
            {
              blockMode: 1,
              blockType: 1,
              firstSector: 0,
              lastSector: 2,
            },
            {
              blockMode: 3,
              blockType: 1,
              firstSector: 3,
              lastSector: 5,
            },
          ],
          programStartCells: [1, 2],
        },
        {
          cells: [{ firstSector: 0, lastSector: 2 }],
          programStartCells: [1],
        },
      ],
    });
    writeSingleTitleProgramChainCommand(image, command, "pre", 2);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(/DVD VM (link command|angle) target is invalid/);
  });

  it("fails closed on a malformed title VOB navigation pack", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[400 * DVD_SECTOR_SIZE_BYTES] = 0xff;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB navigation pack is malformed");
  });

  it("fails closed when a VOB navigation pack identifies the wrong cell", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt16BE(2, 400 * DVD_SECTOR_SIZE_BYTES + 1_055);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB navigation cell identity is invalid");
  });

  it(
    "fails closed when VOBU navigation leaves an unmapped sector gap",
    async () => {
      const image = syntheticCompleteDvdImage({
        includeIso: true,
        includeUdf: false,
      });
      image.writeUInt32BE(
        1,
        400 * DVD_SECTOR_SIZE_BYTES + DVD_NAV_DSI_PAYLOAD_OFFSET + 8,
      );
      const fixture = writeFixture(image);

      await expect(proveDvdImageLayoutCompleteness({
        candidateBoundaryLba: 600,
        imagePath: fixture.imagePath,
      })).rejects.toThrow("DVD VOB navigation data is malformed");
    },
  );

  it("fails closed when a VOBU crosses its cell boundary", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
      programChains: [{
        cells: [
          { firstSector: 0, lastSector: 0 },
          { firstSector: 3, lastSector: 5 },
        ],
        programStartCells: [1],
      }],
    });
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB navigation cell identity is invalid");
  });

  it("fails closed when a non-ILVU VOBU references another ILVU", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const dsiOffset = 400 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    image.writeUInt32BE(3, dsiOffset + 38);
    image.writeUInt16BE(1, dsiOffset + 42);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB interleaved-unit reference is malformed");
  });

  it("fails closed when a PREU pack declares an ILVU extent", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const dsiOffset = 400 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    image.writeUInt16BE(0xb000, dsiOffset + 32);
    image.writeUInt32BE(2, dsiOffset + 34);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB interleaved-unit reference is malformed");
  });

  it("fails closed when an ILVU reference targets a PREU pack", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const firstDsiOffset = 400 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    image.writeUInt16BE(0x7000, firstDsiOffset + 32);
    image.writeUInt32BE(2, firstDsiOffset + 34);
    image.writeUInt32BE(3, firstDsiOffset + 38);
    image.writeUInt16BE(1, firstDsiOffset + 42);
    const secondDsiOffset = 403 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    image.writeUInt16BE(0xb000, secondDsiOffset + 32);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB interleaved-unit size is malformed");
  });

  it("fails closed when a next-ILVU address points backward", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const dsiOffset = 400 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    image.writeUInt16BE(0x7000, dsiOffset + 32);
    image.writeUInt32BE(2, dsiOffset + 34);
    image.writeUInt32BE(0x8000_0003, dsiOffset + 38);
    image.writeUInt16BE(1, dsiOffset + 42);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB interleaved-unit reference is malformed");
  });

  it("reconciles the PGC first-ILVU end with DSI navigation", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
      programChains: [{
        cells: [
          { firstSector: 0, lastSector: 2 },
          { firstSector: 3, lastSector: 5 },
        ],
        programStartCells: [1],
      }],
    });
    const playbackOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 237;
    image[playbackOffset] = image[playbackOffset]! | 0x04;
    image.writeUInt32BE(1, playbackOffset + 12);
    const dsiOffset = 400 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    image.writeUInt16BE(0x7000, dsiOffset + 32);
    image.writeUInt32BE(2, dsiOffset + 34);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain VOBU relationships are malformed");
  });

  it.each([
    ["interleaved-unit", 38, 42],
    ["seamless angle", 180, 184],
  ])("fails closed when a %s size disagrees with its target", async (
    description,
    addressOffset,
    sizeOffset,
  ) => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const dsiOffset = 400 * DVD_SECTOR_SIZE_BYTES +
      DVD_NAV_DSI_PAYLOAD_OFFSET;
    if (description === "interleaved-unit") {
      image.writeUInt16BE(0x7000, dsiOffset + 32);
    }
    image.writeUInt32BE(3, dsiOffset + addressOffset);
    image.writeUInt16BE(2, dsiOffset + sizeOffset);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(`DVD VOB ${description} size is malformed`);
  });

  it("fails closed when the filesystem contains an orphan title set", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const directoryOffset = 43 * DVD_SECTOR_SIZE_BYTES;
    let offset = 0;
    while (image[directoryOffset + offset] !== 0) {
      offset += image[directoryOffset + offset]!;
    }
    isoDirectoryRecord({
      extentLba: 500,
      identifier: Buffer.from("VTS_02_0.IFO;1"),
      isDirectory: false,
    }).copy(image, directoryOffset + offset);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD title-set file inventory disagrees with its titles",
    );
  });

  it("fails closed on a title VOB navigation reference beyond the VOB", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      7,
      400 * DVD_SECTOR_SIZE_BYTES + 1_345,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB navigation reference is invalid");
  });

  it("fails closed when a PGC references an absent VOBU", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      4,
      360 * DVD_SECTOR_SIZE_BYTES + 3 * DVD_SECTOR_SIZE_BYTES + 8,
    );
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD VOB navigation reference is invalid");
  });

  it("fails closed when a PGC misidentifies its final VOBU", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const lastVobuStartOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 237 + 16;
    image.writeUInt32BE(0, lastVobuStartOffset);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain VOBU relationships are malformed");
  });

  it("fails closed when a cell ILVU reference exceeds its VOB", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const playbackOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 237;
    image[playbackOffset] = image[playbackOffset]! | 0x04;
    image.writeUInt32BE(6, playbackOffset + 12);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain cell table is malformed");
  });

  it("fails closed when a PGC begins inside its search-pointer array", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const titlePgcitOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES;
    image.writeUInt32BE(8, titlePgcitOffset + 12);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain table is ambiguous");
  });

  it("fails closed when program-chain bodies overlap", async () => {
    const chain = {
      cells: [{ firstSector: 0, lastSector: 5 }],
      programStartCells: [1],
    } as const;
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
      programChains: [chain, chain],
    });
    const titlePgcitOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES;
    const firstPgcStart = image.readUInt32BE(titlePgcitOffset + 12);
    image.writeUInt32BE(firstPgcStart + 200, titlePgcitOffset + 20);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD program chain table is malformed");
  });

  it("fails closed when menu language-unit program-chain tables overlap", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const tableOffset = 332 * DVD_SECTOR_SIZE_BYTES;
    const originalPgcit = Buffer.from(image.subarray(
      tableOffset + 16,
      tableOffset + 297,
    ));
    image.fill(0, tableOffset, tableOffset + 586);
    image.writeUInt16BE(2, tableOffset);
    image.writeUInt32BE(585, tableOffset + 4);
    image.write("en", tableOffset + 8, "ascii");
    image[tableOffset + 11] = 1;
    image.writeUInt32BE(24, tableOffset + 12);
    image.write("fr", tableOffset + 16, "ascii");
    image[tableOffset + 19] = 1;
    image.writeUInt32BE(305, tableOffset + 20);
    originalPgcit.copy(image, tableOffset + 24);
    image.writeUInt32BE(399, tableOffset + 28);
    originalPgcit.copy(image, tableOffset + 305);
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow(
      "DVD menu program chain tables overlap ambiguously",
    );
  });

  it("fails closed on a malformed menu VOBU address map", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image.writeUInt32BE(
      1,
      330 * DVD_SECTOR_SIZE_BYTES + 3 * DVD_SECTOR_SIZE_BYTES + 4,
    );
    image.copy(
      image,
      347 * DVD_SECTOR_SIZE_BYTES,
      330 * DVD_SECTOR_SIZE_BYTES,
      336 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD menu VOBU address map is malformed");
  });

  it("fails closed when no supported filesystem view is present", async () => {
    const fixture = writeFixture(Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES));

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD image has no supported filesystem view");
  });

  it("fails closed on a malformed ISO descriptor sequence", async () => {
    const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
    writeSyntheticIsoLayout(image, {
      fileStartLba: 330,
      pathTableLba: 40,
      rootLba: 42,
      videoDirectoryLba: 43,
      volumeSpaceSize: 600,
    });
    image.fill(0, 17 * DVD_SECTOR_SIZE_BYTES, 18 * DVD_SECTOR_SIZE_BYTES);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO volume descriptor sequence is malformed");
  });

  it("fails closed on a recognizable ISO descriptor with an invalid version", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    const descriptor = image.subarray(
      16 * DVD_SECTOR_SIZE_BYTES,
      17 * DVD_SECTOR_SIZE_BYTES,
    );
    descriptor[0] = 1;
    descriptor.write("CD001", 1, "ascii");
    descriptor[6] = 2;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO volume descriptor sequence is malformed");
  });

  it("fails closed on a reserved ISO volume descriptor type", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    image[17 * DVD_SECTOR_SIZE_BYTES] = 4;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO volume layout is unsupported");
  });

  it("fails closed on partially overlapping file extents", async () => {
    const image = Buffer.alloc(700 * DVD_SECTOR_SIZE_BYTES);
    writeSyntheticIsoLayout(image, {
      fileStartLba: 330,
      pathTableLba: 40,
      rootLba: 42,
      videoDirectoryLba: 43,
      videoFiles: [
        {
          byteCount: 2 * DVD_SECTOR_SIZE_BYTES,
          extentLba: 330,
          name: "VIDEO_TS.IFO",
        },
        { extentLba: 331, name: "VIDEO_TS.BUP" },
      ],
      volumeSpaceSize: 600,
    });
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO file extents overlap ambiguously");
  });

  it("fails closed when an ISO file lies outside its declared volume", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const existingVideoDirectoryRecords = [
      isoDirectoryRecord({
        extentLba: 43,
        identifier: Buffer.from([0]),
        isDirectory: true,
      }),
      isoDirectoryRecord({
        extentLba: 42,
        identifier: Buffer.from([1]),
        isDirectory: true,
      }),
      ...[
        { byteCount: 2 * DVD_SECTOR_SIZE_BYTES, extentLba: 330, name: "VIDEO_TS.IFO" },
        { byteCount: DVD_SECTOR_SIZE_BYTES, extentLba: 332, name: "VIDEO_TS.BUP" },
        { byteCount: DVD_SECTOR_SIZE_BYTES, extentLba: 333, name: "VIDEO_TS.VOB" },
        { byteCount: 4 * DVD_SECTOR_SIZE_BYTES, extentLba: 334, name: "VTS_01_0.IFO" },
        { byteCount: DVD_SECTOR_SIZE_BYTES, extentLba: 338, name: "VTS_01_0.BUP" },
        { byteCount: 6 * DVD_SECTOR_SIZE_BYTES, extentLba: 400, name: "VTS_01_1.VOB" },
      ].map((file) =>
        isoDirectoryRecord({
          byteCount: file.byteCount,
          extentLba: file.extentLba,
          identifier: Buffer.from(`${file.name};1`),
          isDirectory: false,
        })
      ),
    ];
    isoDirectoryRecord({
      extentLba: 600,
      identifier: Buffer.from("OUTSIDE.BIN;1"),
      isDirectory: false,
    }).copy(
      image,
      43 * DVD_SECTOR_SIZE_BYTES + existingVideoDirectoryRecords.reduce(
        (total, record) => total + record.byteLength,
        0,
      ),
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 650,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO file extent is outside the volume");
  });

  it("fails closed on a cyclic ISO directory graph", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const rootRecords = [
      isoDirectoryRecord({
        extentLba: 42,
        identifier: Buffer.from([0]),
        isDirectory: true,
      }),
      isoDirectoryRecord({
        extentLba: 42,
        identifier: Buffer.from([1]),
        isDirectory: true,
      }),
      isoDirectoryRecord({
        extentLba: 43,
        identifier: Buffer.from("VIDEO_TS"),
        isDirectory: true,
      }),
    ];
    isoDirectoryRecord({
      extentLba: 42,
      identifier: Buffer.from("LOOP"),
      isDirectory: true,
    }).copy(
      image,
      42 * DVD_SECTOR_SIZE_BYTES + rootRecords.reduce(
        (total, record) => total + record.byteLength,
        0,
      ),
    );
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD ISO directory graph is cyclic or ambiguous");
  });

  it("fails closed on an incomplete UDF recognition sequence", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.fill(0, 19 * DVD_SECTOR_SIZE_BYTES, 20 * DVD_SECTOR_SIZE_BYTES);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF recognition sequence is incomplete");
  });

  it("fails closed on a malformed UDF recognition descriptor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image[19 * DVD_SECTOR_SIZE_BYTES + 6] = 0;
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF recognition descriptor is malformed");
  });

  it("fails closed on an unsupported UDF allocation form", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.writeUInt16LE(2, 301 * DVD_SECTOR_SIZE_BYTES + 34);
    writeUdfSectorTag(image, 301, 261, 1);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF allocation descriptors are unsupported");
  });

  it("fails closed on a shortened DVD-Video file extent", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    image.writeBigUInt64LE(
      BigInt(7 * DVD_SECTOR_SIZE_BYTES),
      305 * DVD_SECTOR_SIZE_BYTES + 56,
    );
    writeUdfSectorTag(image, 305, 261, 5);
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF file layout is incomplete");
  });

  it("fails closed when the UDF candidate boundary has no alternate anchor", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: false,
      includeUdf: true,
    });
    for (const anchorLba of [343, 599]) {
      image.fill(
        0,
        anchorLba * DVD_SECTOR_SIZE_BYTES,
        (anchorLba + 1) * DVD_SECTOR_SIZE_BYTES,
      );
    }
    const fixture = writeFixture(image);

    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: 600,
      imagePath: fixture.imagePath,
    })).rejects.toThrow("DVD UDF anchor set is incomplete");
  });

  it("fails closed before reading an overflowing candidate boundary", async () => {
    await expect(proveDvdImageLayoutCompleteness({
      candidateBoundaryLba: Number.MAX_SAFE_INTEGER,
      imagePath: "/not-read",
    })).rejects.toThrow("DVD retained image boundary is invalid");
  });
});

describe("DVD layout damage classification", () => {
  it("rejects an oversized damage range before expanding it", async () => {
    const fixture = createSyntheticDvdImage(50);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 50, sectorCount: 1_000_000 }],
    })).rejects.toThrow("DVD salvage damage map exceeds the image");
  });

  it("accepts a substituted sector proved outside filesystem allocation", async () => {
    const fixture = createSyntheticDvdImage(50);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 50, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [],
      outcome: "accepted",
    });
  });

  it("preserves salvage classification for an interleaved title cell", async () => {
    const image = syntheticCompleteDvdImage({
      includeIso: true,
      includeUdf: false,
    });
    const playbackOffset = 360 * DVD_SECTOR_SIZE_BYTES +
      2 * DVD_SECTOR_SIZE_BYTES + 16 + 237;
    image[playbackOffset] = image[playbackOffset]! | 0x04;
    image.writeUInt32BE(2, playbackOffset + 12);
    image.copy(
      image,
      370 * DVD_SECTOR_SIZE_BYTES,
      360 * DVD_SECTOR_SIZE_BYTES,
      366 * DVD_SECTOR_SIZE_BYTES,
    );
    const fixture = writeFixture(image, 402);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 402, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [{
        badSectorCount: 1,
        titleNumber: 1,
        titleSetNumber: 1,
      }],
      outcome: "accepted",
    });
  });

  it("preserves salvage classification with an ISO System Use area", async () => {
    const image = Buffer.alloc(64 * DVD_SECTOR_SIZE_BYTES);
    writeSyntheticIsoLayout(image, {
      fileStartLba: 22,
      pathTableLba: 18,
      rootLba: 20,
      videoDirectoryLba: 21,
      volumeSpaceSize: 60,
    });
    const rootRecordOffset = 20 * DVD_SECTOR_SIZE_BYTES + 68;
    image[rootRecordOffset] = 49;
    const systemUseOffset = rootRecordOffset + 42;
    image.write("SP", systemUseOffset, "ascii");
    image[systemUseOffset + 2] = 7;
    image[systemUseOffset + 3] = 1;
    image[systemUseOffset + 4] = 0xbe;
    image[systemUseOffset + 5] = 0xef;
    const fixture = writeFixture(image, 50);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 50, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [],
      outcome: "accepted",
    });
  });

  it("identifies isolated MPEG payload damage in a title VOB", async () => {
    const fixture = createSyntheticPayloadDvdImage(32);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 32, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [{
        badSectorCount: 1,
        titleNumber: 1,
        titleSetNumber: 1,
      }],
      outcome: "accepted",
    });
  });

  it("counts multiple isolated payload sectors while accepting unused damage", async () => {
    const fixture = createSyntheticPayloadDvdImage(32);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [
        { startLba: 32, sectorCount: 1 },
        { startLba: 35, sectorCount: 1 },
        { startLba: 50, sectorCount: 1 },
      ],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [{
        badSectorCount: 2,
        titleNumber: 1,
        titleSetNumber: 1,
      }],
      outcome: "accepted",
    });
  });

  it("associates disjoint cells in one title set only with traversing titles", async () => {
    const fixture = createSyntheticPayloadDvdImage(32, [0, 3], {
      globalTitles: [
        {
          parts: [{ pgcNumber: 1, programNumber: 1 }],
          titleSetTitleNumber: 1,
        },
        {
          parts: [{ pgcNumber: 2, programNumber: 1 }],
          titleSetTitleNumber: 2,
        },
      ],
      programChains: [
        {
          cells: [{ firstSector: 0, lastSector: 2 }],
          programStartCells: [1],
        },
        {
          cells: [{ firstSector: 3, lastSector: 5 }],
          programStartCells: [1],
        },
      ],
    });

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [
        { startLba: 32, sectorCount: 1 },
        { startLba: 35, sectorCount: 1 },
      ],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [
        { badSectorCount: 1, titleNumber: 1, titleSetNumber: 1 },
        { badSectorCount: 1, titleNumber: 2, titleSetNumber: 1 },
      ],
      outcome: "accepted",
    });
  });

  it("associates a shared cell with every referencing title", async () => {
    const fixture = createSyntheticPayloadDvdImage(32, [0, 3], {
      globalTitles: [
        {
          parts: [{ pgcNumber: 1, programNumber: 1 }],
          titleSetTitleNumber: 1,
        },
        {
          parts: [{ pgcNumber: 2, programNumber: 1 }],
          titleSetTitleNumber: 2,
        },
      ],
      programChains: [
        {
          cells: [{ firstSector: 0, lastSector: 5 }],
          programStartCells: [1],
        },
        {
          cells: [{ firstSector: 0, lastSector: 5 }],
          programStartCells: [1],
        },
      ],
    });

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 32, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [
        { badSectorCount: 1, titleNumber: 1, titleSetNumber: 1 },
        { badSectorCount: 1, titleNumber: 2, titleSetNumber: 1 },
      ],
      outcome: "accepted",
    });
  });

  it("includes every cell in a referenced multi-angle block", async () => {
    const fixture = createSyntheticPayloadDvdImage(35, [0, 3], {
      globalTitles: [{
        angleCount: 2,
        parts: [{ pgcNumber: 1, programNumber: 1 }],
        titleSetTitleNumber: 1,
      }],
      programChains: [{
        cells: [
          {
            blockMode: 1,
            blockType: 1,
            firstSector: 0,
            lastSector: 0,
          },
          {
            blockMode: 3,
            blockType: 1,
            firstSector: 3,
            lastSector: 5,
          },
        ],
        programStartCells: [1],
      }],
    });

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 35, sectorCount: 1 }],
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [
        { badSectorCount: 1, titleNumber: 1, titleSetNumber: 1 },
      ],
      outcome: "accepted",
    });
  });

  it("rejects a substituted VOB navigation pack", async () => {
    const fixture = createSyntheticPayloadDvdImage(34);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 34, sectorCount: 1 }],
    })).resolves.toEqual({ outcome: "rejected", reason: "navigation" });
  });

  it("fails closed when the title VOBU address map is malformed", async () => {
    const fixture = createSyntheticPayloadDvdImage(32, [0, 0]);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 32, sectorCount: 1 }],
    })).rejects.toThrow("DVD title VOBU address map is malformed");
  });

  it("rejects contradictory ISO and UDF title VOB layouts as ambiguous", async () => {
    const fixture = createSyntheticContradictoryUdfPayloadDvdImage(342);

    await expect(classifyDvdImageDamage({
      ...fixture,
      expectedByteCount: fixture.sizeBytes,
      unreadableSectorRanges: [{ startLba: 342, sectorCount: 1 }],
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
    })).resolves.toEqual({
      affectedTitleBadSectorCounts: [],
      outcome: "accepted",
    });
  });

  it(
    "preserves salvage classification at the historical UDF alternate anchor",
    async () => {
      const fixture = createSyntheticUdfDvdImage(444);

      await expect(classifyDvdImageDamage({
        expectedByteCount: fixture.sizeBytes,
        imagePath: fixture.imagePath,
        unreadableSectorRanges: [{ startLba: 444, sectorCount: 1 }],
      })).resolves.toEqual({
        outcome: "rejected",
        reason: "filesystem_metadata",
      });
    },
  );

  it(
    "preserves salvage classification for a UDF partition-header extent",
    async () => {
      const image = syntheticLegacyUdfSalvageImage();
      for (const descriptorLba of [258, 274]) {
        const descriptor = image.subarray(
          descriptorLba * DVD_SECTOR_SIZE_BYTES,
          (descriptorLba + 1) * DVD_SECTOR_SIZE_BYTES,
        );
        descriptor.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 56);
        descriptor.writeUInt32LE(200, 60);
        writeLegacyUdfTag(descriptor, 5);
      }
      const fixture = writeFixture(image, 500);

      await expect(classifyDvdImageDamage({
        expectedByteCount: fixture.sizeBytes,
        imagePath: fixture.imagePath,
        unreadableSectorRanges: [{ startLba: 500, sectorCount: 1 }],
      })).resolves.toEqual({
        outcome: "rejected",
        reason: "filesystem_metadata",
      });
    },
  );

  it(
    "preserves salvage classification for an extended UDF allocation descriptor",
    async () => {
      const image = syntheticLegacyUdfSalvageImage();
      const fileEntry = image.subarray(
        305 * DVD_SECTOR_SIZE_BYTES,
        306 * DVD_SECTOR_SIZE_BYTES,
      );
      fileEntry.writeUInt16LE(2, 34);
      fileEntry.writeUInt32LE(20, 172);
      fileEntry.fill(0, 176, 196);
      fileEntry.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 176);
      fileEntry.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 180);
      fileEntry.writeUInt32LE(DVD_SECTOR_SIZE_BYTES, 184);
      fileEntry.writeUInt32LE(10, 188);
      fileEntry.writeUInt16LE(0, 192);
      writeLegacyUdfTag(fileEntry, 261);
      const fixture = writeFixture(image, 310);

      await expect(classifyDvdImageDamage({
        expectedByteCount: fixture.sizeBytes,
        imagePath: fixture.imagePath,
        unreadableSectorRanges: [{ startLba: 310, sectorCount: 1 }],
      })).resolves.toEqual({ outcome: "rejected", reason: "ifo" });
    },
  );

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
