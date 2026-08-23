import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { UnreadableSectorRange } from "@rip-dvd/data-access";

import {
  DVD_SECTOR_SIZE_BYTES,
} from "./dvd-recovery-contracts.js";
import type { DvdSalvageRejectionReason } from "./dvd-salvage-validator.js";

const MAX_DESCRIPTOR_SECTORS = 256;
const MAX_DIRECTORY_BYTES = 16 * 1_024 * 1_024;
const MAX_DIRECTORY_DEPTH = 256;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_FILE_ENTRY_BYTES = 1_048_576;
const UDF_EXTENT_LENGTH_MASK = 0x3fff_ffff;
const UDF_EXTENT_TYPE_MASK = 0xc000_0000;
const REQUIRED_DVD_VIDEO_PATHS = [
  "VIDEO_TS/VIDEO_TS.IFO",
  "VIDEO_TS/VIDEO_TS.BUP",
] as const;

interface SectorExtent {
  fileLocation?: {
    path: string;
    sectorOffset: number;
    source: "iso" | "udf";
  };
  startLba: number;
  sectorCount: number;
  reason: DvdSalvageRejectionReason;
}

interface DvdFileLayout {
  byteCount: number;
  embedded: boolean;
  extents: readonly {
    byteCount: number;
    startLba: number;
  }[];
  path: string;
}

interface IsoDirectoryLayout {
  extendedAttributeSectorCount: number;
  extentLba: number;
  path: string;
}

interface UdfLongAllocationDescriptor {
  extentLength: number;
  extentType: number;
  logicalBlockNumber: number;
  partitionReferenceNumber: number;
}

interface UdfPartition {
  number: number;
  startLba: number;
  sectorCount: number;
}

interface UdfLogicalVolume {
  fileSetDescriptor: UdfLongAllocationDescriptor;
  integritySequenceLength: number;
  integritySequenceStartLba: number;
  partitionNumbersByReference: readonly number[];
}

type DvdDamageClassification = {
  affectedTitleBadSectorCounts: readonly {
    badSectorCount: number;
    titleNumber: number;
    titleSetNumber: number;
  }[];
  outcome: "accepted";
} | {
  outcome: "rejected";
  reason: DvdSalvageRejectionReason;
};

interface DvdLayoutAnalysis {
  damageClassification: DvdDamageClassification;
  maximumReferencedLba: number;
}

type DvdLayoutAnalysisPurpose = {
  kind: "completeness-proof";
} | {
  exactImageByteCount: number;
  kind: "salvage-classification";
  unreadableSectorRanges: readonly UnreadableSectorRange[];
};

interface DvdLayoutAnalysisPolicy {
  exactImageByteCount?: number;
  unreadableSectorRanges: readonly UnreadableSectorRange[];
  validateDamageMap(badSectors: ReadonlySet<number>): void;
  validateDvdVideoViews(context: {
    hasIso: boolean;
    hasUdf: boolean;
    validateFileStructureOverlaps(): void;
    validateView(source: "iso" | "udf"): Promise<string>;
  }): Promise<void>;
  validateUdfAlternateAnchors(context: {
    anchor: Buffer;
    alternateAnchorLbas: readonly number[];
    classifyAnchor(lba: number): void;
    readRawAnchor(lba: number): Promise<Buffer>;
  }): Promise<void>;
  validateUdfDescriptorSequenceLengths(
    mainSequenceSectors: number,
    reserveSequenceSectors: number,
  ): void;
}

function createDvdLayoutAnalysisPolicy(
  purpose: DvdLayoutAnalysisPurpose,
): DvdLayoutAnalysisPolicy {
  if (purpose.kind === "salvage-classification") {
    return {
      exactImageByteCount: purpose.exactImageByteCount,
      unreadableSectorRanges: purpose.unreadableSectorRanges,
      validateDamageMap(badSectors) {
        if (badSectors.size === 0) {
          throw new Error("DVD salvage damage map is empty");
        }
      },
      async validateDvdVideoViews() {},
      async validateUdfAlternateAnchors({
        alternateAnchorLbas,
        classifyAnchor,
      }) {
        for (const anchorLba of alternateAnchorLbas) {
          classifyAnchor(anchorLba);
        }
      },
      validateUdfDescriptorSequenceLengths() {},
    };
  }
  return {
    unreadableSectorRanges: [],
    validateDamageMap() {},
    async validateDvdVideoViews({
      hasIso,
      hasUdf,
      validateFileStructureOverlaps,
      validateView,
    }) {
      const parsedViews: string[] = [];
      if (hasIso) {
        parsedViews.push(await validateView("iso"));
      }
      if (hasUdf) {
        parsedViews.push(await validateView("udf"));
      }
      if (new Set(parsedViews).size !== 1) {
        throw new Error("DVD filesystem views disagree");
      }
      validateFileStructureOverlaps();
    },
    async validateUdfAlternateAnchors({
      anchor,
      alternateAnchorLbas,
      classifyAnchor,
      readRawAnchor,
    }) {
      let validAnchorCount = 1;
      for (const anchorLba of alternateAnchorLbas) {
        const alternateAnchor = await readRawAnchor(anchorLba);
        if (alternateAnchor.every((byte) => byte === 0)) {
          continue;
        }
        try {
          validateUdfTag(alternateAnchor, [2]);
        } catch {
          throw new Error("DVD UDF alternate anchor is malformed");
        }
        if (!alternateAnchor.subarray(16, 32).equals(anchor.subarray(16, 32))) {
          throw new Error("DVD UDF anchor pointers disagree");
        }
        classifyAnchor(anchorLba);
        validAnchorCount += 1;
      }
      if (validAnchorCount < 2) {
        throw new Error("DVD UDF anchor set is incomplete");
      }
    },
    validateUdfDescriptorSequenceLengths(
      mainSequenceSectors,
      reserveSequenceSectors,
    ) {
      if (mainSequenceSectors < 16 || reserveSequenceSectors < 16) {
        throw new Error("DVD UDF volume descriptor sequence is too short");
      }
    },
  };
}

class ClassifiedDamageError extends Error {
  constructor(readonly reason: DvdSalvageRejectionReason) {
    super(`DVD damage intersects ${reason}`);
  }
}

function sectorCountForBytes(byteCount: number): number {
  return Math.ceil(byteCount / DVD_SECTOR_SIZE_BYTES);
}

function requireSafeExtent(
  startLba: number,
  sectorCount: number,
  totalSectorCount: number,
): void {
  const endLba = startLba + sectorCount;
  if (
    !Number.isSafeInteger(startLba) ||
    startLba < 0 ||
    !Number.isSafeInteger(sectorCount) ||
    sectorCount <= 0 ||
    !Number.isSafeInteger(endLba) ||
    endLba > totalSectorCount
  ) {
    throw new Error("DVD filesystem extent is invalid");
  }
}

function extentContainsLba(extent: SectorExtent, lba: number): boolean {
  return lba >= extent.startLba && lba < extent.startLba + extent.sectorCount;
}

function recognitionDescriptorsContainLba(lba: number): boolean {
  return lba >= 16 && lba < 16 + 32;
}

function badSectorSet(ranges: readonly UnreadableSectorRange[]): Set<number> {
  const sectors = new Set<number>();
  for (const range of ranges) {
    for (let offset = 0; offset < range.sectorCount; offset += 1) {
      sectors.add(range.startLba + offset);
    }
  }
  return sectors;
}

function classifyDvdPath(path: string): DvdSalvageRejectionReason {
  const basename = path.slice(path.lastIndexOf("/") + 1).toUpperCase();
  if (basename.endsWith(".IFO")) {
    return "ifo";
  }
  if (basename.endsWith(".BUP")) {
    return "bup";
  }
  if (
    basename === "VIDEO_TS.VOB" ||
    /^VTS_\d{2}_0\.VOB$/.test(basename)
  ) {
    return "menu";
  }
  return "referenced_content";
}

function titleVobIdentity(path: string): {
  partNumber: number;
  titleSetNumber: number;
} | null {
  const match = /^VIDEO_TS\/VTS_(\d{2})_([1-9])\.VOB$/.exec(path);
  if (match === null) {
    return null;
  }
  return {
    partNumber: Number(match[2]),
    titleSetNumber: Number(match[1]),
  };
}

function validateUdfTag(buffer: Buffer, expectedIdentifiers: readonly number[]): number {
  if (buffer.byteLength < 16) {
    throw new Error("DVD UDF descriptor is truncated");
  }
  const identifier = buffer.readUInt16LE(0);
  if (!expectedIdentifiers.includes(identifier)) {
    throw new Error("DVD UDF descriptor has an unexpected type");
  }
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) {
      checksum = (checksum + buffer[index]!) & 0xff;
    }
  }
  if (checksum !== buffer[4]) {
    throw new Error("DVD UDF descriptor tag checksum is invalid");
  }
  const crcLength = buffer.readUInt16LE(10);
  if (crcLength > buffer.byteLength - 16) {
    throw new Error("DVD UDF descriptor CRC length is invalid");
  }
  let crc = 0;
  for (let index = 16; index < 16 + crcLength; index += 1) {
    crc ^= buffer[index]! << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }
  if (crc !== buffer.readUInt16LE(8)) {
    throw new Error("DVD UDF descriptor CRC is invalid");
  }
  return identifier;
}

function readUdfLongAllocationDescriptor(
  buffer: Buffer,
  offset: number,
): UdfLongAllocationDescriptor {
  if (offset < 0 || offset + 16 > buffer.byteLength) {
    throw new Error("DVD UDF allocation descriptor is truncated");
  }
  const rawLength = buffer.readUInt32LE(offset);
  return {
    extentLength: rawLength & UDF_EXTENT_LENGTH_MASK,
    extentType: rawLength & UDF_EXTENT_TYPE_MASK,
    logicalBlockNumber: buffer.readUInt32LE(offset + 4),
    partitionReferenceNumber: buffer.readUInt16LE(offset + 8),
  };
}

function decodeOstaCompressedUnicode(value: Buffer): string {
  if (value.byteLength === 0) {
    return "";
  }
  const compressionId = value[0];
  if (compressionId === 8) {
    return value.subarray(1).toString("latin1");
  }
  if (compressionId === 16 && value.byteLength % 2 === 1) {
    let decoded = "";
    for (let offset = 1; offset < value.byteLength; offset += 2) {
      decoded += String.fromCharCode(value.readUInt16BE(offset));
    }
    return decoded;
  }
  throw new Error("DVD UDF file identifier encoding is unsupported");
}

async function analyzeDvdImageLayout({
  candidateBoundaryLba,
  imagePath,
  purpose,
}: {
  candidateBoundaryLba: number;
  imagePath: string;
  purpose: DvdLayoutAnalysisPurpose;
}): Promise<DvdLayoutAnalysis> {
  const policy = createDvdLayoutAnalysisPolicy(purpose);
  const { exactImageByteCount, unreadableSectorRanges } = policy;
  const retainedByteCount = candidateBoundaryLba * DVD_SECTOR_SIZE_BYTES;
  if (
    !Number.isSafeInteger(candidateBoundaryLba) ||
    candidateBoundaryLba <= 0 ||
    !Number.isSafeInteger(retainedByteCount) ||
    exactImageByteCount !== undefined &&
      exactImageByteCount !== retainedByteCount
  ) {
    throw new Error("DVD retained image boundary is invalid");
  }
  const metadata = await lstat(imagePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < retainedByteCount ||
    exactImageByteCount !== undefined && metadata.size !== exactImageByteCount
  ) {
    throw new Error("DVD retained image is not the expected regular file");
  }
  const totalSectorCount = candidateBoundaryLba;
  const badSectors = badSectorSet(unreadableSectorRanges);
  policy.validateDamageMap(badSectors);
  for (const lba of badSectors) {
    if (lba < 0 || lba >= totalSectorCount) {
      throw new Error("DVD salvage damage map exceeds the image");
    }
  }

  const handle = await open(
    imagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const openedMetadata = await handle.stat();
  if (
    !openedMetadata.isFile() ||
    openedMetadata.dev !== metadata.dev ||
    openedMetadata.ino !== metadata.ino ||
    openedMetadata.size !== metadata.size
  ) {
    await handle.close();
    throw new Error("DVD retained image changed before validation");
  }
  const allocatedExtents: SectorExtent[] = [];
  const isoDvdFiles = new Map<string, DvdFileLayout>();
  const udfDvdFiles = new Map<string, DvdFileLayout>();
  const isoDvdPaths = new Set<string>();
  const udfDvdPaths = new Set<string>();
  let isoDirectoryEntryCount = 0;
  let udfDirectoryEntryCount = 0;
  let maximumReferencedLba = -1;
  const recordReferencedExtent = (
    startLba: number,
    sectorCount: number,
  ) => {
    requireSafeExtent(startLba, sectorCount, totalSectorCount);
    maximumReferencedLba = Math.max(
      maximumReferencedLba,
      startLba + sectorCount - 1,
    );
  };
  const addExtent = (
    startLba: number,
    sectorCount: number,
    reason: DvdSalvageRejectionReason,
    file?: {
      path: string;
      sectorOffset: number;
      source: "iso" | "udf";
    },
  ) => {
    recordReferencedExtent(startLba, sectorCount);
    allocatedExtents.push({ startLba, sectorCount, reason, fileLocation: file });
  };
  const classifyBeforeMetadataRead = (
    startLba: number,
    sectorCount: number,
    reason: "filesystem_metadata" | "directory_data" =
      "filesystem_metadata",
  ) => {
    requireSafeExtent(startLba, sectorCount, totalSectorCount);
    for (let lba = startLba; lba < startLba + sectorCount; lba += 1) {
      if (badSectors.has(lba)) {
        throw new ClassifiedDamageError(reason);
      }
    }
    addExtent(startLba, sectorCount, reason);
  };
  const readExtent = async (
    startLba: number,
    byteCount: number,
    reason: "filesystem_metadata" | "directory_data",
    maximumBytes: number,
  ): Promise<Buffer> => {
    if (
      !Number.isSafeInteger(byteCount) ||
      byteCount <= 0 ||
      byteCount > maximumBytes
    ) {
      throw new Error("DVD filesystem metadata exceeds its safety bound");
    }
    const sectorCount = sectorCountForBytes(byteCount);
    classifyBeforeMetadataRead(startLba, sectorCount, reason);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      byteCount,
      startLba * DVD_SECTOR_SIZE_BYTES,
    );
    if (bytesRead !== byteCount) {
      throw new Error("DVD filesystem metadata read was incomplete");
    }
    return buffer;
  };
  const readSector = (
    lba: number,
    reason: "filesystem_metadata" | "directory_data" =
      "filesystem_metadata",
  ) => readExtent(lba, DVD_SECTOR_SIZE_BYTES, reason, DVD_SECTOR_SIZE_BYTES);
  const readRawSector = async (lba: number): Promise<Buffer> => {
    requireSafeExtent(lba, 1, totalSectorCount);
    const buffer = Buffer.alloc(DVD_SECTOR_SIZE_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      lba * DVD_SECTOR_SIZE_BYTES,
    );
    if (bytesRead !== buffer.byteLength) {
      throw new Error("DVD filesystem recognition read was incomplete");
    }
    return buffer;
  };

  const parseIsoDirectory = async (
    startLba: number,
    byteCount: number,
    parentPath: string,
    visited: Set<string>,
    directoryLayouts: Map<string, IsoDirectoryLayout>,
    extentLba: number,
    extendedAttributeSectorCount: number,
    volumeSpaceSize: number,
    depth = 0,
  ): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new Error("DVD ISO directory depth exceeds its safety bound");
    }
    requireSafeExtent(
      startLba,
      sectorCountForBytes(byteCount),
      volumeSpaceSize,
    );
    const key = `${startLba}:${byteCount}`;
    if (visited.has(key) || directoryLayouts.has(parentPath)) {
      throw new Error("DVD ISO directory graph is cyclic or ambiguous");
    }
    visited.add(key);
    directoryLayouts.set(parentPath, {
      extendedAttributeSectorCount,
      extentLba,
      path: parentPath,
    });
    const directory = await readExtent(
      startLba,
      byteCount,
      "directory_data",
      MAX_DIRECTORY_BYTES,
    );
    let offset = 0;
    while (offset < directory.byteLength) {
      const recordLength = directory[offset]!;
      if (recordLength === 0) {
        offset = Math.ceil((offset + 1) / DVD_SECTOR_SIZE_BYTES) *
          DVD_SECTOR_SIZE_BYTES;
        continue;
      }
      isoDirectoryEntryCount += 1;
      if (isoDirectoryEntryCount > MAX_DIRECTORY_ENTRIES || recordLength < 34 ||
        offset + recordLength > directory.byteLength) {
        throw new Error("DVD ISO directory is malformed");
      }
      const record = directory.subarray(offset, offset + recordLength);
      const extentLba = record.readUInt32LE(2);
      const extentLbaBe = record.readUInt32BE(6);
      const extentBytes = record.readUInt32LE(10);
      const extentBytesBe = record.readUInt32BE(14);
      const flags = record[25]!;
      const extendedAttributeSectorCount = record[1]!;
      const identifierLength = record[32]!;
      if (
        extentLba !== extentLbaBe ||
        extentBytes !== extentBytesBe ||
        33 + identifierLength > record.byteLength ||
        record[26] !== 0 ||
        record[27] !== 0 ||
        (flags & 0x80) !== 0
      ) {
        throw new Error("DVD ISO directory record is unsupported");
      }
      const identifier = record.subarray(33, 33 + identifierLength);
      const isSpecial = identifierLength === 1 &&
        (identifier[0] === 0 || identifier[0] === 1);
      if (extentBytes > 0) {
        const dataSectorCount = sectorCountForBytes(extentBytes);
        if (
          !Number.isSafeInteger(
            extendedAttributeSectorCount + dataSectorCount,
          )
        ) {
          throw new Error("DVD ISO file extent is outside the volume");
        }
        try {
          requireSafeExtent(
            extentLba,
            extendedAttributeSectorCount + dataSectorCount,
            volumeSpaceSize,
          );
        } catch {
          throw new Error("DVD ISO file extent is outside the volume");
        }
      }
      if (!isSpecial && extentBytes > 0) {
        const name = identifier.toString("ascii").replace(/;\d+$/, "");
        const path = `${parentPath}/${name}`.replace(/^\/+/, "");
        if (extendedAttributeSectorCount > 0) {
          addExtent(
            extentLba,
            extendedAttributeSectorCount,
            "filesystem_metadata",
          );
        }
        const dataLba = extentLba + extendedAttributeSectorCount;
        if ((flags & 0x02) !== 0) {
          await parseIsoDirectory(
            dataLba,
            extentBytes,
            path,
            visited,
            directoryLayouts,
            extentLba,
            extendedAttributeSectorCount,
            volumeSpaceSize,
            depth + 1,
          );
        } else {
          const normalizedPath = path.toUpperCase();
          isoDvdPaths.add(normalizedPath);
          const fileLayout = {
            byteCount: extentBytes,
            embedded: false,
            extents: [{ byteCount: extentBytes, startLba: dataLba }],
            path: normalizedPath,
          } satisfies DvdFileLayout;
          const existingFile = isoDvdFiles.get(normalizedPath);
          if (
            existingFile !== undefined &&
            JSON.stringify(existingFile) !== JSON.stringify(fileLayout)
          ) {
            throw new Error("DVD ISO file layout is ambiguous");
          }
          isoDvdFiles.set(normalizedPath, fileLayout);
          addExtent(
            dataLba,
            sectorCountForBytes(extentBytes),
            classifyDvdPath(path),
            {
              path: normalizedPath,
              sectorOffset: 0,
              source: "iso",
            },
          );
        }
      }
      offset += recordLength;
    }
  };

  const readDvdFile = async (
    file: DvdFileLayout,
    maximumBytes: number,
  ): Promise<Buffer> => {
    if (file.byteCount <= 0 || file.byteCount > maximumBytes) {
      throw new Error("DVD-Video control file exceeds its safety bound");
    }
    const content = Buffer.alloc(file.byteCount);
    let written = 0;
    for (const extent of file.extents) {
      const sectorCount = sectorCountForBytes(extent.byteCount);
      requireSafeExtent(extent.startLba, sectorCount, totalSectorCount);
      for (
        let lba = extent.startLba;
        lba < extent.startLba + sectorCount;
        lba += 1
      ) {
        if (badSectors.has(lba)) {
          throw new ClassifiedDamageError("ifo");
        }
      }
      const bytesToRead = Math.min(extent.byteCount, file.byteCount - written);
      const { bytesRead } = await handle.read(
        content,
        written,
        bytesToRead,
        extent.startLba * DVD_SECTOR_SIZE_BYTES,
      );
      if (bytesRead !== bytesToRead) {
        throw new Error("DVD-Video control file read was incomplete");
      }
      written += bytesRead;
    }
    if (written !== file.byteCount) {
      throw new Error("DVD-Video control file layout is incomplete");
    }
    return content;
  };

  const parseVobuAddressMap = (
    content: Buffer,
    addressMapPointerOffset: number,
    vobSectorCount: number,
    description: "menu" | "title",
  ): ReadonlySet<number> => {
    const addressMapSector = content.readUInt32BE(addressMapPointerOffset);
    if (addressMapSector === 0) {
      if (vobSectorCount === 0) {
        return new Set();
      }
      throw new Error(`DVD ${description} VOBU address map is missing`);
    }
    if (vobSectorCount <= 0) {
      throw new Error(`DVD ${description} VOBU address map has no VOB`);
    }
    const addressMapOffset = addressMapSector * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(addressMapOffset) ||
      addressMapOffset < DVD_SECTOR_SIZE_BYTES ||
      addressMapOffset + 4 > content.byteLength
    ) {
      throw new Error(`DVD ${description} VOBU address map is missing`);
    }
    const tableByteCount = content.readUInt32BE(addressMapOffset) + 1;
    if (
      tableByteCount < 8 ||
      tableByteCount % 4 !== 0 ||
      addressMapOffset + tableByteCount > content.byteLength
    ) {
      throw new Error(`DVD ${description} VOBU address map is malformed`);
    }
    const navigationSectors = new Set<number>();
    let previousSector = -1;
    for (
      let offset = addressMapOffset + 4;
      offset < addressMapOffset + tableByteCount;
      offset += 4
    ) {
      const sector = content.readUInt32BE(offset);
      if (sector <= previousSector || sector >= vobSectorCount) {
        throw new Error(`DVD ${description} VOBU address map is malformed`);
      }
      navigationSectors.add(sector);
      previousSector = sector;
    }
    if (!navigationSectors.has(0)) {
      throw new Error(`DVD ${description} VOBU address map is incomplete`);
    }
    return navigationSectors;
  };

  const readTitleVobuAddressMap = async (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumber: number,
    titleVobSectorCount: number,
  ): Promise<ReadonlySet<number>> => {
    const ifoPath = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0.IFO`;
    const file = dvdFiles.get(ifoPath);
    if (file === undefined) {
      throw new Error("DVD title-set navigation file is missing");
    }
    const content = await readDvdFile(file, MAX_FILE_ENTRY_BYTES * 16);
    if (
      content.byteLength < DVD_SECTOR_SIZE_BYTES ||
      content.toString("ascii", 0, 12) !== "DVDVIDEO-VTS"
    ) {
      throw new Error("DVD title-set navigation file is malformed");
    }
    return parseVobuAddressMap(content, 0xe4, titleVobSectorCount, "title");
  };

  interface GlobalDvdTitle {
    angleCount: number;
    chapterCount: number;
    titleNumber: number;
    titleSetNumber: number;
    titleSetTitleNumber: number;
  }

  interface DvdProgramChain {
    angleBlockLengths: readonly number[];
    cells: readonly {
      blockMode: number;
      blockType: number;
      cellNumber: number;
      firstSector: number;
      lastSector: number;
      lastVobuStartSector: number;
      vobId: number;
    }[];
    commandBlocks: readonly {
      commands: readonly string[];
    }[];
    programStartCells: readonly number[];
  }

  const parseGlobalTitles = async (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
  ): Promise<readonly GlobalDvdTitle[]> => {
    const file = dvdFiles.get("VIDEO_TS/VIDEO_TS.IFO");
    if (file === undefined) {
      throw new Error("DVD video manager navigation file is missing");
    }
    const content = await readDvdFile(file, MAX_FILE_ENTRY_BYTES * 16);
    if (
      content.byteLength < DVD_SECTOR_SIZE_BYTES ||
      content.toString("ascii", 0, 12) !== "DVDVIDEO-VMG"
    ) {
      throw new Error("DVD video manager navigation file is malformed");
    }
    const tableOffset = content.readUInt32BE(0xc4) * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(tableOffset) ||
      tableOffset < DVD_SECTOR_SIZE_BYTES ||
      tableOffset + 8 > content.byteLength
    ) {
      throw new Error("DVD title search table is missing");
    }
    const titleCount = content.readUInt16BE(tableOffset);
    const tableByteCount = content.readUInt32BE(tableOffset + 4) + 1;
    if (
      titleCount <= 0 ||
      titleCount > 99 ||
      content.readUInt16BE(tableOffset + 2) !== 0 ||
      tableByteCount < 8 + titleCount * 12 ||
      tableOffset + tableByteCount > content.byteLength
    ) {
      throw new Error("DVD title search table is malformed");
    }
    const titles: GlobalDvdTitle[] = [];
    const titleSetTitles = new Set<string>();
    for (let index = 0; index < titleCount; index += 1) {
      const offset = tableOffset + 8 + index * 12;
      const angleCount = content[offset + 1]!;
      const chapterCount = content.readUInt16BE(offset + 2);
      const titleSetNumber = content[offset + 6]!;
      const titleSetTitleNumber = content[offset + 7]!;
      const key = `${titleSetNumber}:${titleSetTitleNumber}`;
      if (
        angleCount <= 0 ||
        angleCount > 9 ||
        chapterCount <= 0 ||
        titleSetNumber <= 0 ||
        titleSetNumber > 99 ||
        titleSetTitleNumber <= 0 ||
        titleSetTitleNumber > 99 ||
        titleSetTitles.has(key)
      ) {
        throw new Error("DVD title search table is malformed");
      }
      titleSetTitles.add(key);
      titles.push({
        angleCount,
        chapterCount,
        titleNumber: index + 1,
        titleSetNumber,
        titleSetTitleNumber,
      });
    }
    return titles;
  };

  const readProgramChainCommands = (
    content: Buffer,
    pgcitOffset: number,
    pgcitByteCount: number,
    pgcStartByte: number,
    followingOffsets: readonly number[],
  ): readonly { commands: readonly string[] }[] => {
    const pgcOffset = pgcitOffset + pgcStartByte;
    const commandTableOffset = content.readUInt16BE(pgcOffset + 228);
    if (commandTableOffset === 0) {
      return [];
    }
    const commandTableEnd = Math.min(
      pgcitByteCount - pgcStartByte,
      ...followingOffsets.filter((offset) => offset > 0),
    );
    const absoluteCommandTableOffset = pgcOffset + commandTableOffset;
    if (
      commandTableOffset < 236 ||
      commandTableOffset + 8 > commandTableEnd ||
      absoluteCommandTableOffset + 8 > content.byteLength
    ) {
      throw new Error("DVD program chain command table is malformed");
    }
    const commandCounts = [
      content.readUInt16BE(absoluteCommandTableOffset),
      content.readUInt16BE(absoluteCommandTableOffset + 2),
      content.readUInt16BE(absoluteCommandTableOffset + 4),
    ];
    const commandCount = commandCounts.reduce((total, count) => total + count, 0);
    if (
      commandCount > 3_000 ||
      content.readUInt16BE(absoluteCommandTableOffset + 6) !== 0 ||
      commandTableOffset + 8 + commandCount * 8 > commandTableEnd
    ) {
      throw new Error("DVD program chain command table is malformed");
    }
    let commandOffset = absoluteCommandTableOffset + 8;
    return commandCounts.map((count) => {
      const commands = [];
      for (let index = 0; index < count; index += 1) {
        commands.push(content.subarray(commandOffset, commandOffset + 8).toString("hex"));
        commandOffset += 8;
      }
      return { commands };
    });
  };

  const parseProgramChain = (
    content: Buffer,
    pgcitOffset: number,
    pgcitByteCount: number,
    pgcStartByte: number,
    titleVobSectorCount: number,
  ): DvdProgramChain => {
    const pgcOffset = pgcitOffset + pgcStartByte;
    if (
      pgcStartByte < 8 ||
      pgcStartByte + 236 > pgcitByteCount ||
      pgcOffset + 236 > content.byteLength
    ) {
      throw new Error("DVD program chain table is malformed");
    }
    const programCount = content[pgcOffset + 2]!;
    const cellCount = content[pgcOffset + 3]!;
    const programMapOffset = content.readUInt16BE(pgcOffset + 230);
    const cellPlaybackOffset = content.readUInt16BE(pgcOffset + 232);
    const cellPositionOffset = content.readUInt16BE(pgcOffset + 234);
    const commandBlocks = readProgramChainCommands(
      content,
      pgcitOffset,
      pgcitByteCount,
      pgcStartByte,
      [programMapOffset, cellPlaybackOffset, cellPositionOffset],
    );
    if (
      programCount <= 0 ||
      cellCount <= 0 ||
      programCount > cellCount ||
      programMapOffset < 236 ||
      cellPlaybackOffset < 236 ||
      cellPositionOffset < 236 ||
      programMapOffset + programCount > cellPlaybackOffset ||
      cellPlaybackOffset + cellCount * 24 > cellPositionOffset ||
      pgcStartByte + cellPositionOffset + cellCount * 4 > pgcitByteCount
    ) {
      throw new Error("DVD program chain table is malformed");
    }
    const programStartCells: number[] = [];
    let previousStartCell = 0;
    for (let index = 0; index < programCount; index += 1) {
      const startCell = content[pgcOffset + programMapOffset + index]!;
      if (
        startCell <= previousStartCell ||
        startCell > cellCount ||
        (index === 0 && startCell !== 1)
      ) {
        throw new Error("DVD program chain table is malformed");
      }
      programStartCells.push(startCell);
      previousStartCell = startCell;
    }
    const cells: Array<DvdProgramChain["cells"][number]> = [];
    let angleBlockLength = 0;
    const angleBlockLengths: number[] = [];
    for (let index = 0; index < cellCount; index += 1) {
      const playbackOffset = pgcOffset + cellPlaybackOffset + index * 24;
      const positionOffset = pgcOffset + cellPositionOffset + index * 4;
      const blockMode = content[playbackOffset]! >> 6;
      const blockType = (content[playbackOffset]! >> 4) & 0x03;
      const firstSector = content.readUInt32BE(playbackOffset + 8);
      const lastVobuStartSector = content.readUInt32BE(playbackOffset + 16);
      const lastSector = content.readUInt32BE(playbackOffset + 20);
      const vobId = content.readUInt16BE(positionOffset);
      const cellNumber = content[positionOffset + 3]!;
      if (
        firstSector > lastVobuStartSector ||
        lastVobuStartSector > lastSector ||
        lastSector >= titleVobSectorCount ||
        vobId <= 0 ||
        content[positionOffset + 2] !== 0 ||
        cellNumber <= 0
      ) {
        throw new Error("DVD program chain cell table is malformed");
      }
      if (blockType === 0) {
        if (blockMode !== 0 || angleBlockLength !== 0) {
          throw new Error("DVD program chain angle layout is malformed");
        }
      } else if (blockType === 1) {
        if (blockMode === 1 && angleBlockLength === 0) {
          angleBlockLength = 1;
        } else if (blockMode === 2 && angleBlockLength > 0) {
          angleBlockLength += 1;
        } else if (blockMode === 3 && angleBlockLength > 0) {
          angleBlockLengths.push(angleBlockLength + 1);
          angleBlockLength = 0;
        } else {
          throw new Error("DVD program chain angle layout is malformed");
        }
      } else {
        throw new Error("DVD program chain angle layout is malformed");
      }
      cells.push({
        blockMode,
        blockType,
        cellNumber,
        firstSector,
        lastSector,
        lastVobuStartSector,
        vobId,
      });
    }
    if (angleBlockLength !== 0) {
      throw new Error("DVD program chain angle layout is malformed");
    }
    return { angleBlockLengths, cells, commandBlocks, programStartCells };
  };

  const parseMenuProgramChain = (
    content: Buffer,
    pgcitOffset: number,
    pgcitByteCount: number,
    pgcStartByte: number,
    menuVobSectorCount: number,
  ): DvdProgramChain => {
    const pgcOffset = pgcitOffset + pgcStartByte;
    if (
      pgcStartByte < 8 ||
      pgcStartByte + 236 > pgcitByteCount ||
      pgcOffset + 236 > content.byteLength
    ) {
      throw new Error("DVD menu program chain table is malformed");
    }
    const programCount = content[pgcOffset + 2]!;
    const cellCount = content[pgcOffset + 3]!;
    if (programCount === 0 && cellCount === 0) {
      const programMapOffset = content.readUInt16BE(pgcOffset + 230);
      const cellPlaybackOffset = content.readUInt16BE(pgcOffset + 232);
      const cellPositionOffset = content.readUInt16BE(pgcOffset + 234);
      if (
        programMapOffset !== 0 ||
        cellPlaybackOffset !== 0 ||
        cellPositionOffset !== 0
      ) {
        throw new Error("DVD menu program chain table is malformed");
      }
      const commandBlocks = readProgramChainCommands(
        content,
        pgcitOffset,
        pgcitByteCount,
        pgcStartByte,
        [],
      );
      return {
        angleBlockLengths: [],
        cells: [],
        commandBlocks,
        programStartCells: [],
      };
    }
    if (menuVobSectorCount === 0) {
      throw new Error("DVD menu program chain references a missing VOB");
    }
    return parseProgramChain(
      content,
      pgcitOffset,
      pgcitByteCount,
      pgcStartByte,
      menuVobSectorCount,
    );
  };

  const parseMenuProgramChainUnits = (
    content: Buffer,
    tablePointerOffset: number,
    menuVobSectorCount: number,
  ): readonly {
    languageCode: number;
    programChains: readonly DvdProgramChain[];
  }[] => {
    const tableSector = content.readUInt32BE(tablePointerOffset);
    if (tableSector === 0) {
      if (menuVobSectorCount > 0) {
        throw new Error("DVD menu program chain table is missing");
      }
      return [];
    }
    const tableOffset = tableSector * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(tableOffset) ||
      tableOffset < DVD_SECTOR_SIZE_BYTES ||
      tableOffset + 8 > content.byteLength
    ) {
      throw new Error("DVD menu program chain unit table is missing");
    }
    const languageUnitCount = content.readUInt16BE(tableOffset);
    const tableByteCount = content.readUInt32BE(tableOffset + 4) + 1;
    if (
      languageUnitCount <= 0 ||
      languageUnitCount > 99 ||
      content.readUInt16BE(tableOffset + 2) !== 0 ||
      tableByteCount < 8 + languageUnitCount * 8 ||
      tableOffset + tableByteCount > content.byteLength
    ) {
      throw new Error("DVD menu program chain unit table is malformed");
    }
    const languageCodes = new Set<number>();
    const languageUnitStarts = new Set<number>();
    const units = [];
    for (let index = 0; index < languageUnitCount; index += 1) {
      const languageOffset = tableOffset + 8 + index * 8;
      const languageCode = content.readUInt16BE(languageOffset);
      const pgcitStartByte = content.readUInt32BE(languageOffset + 4);
      const pgcitOffset = tableOffset + pgcitStartByte;
      if (
        languageCode === 0 ||
        languageCodes.has(languageCode) ||
        languageUnitStarts.has(pgcitStartByte) ||
        pgcitStartByte < 8 + languageUnitCount * 8 ||
        pgcitOffset + 8 > tableOffset + tableByteCount
      ) {
        throw new Error("DVD menu language unit is malformed");
      }
      languageCodes.add(languageCode);
      languageUnitStarts.add(pgcitStartByte);
      const pgcCount = content.readUInt16BE(pgcitOffset);
      const pgcitByteCount = content.readUInt32BE(pgcitOffset + 4) + 1;
      if (
        pgcCount <= 0 ||
        pgcCount > 999 ||
        content.readUInt16BE(pgcitOffset + 2) !== 0 ||
        pgcitByteCount < 8 + pgcCount * 8 ||
        pgcitOffset + pgcitByteCount > tableOffset + tableByteCount
      ) {
        throw new Error("DVD menu program chain table is malformed");
      }
      const programChains: DvdProgramChain[] = [];
      const starts = new Set<number>();
      for (let pgcIndex = 0; pgcIndex < pgcCount; pgcIndex += 1) {
        const searchPointerOffset = pgcitOffset + 8 + pgcIndex * 8;
        const pgcStartByte = content.readUInt32BE(searchPointerOffset + 4);
        if (starts.has(pgcStartByte)) {
          throw new Error("DVD menu program chain table is ambiguous");
        }
        starts.add(pgcStartByte);
        programChains.push(parseMenuProgramChain(
          content,
          pgcitOffset,
          pgcitByteCount,
          pgcStartByte,
          menuVobSectorCount,
        ));
      }
      units.push({ languageCode, programChains });
    }
    return units;
  };

  const managerProgramChainCountBySource = new Map<
    "iso" | "udf",
    Promise<number | undefined>
  >();
  const readManagerProgramChainCount = (
    source: "iso" | "udf",
  ): Promise<number | undefined> => {
    const existing = managerProgramChainCountBySource.get(source);
    if (existing !== undefined) {
      return existing;
    }
    const count = (async () => {
      const dvdFiles = source === "iso" ? isoDvdFiles : udfDvdFiles;
      const managerIfo = dvdFiles.get("VIDEO_TS/VIDEO_TS.IFO");
      if (managerIfo === undefined) {
        throw new Error("DVD video manager navigation file is missing");
      }
      const managerIfoContent = await readDvdFile(
        managerIfo,
        MAX_FILE_ENTRY_BYTES * 16,
      );
      if (
        managerIfoContent.byteLength < DVD_SECTOR_SIZE_BYTES ||
        managerIfoContent.toString("ascii", 0, 12) !== "DVDVIDEO-VMG"
      ) {
        throw new Error("DVD video manager navigation file is malformed");
      }
      const menuVob = dvdFiles.get("VIDEO_TS/VIDEO_TS.VOB");
      const menuVobSectorCount = menuVob === undefined
        ? 0
        : menuVob.byteCount / DVD_SECTOR_SIZE_BYTES;
      if (!Number.isInteger(menuVobSectorCount)) {
        throw new Error("DVD menu VOB layout is malformed");
      }
      const units = parseMenuProgramChainUnits(
        managerIfoContent,
        0xc8,
        menuVobSectorCount,
      );
      return units.length === 0
        ? undefined
        : Math.min(...units.map((unit) => unit.programChains.length));
    })();
    managerProgramChainCountBySource.set(source, count);
    return count;
  };

  const dvdVmBits = (
    command: string,
    start: number,
    count: number,
  ): number => {
    const instruction = Buffer.from(command, "hex").readBigUInt64BE();
    const shift = BigInt(start + 1 - count);
    return Number(
      instruction >> shift & (1n << BigInt(count)) - 1n,
    );
  };

  const dvdVmCommandTargetsManagerProgramChain = (
    command: string,
  ): boolean =>
    dvdVmBits(command, 63, 3) === 1 &&
    dvdVmBits(command, 60, 1) === 1 &&
    (dvdVmBits(command, 51, 4) === 6 ||
      dvdVmBits(command, 51, 4) === 8) &&
    dvdVmBits(command, 23, 2) === 3;

  const validateDvdVmCommand = (
    command: string,
    commandCount: number,
    context: {
      cellCount: number;
      currentTitleSetNumber: number;
      globalTitles: readonly GlobalDvdTitle[];
      managerProgramChainCount?: number;
      programCount: number;
      programChainCount: number;
    },
  ): void => {
    const validateLink = () => {
      const operation = dvdVmBits(command, 51, 4);
      if (operation === 1) {
        if (dvdVmBits(command, 4, 5) > 0x10) {
          throw new Error("DVD VM link command target is invalid");
        }
        return;
      }
      const target = operation === 4
        ? dvdVmBits(command, 14, 15)
        : operation === 5
        ? dvdVmBits(command, 9, 10)
        : operation === 6
        ? dvdVmBits(command, 6, 7)
        : operation === 7
        ? dvdVmBits(command, 7, 8)
        : 0;
      const maximum = operation === 4
        ? context.programChainCount
        : operation === 5
        ? Math.max(0, ...context.globalTitles
          .filter((title) =>
            title.titleSetNumber === context.currentTitleSetNumber
          )
          .map((title) => title.chapterCount))
        : operation === 6
        ? context.programCount
        : operation === 7
        ? context.cellCount
        : 0;
      if (target <= 0 || target > maximum) {
        throw new Error("DVD VM link command target is invalid");
      }
    };
    const validateJump = () => {
      const operation = dvdVmBits(command, 51, 4);
      if (operation === 1) {
        return;
      }
      if (operation === 2) {
        const titleNumber = dvdVmBits(command, 22, 7);
        if (titleNumber <= 0 || titleNumber > context.globalTitles.length) {
          throw new Error("DVD VM jump command target is invalid");
        }
        return;
      }
      if (operation === 3 || operation === 5) {
        const titleNumber = dvdVmBits(command, 22, 7);
        const title = context.globalTitles.find((candidate) =>
          candidate.titleSetNumber === context.currentTitleSetNumber &&
          candidate.titleSetTitleNumber === titleNumber
        );
        const partNumber = operation === 5
          ? dvdVmBits(command, 41, 10)
          : 1;
        if (
          title === undefined ||
          partNumber <= 0 ||
          partNumber > title.chapterCount
        ) {
          throw new Error("DVD VM jump command target is invalid");
        }
        return;
      }
      if (operation === 6 || operation === 8) {
        const targetKind = dvdVmBits(command, 23, 2);
        const resumeCell = operation === 8
          ? dvdVmBits(command, 31, 8)
          : 0;
        if (resumeCell > context.cellCount) {
          throw new Error("DVD VM call command target is invalid");
        }
        if (targetKind === 0) {
          return;
        }
        if (targetKind === 1) {
          const menuId = dvdVmBits(command, 19, 4);
          if (menuId < 2 || menuId > 7) {
            throw new Error("DVD VM menu command target is invalid");
          }
          return;
        }
        if (targetKind === 2) {
          const titleSetNumber = operation === 6
            ? dvdVmBits(command, 31, 8)
            : context.currentTitleSetNumber;
          const titleNumber = operation === 6
            ? dvdVmBits(command, 39, 8)
            : 1;
          const menuId = dvdVmBits(command, 19, 4);
          if (
            menuId < 2 ||
            menuId > 7 ||
            !context.globalTitles.some((title) =>
              title.titleSetNumber === titleSetNumber &&
              title.titleSetTitleNumber === titleNumber
            )
          ) {
            throw new Error("DVD VM menu command target is invalid");
          }
          return;
        }
        if (!dvdVmCommandTargetsManagerProgramChain(command)) {
          throw new Error("DVD VM jump command is unsupported");
        }
        const pgcNumber = dvdVmBits(command, 46, 15);
        if (
          pgcNumber <= 0 ||
          context.managerProgramChainCount === undefined ||
          pgcNumber > context.managerProgramChainCount
        ) {
          throw new Error("DVD VM program chain target is invalid");
        }
        return;
      }
      throw new Error("DVD VM jump command is unsupported");
    };

    const commandClass = dvdVmBits(command, 63, 3);
    if (commandClass === 0) {
      const operation = dvdVmBits(command, 51, 4);
      const line = dvdVmBits(command, 7, 8);
      if (
        operation > 3 ||
        (operation === 1 || operation === 3) &&
          (line <= 0 || line > commandCount)
      ) {
        throw new Error("DVD VM special command target is invalid");
      }
      return;
    }
    if (commandClass === 1) {
      if (dvdVmBits(command, 60, 1) === 1) {
        validateJump();
      } else {
        validateLink();
      }
      return;
    }
    if (commandClass === 2 || commandClass === 3) {
      if (dvdVmBits(command, 51, 4) !== 0) {
        validateLink();
      }
      return;
    }
    if (commandClass >= 4 && commandClass <= 6) {
      if (dvdVmBits(command, 4, 5) > 0x10) {
        throw new Error("DVD VM link command target is invalid");
      }
      return;
    }
    throw new Error("DVD VM command class is unsupported");
  };

  const validateProgramChainNavigation = (
    chain: DvdProgramChain,
    context: {
      currentTitleSetNumber: number;
      globalTitles: readonly GlobalDvdTitle[];
      managerProgramChainCount?: number;
      navigationSectors: ReadonlySet<number>;
      programChainCount: number;
    },
  ): void => {
    for (const cell of chain.cells) {
      const cellVobuStarts = [...context.navigationSectors]
        .filter((sector) =>
          sector >= cell.firstSector && sector <= cell.lastSector
        )
        .sort((left, right) => left - right);
      if (
        cellVobuStarts[0] !== cell.firstSector ||
        cellVobuStarts.at(-1) !== cell.lastVobuStartSector
      ) {
        throw new Error("DVD program chain VOBU relationships are malformed");
      }
    }
    for (const block of chain.commandBlocks) {
      for (const command of block.commands) {
        validateDvdVmCommand(command, block.commands.length, {
          cellCount: chain.cells.length,
          currentTitleSetNumber: context.currentTitleSetNumber,
          globalTitles: context.globalTitles,
          managerProgramChainCount: context.managerProgramChainCount,
          programCount: chain.programStartCells.length,
          programChainCount: context.programChainCount,
        });
      }
    }
  };

  const titleAssociationsBySourceAndSet = new Map<
    string,
    Promise<readonly {
      angleCount: number;
      sectors: readonly { firstSector: number; lastSector: number }[];
      titleNumber: number;
    }[]>
  >();
  const readTitleAssociations = (
    source: "iso" | "udf",
    titleSetNumber: number,
    titleVobSectorCount: number,
    managerProgramChainCount?: number,
  ) => {
    const key = `${source}:${titleSetNumber}:${titleVobSectorCount}:${managerProgramChainCount ?? "unknown"}`;
    const existing = titleAssociationsBySourceAndSet.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const associations = (async () => {
      const dvdFiles = source === "iso" ? isoDvdFiles : udfDvdFiles;
      const allGlobalTitles = await parseGlobalTitles(dvdFiles);
      const globalTitles = allGlobalTitles.filter(
        (title) => title.titleSetNumber === titleSetNumber,
      );
      if (globalTitles.length === 0) {
        throw new Error("DVD title-set has no global title references");
      }
      const ifoPath = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0.IFO`;
      const file = dvdFiles.get(ifoPath);
      if (file === undefined) {
        throw new Error("DVD title-set navigation file is missing");
      }
      const content = await readDvdFile(file, MAX_FILE_ENTRY_BYTES * 16);
      if (
        content.byteLength < DVD_SECTOR_SIZE_BYTES ||
        content.toString("ascii", 0, 12) !== "DVDVIDEO-VTS"
      ) {
        throw new Error("DVD title-set navigation file is malformed");
      }
      const pttOffset = content.readUInt32BE(0xc8) * DVD_SECTOR_SIZE_BYTES;
      const pgcitOffset = content.readUInt32BE(0xcc) * DVD_SECTOR_SIZE_BYTES;
      if (
        pttOffset < DVD_SECTOR_SIZE_BYTES ||
        pttOffset + 8 > content.byteLength ||
        pgcitOffset < DVD_SECTOR_SIZE_BYTES ||
        pgcitOffset + 8 > content.byteLength
      ) {
        throw new Error("DVD title traversal tables are missing");
      }
      const localTitleCount = content.readUInt16BE(pttOffset);
      const pttByteCount = content.readUInt32BE(pttOffset + 4) + 1;
      if (
        localTitleCount <= 0 ||
        localTitleCount > 99 ||
        content.readUInt16BE(pttOffset + 2) !== 0 ||
        pttByteCount < 8 + localTitleCount * 4 ||
        pttOffset + pttByteCount > content.byteLength ||
        globalTitles.length !== localTitleCount ||
        globalTitles.some((title) =>
          title.titleSetTitleNumber > localTitleCount
        )
      ) {
        throw new Error("DVD part-of-title table is malformed");
      }
      const titleParts: Array<readonly {
        pgcNumber: number;
        programNumber: number;
      }[]> = [];
      let previousPartOffset = 8 + localTitleCount * 4;
      for (let index = 0; index < localTitleCount; index += 1) {
        const partOffset = content.readUInt32BE(pttOffset + 8 + index * 4);
        const nextPartOffset = index + 1 < localTitleCount
          ? content.readUInt32BE(pttOffset + 8 + (index + 1) * 4)
          : pttByteCount;
        if (
          partOffset < previousPartOffset ||
          nextPartOffset <= partOffset ||
          nextPartOffset > pttByteCount ||
          (nextPartOffset - partOffset) % 4 !== 0
        ) {
          throw new Error("DVD part-of-title table is malformed");
        }
        const parts = [];
        for (let offset = partOffset; offset < nextPartOffset; offset += 4) {
          const pgcNumber = content.readUInt16BE(pttOffset + offset);
          const programNumber = content.readUInt16BE(pttOffset + offset + 2);
          if (pgcNumber <= 0 || programNumber <= 0) {
            throw new Error("DVD part-of-title table is malformed");
          }
          parts.push({ pgcNumber, programNumber });
        }
        titleParts.push(parts);
        previousPartOffset = nextPartOffset;
      }
      for (const title of globalTitles) {
        if (
          titleParts[title.titleSetTitleNumber - 1]?.length !==
            title.chapterCount
        ) {
          throw new Error("DVD title chapter relationships are malformed");
        }
      }

      const pgcCount = content.readUInt16BE(pgcitOffset);
      const pgcitByteCount = content.readUInt32BE(pgcitOffset + 4) + 1;
      if (
        pgcCount <= 0 ||
        pgcCount > 999 ||
        content.readUInt16BE(pgcitOffset + 2) !== 0 ||
        pgcitByteCount < 8 + pgcCount * 8 ||
        pgcitOffset + pgcitByteCount > content.byteLength
      ) {
        throw new Error("DVD program chain table is malformed");
      }
      const programChains = new Map<number, DvdProgramChain>();
      const programChainStarts = new Set<number>();
      for (let pgcNumber = 1; pgcNumber <= pgcCount; pgcNumber += 1) {
        const searchPointerOffset = pgcitOffset + 8 + (pgcNumber - 1) * 8;
        const pgcStartByte = content.readUInt32BE(searchPointerOffset + 4);
        if (programChainStarts.has(pgcStartByte)) {
          throw new Error("DVD program chain table is ambiguous");
        }
        programChainStarts.add(pgcStartByte);
        programChains.set(
          pgcNumber,
          parseProgramChain(
            content,
            pgcitOffset,
            pgcitByteCount,
            pgcStartByte,
            titleVobSectorCount,
          ),
        );
      }
      const navigationSectors = await readTitleVobuAddressMap(
        dvdFiles,
        titleSetNumber,
        titleVobSectorCount,
      );
      const targetsManagerProgramChain = [...programChains.values()].some(
        (chain) => chain.commandBlocks.some((block) =>
          block.commands.some(dvdVmCommandTargetsManagerProgramChain)
        )
      );
      const validatedManagerProgramChainCount =
        managerProgramChainCount ??
        (targetsManagerProgramChain
          ? await readManagerProgramChainCount(source)
          : undefined);
      for (const chain of programChains.values()) {
        validateProgramChainNavigation(chain, {
          currentTitleSetNumber: titleSetNumber,
          globalTitles: allGlobalTitles,
          managerProgramChainCount: validatedManagerProgramChainCount,
          navigationSectors,
          programChainCount: pgcCount,
        });
      }
      return globalTitles.map((title) => {
        const parts = titleParts[title.titleSetTitleNumber - 1]!;
        const sectors: Array<{ firstSector: number; lastSector: number }> = [];
        const seenPgcNumbers = new Set<number>();
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index]!;
          const chain = programChains.get(part.pgcNumber);
          if (
            chain === undefined ||
            part.programNumber > chain.programStartCells.length ||
            (seenPgcNumbers.has(part.pgcNumber) &&
              parts[index - 1]?.pgcNumber !== part.pgcNumber)
          ) {
            throw new Error("DVD title program relationships are malformed");
          }
          seenPgcNumbers.add(part.pgcNumber);
          const nextPart = parts[index + 1];
          if (
            nextPart?.pgcNumber === part.pgcNumber &&
            nextPart.programNumber <= part.programNumber
          ) {
            throw new Error("DVD title program relationships are malformed");
          }
          const firstCell = chain.programStartCells[part.programNumber - 1]!;
          const lastCell = nextPart?.pgcNumber === part.pgcNumber
            ? chain.programStartCells[nextPart.programNumber - 1]! - 1
            : chain.cells.length;
          if (lastCell < firstCell) {
            throw new Error("DVD title program relationships are malformed");
          }
          for (let cell = firstCell; cell <= lastCell; cell += 1) {
            const playback = chain.cells[cell - 1];
            if (playback === undefined) {
              throw new Error("DVD title cell relationships are malformed");
            }
            sectors.push({
              firstSector: playback.firstSector,
              lastSector: playback.lastSector,
            });
          }
        }
        const angleBlockLengths = [...seenPgcNumbers].flatMap((pgcNumber) =>
          programChains.get(pgcNumber)?.angleBlockLengths ?? []
        );
        if (
          angleBlockLengths.some((length) => length !== title.angleCount) ||
          (title.angleCount > 1 && angleBlockLengths.length === 0)
        ) {
          throw new Error("DVD title angle relationships are malformed");
        }
        return {
          angleCount: title.angleCount,
          sectors,
          titleNumber: title.titleNumber,
        };
      });
    })();
    titleAssociationsBySourceAndSet.set(key, associations);
    return associations;
  };

  const classifyTitleVobSector = async (
    extent: SectorExtent,
    badLba: number,
  ): Promise<{
    evidenceKey: string;
    outcome: "navigation";
  } | {
    evidenceKey: string;
    outcome: "payload";
    affectedTitleNumbers: readonly number[];
    titleSetNumber: number;
  } | { outcome: "ambiguous" }> => {
    if (
      extent.fileLocation === undefined
    ) {
      return { outcome: "ambiguous" };
    }
    const identity = titleVobIdentity(extent.fileLocation.path);
    if (identity === null) {
      return { outcome: "ambiguous" };
    }
    const dvdFiles = extent.fileLocation.source === "iso"
      ? isoDvdFiles
      : udfDvdFiles;
    const titleParts = [...dvdFiles.values()]
      .map((file) => ({ file, identity: titleVobIdentity(file.path) }))
      .filter(({ identity: partIdentity }) =>
        partIdentity?.titleSetNumber === identity.titleSetNumber
      )
      .sort((left, right) =>
        left.identity!.partNumber - right.identity!.partNumber
      );
    if (
      titleParts.length === 0 ||
      titleParts.some(({ file, identity: partIdentity }, index) =>
        partIdentity!.partNumber !== index + 1 ||
        file.byteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
        file.extents.length === 0 ||
        file.extents.some(({ byteCount }) =>
          byteCount % DVD_SECTOR_SIZE_BYTES !== 0
        )
      )
    ) {
      return { outcome: "ambiguous" };
    }
    const currentPartIndex = titleParts.findIndex(({ identity: partIdentity }) =>
      partIdentity!.partNumber === identity.partNumber
    );
    if (currentPartIndex === -1) {
      return { outcome: "ambiguous" };
    }
    const precedingSectorCount = titleParts
      .slice(0, currentPartIndex)
      .reduce(
        (total, { file }) => total + file.byteCount / DVD_SECTOR_SIZE_BYTES,
        0,
      );
    const titleVobSector = precedingSectorCount +
      extent.fileLocation.sectorOffset + badLba - extent.startLba;
    const titleVobSectorCount = titleParts.reduce(
      (total, { file }) => total + file.byteCount / DVD_SECTOR_SIZE_BYTES,
      0,
    );
    if (
      !Number.isSafeInteger(titleVobSector) ||
      titleVobSector < 0 ||
      titleVobSector >= titleVobSectorCount
    ) {
      return { outcome: "ambiguous" };
    }
    const ifoPath = `VIDEO_TS/VTS_${String(identity.titleSetNumber).padStart(2, "0")}_0.IFO`;
    if (!dvdFiles.has(ifoPath)) {
      return { outcome: "ambiguous" };
    }
    const navigationSectors = await readTitleVobuAddressMap(
      dvdFiles,
      identity.titleSetNumber,
      titleVobSectorCount,
    );
    const titleAssociations = await readTitleAssociations(
      extent.fileLocation.source,
      identity.titleSetNumber,
      titleVobSectorCount,
    );
    const affectedTitleNumbers = titleAssociations
      .filter(({ sectors }) => sectors.some(({ firstSector, lastSector }) =>
        titleVobSector >= firstSector && titleVobSector <= lastSector
      ))
      .map(({ titleNumber }) => titleNumber)
      .sort((left, right) => left - right);
    if (affectedTitleNumbers.length === 0) {
      return { outcome: "ambiguous" };
    }
    const layout = titleParts.map(({ file }) => ({
      byteCount: file.byteCount,
      extents: file.extents.reduce<Array<{
        sectorCount: number;
        startLba: number;
      }>>((normalized, fileExtent) => {
        const sectorCount = fileExtent.byteCount / DVD_SECTOR_SIZE_BYTES;
        const previous = normalized.at(-1);
        if (
          previous !== undefined &&
          previous.startLba + previous.sectorCount === fileExtent.startLba
        ) {
          previous.sectorCount += sectorCount;
        } else {
          normalized.push({ sectorCount, startLba: fileExtent.startLba });
        }
        return normalized;
      }, []),
      path: file.path,
    }));
    const evidenceKey = JSON.stringify({
      damagedPath: extent.fileLocation.path,
      layout,
      navigationSectors: [...navigationSectors],
      affectedTitleNumbers,
      titleSetNumber: identity.titleSetNumber,
      titleVobSector,
    });
    return navigationSectors.has(titleVobSector)
      ? { evidenceKey, outcome: "navigation" }
      : {
          evidenceKey,
          outcome: "payload",
          affectedTitleNumbers,
          titleSetNumber: identity.titleSetNumber,
        };
  };

  const parseIsoPathTable = (
    content: Buffer,
    byteOrder: "big-endian" | "little-endian",
  ): readonly IsoDirectoryLayout[] => {
    const layouts: IsoDirectoryLayout[] = [];
    const paths = new Set<string>();
    let offset = 0;
    while (offset < content.byteLength) {
      const identifierLength = content[offset]!;
      const entryByteCount = 8 + identifierLength + identifierLength % 2;
      if (
        identifierLength <= 0 ||
        entryByteCount <= 8 ||
        offset + entryByteCount > content.byteLength ||
        layouts.length >= MAX_DIRECTORY_ENTRIES
      ) {
        throw new Error("DVD ISO path table is malformed");
      }
      const readUInt32 = byteOrder === "little-endian"
        ? content.readUInt32LE.bind(content)
        : content.readUInt32BE.bind(content);
      const readUInt16 = byteOrder === "little-endian"
        ? content.readUInt16LE.bind(content)
        : content.readUInt16BE.bind(content);
      const directoryNumber = layouts.length + 1;
      const parentDirectoryNumber = readUInt16(offset + 6);
      const identifier = content.subarray(offset + 8, offset + 8 + identifierLength);
      let path: string;
      if (directoryNumber === 1) {
        if (
          identifierLength !== 1 ||
          identifier[0] !== 0 ||
          parentDirectoryNumber !== 1
        ) {
          throw new Error("DVD ISO path table root is malformed");
        }
        path = "";
      } else {
        if (
          parentDirectoryNumber <= 0 ||
          parentDirectoryNumber >= directoryNumber ||
          identifier.some((byte) => byte < 0x20 || byte > 0x7e)
        ) {
          throw new Error("DVD ISO path table hierarchy is malformed");
        }
        const parent = layouts[parentDirectoryNumber - 1];
        const name = identifier.toString("ascii");
        if (
          parent === undefined ||
          name.includes("/") ||
          name.includes("\0")
        ) {
          throw new Error("DVD ISO path table hierarchy is malformed");
        }
        path = `${parent.path}/${name}`.replace(/^\/+/, "");
      }
      if (paths.has(path)) {
        throw new Error("DVD ISO path table is ambiguous");
      }
      paths.add(path);
      layouts.push({
        extendedAttributeSectorCount: content[offset + 1]!,
        extentLba: readUInt32(offset + 2),
        path,
      });
      offset += entryByteCount;
    }
    return layouts;
  };

  const parseIso = async (): Promise<{
    hasIso: boolean;
    volumeSpaceSize: number;
  }> => {
    let primaryVolumeDescriptor: Buffer | undefined;
    const filesystemDescriptors: Buffer[] = [];
    let volumeDescriptorCount = 0;
    let sawTerminator = false;
    for (let lba = 16; lba < 16 + MAX_DESCRIPTOR_SECTORS; lba += 1) {
      const descriptor = await readRawSector(lba);
      if (descriptor.toString("ascii", 1, 6) !== "CD001" ||
        descriptor[6] !== 1) {
        if (volumeDescriptorCount === 0) {
          continue;
        }
        throw new Error("DVD ISO volume descriptor sequence is malformed");
      }
      classifyBeforeMetadataRead(lba, 1);
      volumeDescriptorCount += 1;
      const type = descriptor[0]!;
      if (type !== 1 && type !== 2 && type !== 255) {
        throw new Error("DVD ISO volume layout is unsupported");
      }
      if (type === 1) {
        if (primaryVolumeDescriptor !== undefined) {
          throw new Error("DVD ISO has multiple primary volume descriptors");
        }
        primaryVolumeDescriptor = descriptor;
      }
      if (type === 1 || type === 2) {
        filesystemDescriptors.push(descriptor);
      }
      if (type === 255) {
        sawTerminator = true;
        break;
      }
    }
    if (volumeDescriptorCount === 0) {
      return { hasIso: false, volumeSpaceSize: 0 };
    }
    if (primaryVolumeDescriptor === undefined) {
      if (badSectors.size > 0 && [...badSectors].some((lba) =>
        lba >= 16 && lba < 16 + MAX_DESCRIPTOR_SECTORS
      )) {
        throw new ClassifiedDamageError("filesystem_metadata");
      }
      throw new Error("DVD ISO primary volume descriptor is missing");
    }
    if (!sawTerminator) {
      throw new Error("DVD ISO volume descriptor sequence is malformed");
    }
    const volumeSpaceSize = primaryVolumeDescriptor.readUInt32LE(80);
    if (
      volumeSpaceSize !== primaryVolumeDescriptor.readUInt32BE(84) ||
      volumeSpaceSize <= 0 ||
      volumeSpaceSize > totalSectorCount ||
      primaryVolumeDescriptor.readUInt16LE(128) !== DVD_SECTOR_SIZE_BYTES ||
      primaryVolumeDescriptor.readUInt16BE(130) !== DVD_SECTOR_SIZE_BYTES
    ) {
      throw new Error("DVD ISO volume geometry is invalid");
    }
    recordReferencedExtent(0, volumeSpaceSize);
    for (const descriptor of filesystemDescriptors) {
      if (
        descriptor.readUInt32LE(80) !== volumeSpaceSize ||
        descriptor.readUInt32BE(84) !== volumeSpaceSize ||
        descriptor.readUInt16LE(128) !== DVD_SECTOR_SIZE_BYTES ||
        descriptor.readUInt16BE(130) !== DVD_SECTOR_SIZE_BYTES
      ) {
        throw new Error("DVD ISO filesystem descriptor geometry is invalid");
      }
      const pathTableBytes = descriptor.readUInt32LE(132);
      const pathTableBytesBe = descriptor.readUInt32BE(136);
      if (pathTableBytes !== pathTableBytesBe || pathTableBytes <= 0) {
        throw new Error("DVD ISO path table is invalid");
      }
      const pathTableSectorCount = sectorCountForBytes(pathTableBytes);
      const pathTableLocations = [
        {
          byteOrder: "little-endian" as const,
          lba: descriptor.readUInt32LE(140),
          required: true,
        },
        {
          byteOrder: "little-endian" as const,
          lba: descriptor.readUInt32LE(144),
          required: false,
        },
        {
          byteOrder: "big-endian" as const,
          lba: descriptor.readUInt32BE(148),
          required: true,
        },
        {
          byteOrder: "big-endian" as const,
          lba: descriptor.readUInt32BE(152),
          required: false,
        },
      ];
      const parsedPathTables: Array<readonly IsoDirectoryLayout[]> = [];
      for (const { byteOrder, lba, required } of pathTableLocations) {
        if (lba === 0) {
          if (required) {
            throw new Error("DVD ISO path table copy is missing");
          }
          continue;
        }
        try {
          requireSafeExtent(lba, pathTableSectorCount, volumeSpaceSize);
        } catch {
          throw new Error("DVD ISO path table is outside the volume");
        }
        const pathTable = await readExtent(
          lba,
          pathTableBytes,
          "filesystem_metadata",
          MAX_DIRECTORY_BYTES,
        );
        parsedPathTables.push(parseIsoPathTable(pathTable, byteOrder));
      }
      if (
        parsedPathTables.length < 2 ||
        parsedPathTables.some((pathTable) =>
          JSON.stringify(pathTable) !== JSON.stringify(parsedPathTables[0])
        )
      ) {
        throw new Error("DVD ISO path table copies disagree");
      }
      const rootRecord = descriptor.subarray(156);
      if (rootRecord[0]! < 34) {
        throw new Error("DVD ISO root directory record is invalid");
      }
      const rootLba = rootRecord.readUInt32LE(2);
      const rootBytes = rootRecord.readUInt32LE(10);
      const rootExtendedAttributeSectorCount = rootRecord[1]!;
      if (
        rootLba !== rootRecord.readUInt32BE(6) ||
        rootBytes !== rootRecord.readUInt32BE(14) ||
        rootBytes <= 0
      ) {
        throw new Error("DVD ISO root directory extent is invalid");
      }
      try {
        requireSafeExtent(
          rootLba,
          rootExtendedAttributeSectorCount + sectorCountForBytes(rootBytes),
          volumeSpaceSize,
        );
      } catch {
        throw new Error("DVD ISO root directory extent is invalid");
      }
      if (rootExtendedAttributeSectorCount > 0) {
        addExtent(
          rootLba,
          rootExtendedAttributeSectorCount,
          "filesystem_metadata",
        );
      }
      const directoryLayouts = new Map<string, IsoDirectoryLayout>();
      await parseIsoDirectory(
        rootLba + rootExtendedAttributeSectorCount,
        rootBytes,
        "",
        new Set(),
        directoryLayouts,
        rootLba,
        rootExtendedAttributeSectorCount,
        volumeSpaceSize,
      );
      const pathTableLayouts = parsedPathTables[0]!;
      for (const layout of pathTableLayouts) {
        try {
          requireSafeExtent(
            layout.extentLba,
            layout.extendedAttributeSectorCount + 1,
            volumeSpaceSize,
          );
        } catch {
          throw new Error("DVD ISO path table directory is outside the volume");
        }
        recordReferencedExtent(
          layout.extentLba,
          layout.extendedAttributeSectorCount + 1,
        );
      }
      if (
        pathTableLayouts.length !== directoryLayouts.size ||
        pathTableLayouts.some((layout) =>
          JSON.stringify(directoryLayouts.get(layout.path)) !==
            JSON.stringify(layout)
        )
      ) {
        throw new Error("DVD ISO path table and directory tree disagree");
      }
    }
    return { hasIso: true, volumeSpaceSize };
  };

  const partitionAbsoluteLba = (
    descriptor: UdfLongAllocationDescriptor,
    partitionsByReference: readonly UdfPartition[],
  ): number => {
    const partition = partitionsByReference[descriptor.partitionReferenceNumber];
    const extentSectorCount = sectorCountForBytes(descriptor.extentLength);
    if (
      partition === undefined ||
      descriptor.extentType !== 0 ||
      descriptor.extentLength <= 0 ||
      !Number.isSafeInteger(
        descriptor.logicalBlockNumber + extentSectorCount,
      ) ||
      descriptor.logicalBlockNumber + extentSectorCount > partition.sectorCount
    ) {
      throw new Error("DVD UDF partition address is invalid");
    }
    return partition.startLba + descriptor.logicalBlockNumber;
  };

  const parseUdf = async (): Promise<{
    damagedRecognition: boolean;
    hasUdf: boolean;
    partitions: readonly UdfPartition[];
  }> => {
    const recognitionDescriptors: Array<{ lba: number; identifier: string }> = [];
    for (let lba = 16; lba < 16 + 32; lba += 1) {
      const descriptor = await readRawSector(lba);
      recognitionDescriptors.push({
        lba,
        identifier: descriptor.toString("ascii", 1, 6),
      });
    }
    const nsrIndex = recognitionDescriptors.findIndex(({ identifier }) =>
      identifier === "NSR02" || identifier === "NSR03"
    );
    if (nsrIndex === -1) {
      if (recognitionDescriptors.some(({ identifier }) =>
        identifier === "BEA01" || identifier === "TEA01"
      )) {
        throw new Error("DVD UDF recognition sequence is incomplete");
      }
      return {
        damagedRecognition: recognitionDescriptors.some(({ lba }) =>
          badSectors.has(lba)
        ),
        hasUdf: false,
        partitions: [],
      };
    }
    let beginningIndex = -1;
    for (let index = 0; index <= nsrIndex; index += 1) {
      if (recognitionDescriptors[index]!.identifier === "BEA01") {
        beginningIndex = index;
      }
    }
    const relativeTerminatorIndex = recognitionDescriptors
      .slice(nsrIndex + 1)
      .findIndex(({ identifier }) => identifier === "TEA01");
    if (beginningIndex === -1 || relativeTerminatorIndex === -1) {
      if (recognitionDescriptors.some(({ lba }) => badSectors.has(lba))) {
        throw new ClassifiedDamageError("filesystem_metadata");
      }
      throw new Error("DVD UDF recognition sequence is incomplete");
    }
    const terminatorIndex = nsrIndex + 1 + relativeTerminatorIndex;
    classifyBeforeMetadataRead(
      recognitionDescriptors[beginningIndex]!.lba,
      recognitionDescriptors[terminatorIndex]!.lba -
        recognitionDescriptors[beginningIndex]!.lba + 1,
    );
    if (totalSectorCount <= 256) {
      throw new Error("DVD UDF image is too small");
    }
    const anchor = await readSector(256);
    validateUdfTag(anchor, [2]);
    const alternateAnchorLbas = [...new Set([
      totalSectorCount - 257,
      totalSectorCount - 1,
    ])].filter((lba) => lba >= 0 && lba !== 256);
    await policy.validateUdfAlternateAnchors({
      anchor,
      alternateAnchorLbas,
      classifyAnchor: (lba) => classifyBeforeMetadataRead(lba, 1),
      readRawAnchor: readRawSector,
    });
    const mainSequenceLength = anchor.readUInt32LE(16);
    const mainSequenceStart = anchor.readUInt32LE(20);
    const reserveSequenceLength = anchor.readUInt32LE(24);
    const reserveSequenceStart = anchor.readUInt32LE(28);
    const mainSequenceSectors = sectorCountForBytes(mainSequenceLength);
    const reserveSequenceSectors = sectorCountForBytes(reserveSequenceLength);
    if (
      mainSequenceSectors > MAX_DESCRIPTOR_SECTORS ||
      reserveSequenceSectors > MAX_DESCRIPTOR_SECTORS
    ) {
      throw new Error(
        "DVD UDF volume descriptor sequence exceeds its safety bound",
      );
    }
    policy.validateUdfDescriptorSequenceLengths(
      mainSequenceSectors,
      reserveSequenceSectors,
    );
    classifyBeforeMetadataRead(mainSequenceStart, mainSequenceSectors);
    classifyBeforeMetadataRead(reserveSequenceStart, reserveSequenceSectors);

    const parseVolumeDescriptorSequence = async (
      sequenceStartLba: number,
      sequenceSectorCount: number,
      sequenceName: "main" | "reserve",
    ): Promise<{
      descriptorBodies: readonly string[];
      logicalVolume: UdfLogicalVolume;
      partitions: ReadonlyMap<number, UdfPartition>;
    }> => {
      const sequencePartitions = new Map<number, UdfPartition>();
      const descriptorBodies: string[] = [];
      let sequenceLogicalVolume: UdfLogicalVolume | undefined;
      let sawTerminator = false;
      for (let index = 0; index < sequenceSectorCount; index += 1) {
        const descriptor = await readSector(sequenceStartLba + index);
        const identifier = validateUdfTag(
          descriptor,
          [1, 3, 4, 5, 6, 7, 8, 9],
        );
        if (identifier === 8) {
          sawTerminator = true;
          break;
        }
        if (identifier === 3) {
          throw new Error(
            "DVD UDF volume descriptor continuation is unsupported",
          );
        }
        descriptorBodies.push(
          `${identifier}:${descriptor.subarray(16).toString("base64")}`,
        );
        if (identifier === 5) {
          const partition: UdfPartition = {
            number: descriptor.readUInt16LE(22),
            startLba: descriptor.readUInt32LE(188),
            sectorCount: descriptor.readUInt32LE(192),
          };
          recordReferencedExtent(partition.startLba, partition.sectorCount);
          if (sequencePartitions.has(partition.number)) {
            throw new Error("DVD UDF partition number is duplicated");
          }
          sequencePartitions.set(partition.number, partition);
          for (const headerOffset of [56, 64, 72, 80, 88]) {
            const rawLength = descriptor.readUInt32LE(headerOffset);
            const extentLength = rawLength & UDF_EXTENT_LENGTH_MASK;
            if ((rawLength & UDF_EXTENT_TYPE_MASK) !== 0) {
              throw new Error(
                "DVD UDF partition metadata extent is unsupported",
              );
            }
            if (extentLength === 0) {
              continue;
            }
            const relativeLba = descriptor.readUInt32LE(headerOffset + 4);
            const sectorCount = sectorCountForBytes(extentLength);
            if (relativeLba + sectorCount > partition.sectorCount) {
              throw new Error("DVD UDF partition metadata extent is invalid");
            }
            addExtent(
              partition.startLba + relativeLba,
              sectorCount,
              "filesystem_metadata",
            );
          }
        } else if (identifier === 6) {
          if (
            sequenceLogicalVolume !== undefined ||
            descriptor.readUInt32LE(212) !== DVD_SECTOR_SIZE_BYTES
          ) {
            throw new Error("DVD UDF logical volume is unsupported");
          }
          const mapTableLength = descriptor.readUInt32LE(264);
          const numberOfPartitionMaps = descriptor.readUInt32LE(268);
          if (
            numberOfPartitionMaps <= 0 ||
            numberOfPartitionMaps > 16 ||
            mapTableLength <= 0 ||
            440 + mapTableLength > descriptor.byteLength
          ) {
            throw new Error("DVD UDF partition map is invalid");
          }
          const partitionNumbersByReference: number[] = [];
          let mapOffset = 440;
          while (mapOffset < 440 + mapTableLength) {
            const mapType = descriptor[mapOffset]!;
            const mapLength = descriptor[mapOffset + 1]!;
            if (
              mapType !== 1 ||
              mapLength !== 6 ||
              mapOffset + mapLength > 440 + mapTableLength
            ) {
              throw new Error("DVD UDF partition map type is unsupported");
            }
            partitionNumbersByReference.push(
              descriptor.readUInt16LE(mapOffset + 4),
            );
            mapOffset += mapLength;
          }
          if (partitionNumbersByReference.length !== numberOfPartitionMaps) {
            throw new Error("DVD UDF partition map count is invalid");
          }
          sequenceLogicalVolume = {
            fileSetDescriptor: readUdfLongAllocationDescriptor(
              descriptor,
              248,
            ),
            integritySequenceLength: descriptor.readUInt32LE(432),
            integritySequenceStartLba: descriptor.readUInt32LE(436),
            partitionNumbersByReference,
          };
        }
      }
      if (
        !sawTerminator ||
        sequenceLogicalVolume === undefined ||
        sequencePartitions.size === 0
      ) {
        throw new Error(
          `DVD UDF ${sequenceName} volume descriptor sequence is incomplete`,
        );
      }
      return {
        descriptorBodies,
        logicalVolume: sequenceLogicalVolume,
        partitions: sequencePartitions,
      };
    };
    const mainSequence = await parseVolumeDescriptorSequence(
      mainSequenceStart,
      mainSequenceSectors,
      "main",
    );
    const reserveSequence = await parseVolumeDescriptorSequence(
      reserveSequenceStart,
      reserveSequenceSectors,
      "reserve",
    );
    if (
      JSON.stringify(mainSequence.descriptorBodies) !==
        JSON.stringify(reserveSequence.descriptorBodies)
    ) {
      throw new Error("DVD UDF main and reserve descriptor sequences disagree");
    }
    const partitions = mainSequence.partitions;
    const logicalVolume = mainSequence.logicalVolume;
    const orderedPartitions = [...partitions.values()].sort((left, right) =>
      left.startLba - right.startLba
    );
    for (let index = 1; index < orderedPartitions.length; index += 1) {
      const previous = orderedPartitions[index - 1]!;
      const current = orderedPartitions[index]!;
      if (current.startLba < previous.startLba + previous.sectorCount) {
        throw new Error("DVD UDF partitions overlap ambiguously");
      }
    }
    const partitionsByReference = logicalVolume.partitionNumbersByReference.map(
      (partitionNumber) => {
        const partition = partitions.get(partitionNumber);
        if (partition === undefined) {
          throw new Error("DVD UDF partition map has no descriptor");
        }
        return partition;
      },
    );
    if (logicalVolume.integritySequenceLength <= 0) {
      throw new Error("DVD UDF integrity sequence is missing");
    }
    let integritySequenceStart = logicalVolume.integritySequenceStartLba;
    let integritySequenceLength = logicalVolume.integritySequenceLength;
    for (let extentIndex = 0; extentIndex < 16; extentIndex += 1) {
      const integritySectorCount = sectorCountForBytes(integritySequenceLength);
      if (integritySectorCount > MAX_DESCRIPTOR_SECTORS) {
        throw new Error(
          "DVD UDF integrity sequence exceeds its safety bound",
        );
      }
      classifyBeforeMetadataRead(integritySequenceStart, integritySectorCount);
      let nextStart = 0;
      let nextLength = 0;
      let sawIntegrityDescriptor = false;
      for (let index = 0; index < integritySectorCount; index += 1) {
        const descriptor = await readSector(integritySequenceStart + index);
        const identifier = validateUdfTag(descriptor, [8, 9]);
        if (identifier === 8) {
          break;
        }
        sawIntegrityDescriptor = true;
        nextLength = descriptor.readUInt32LE(32);
        nextStart = descriptor.readUInt32LE(36);
      }
      if (!sawIntegrityDescriptor) {
        throw new Error("DVD UDF integrity sequence is invalid");
      }
      if (nextLength === 0) {
        break;
      }
      integritySequenceStart = nextStart;
      integritySequenceLength = nextLength;
      if (extentIndex === 15) {
        throw new Error("DVD UDF integrity sequence exceeds its safety bound");
      }
    }
    const fileSetLba = partitionAbsoluteLba(
      logicalVolume.fileSetDescriptor,
      partitionsByReference,
    );
    if (logicalVolume.fileSetDescriptor.extentLength < 512) {
      throw new Error("DVD UDF file set descriptor extent is truncated");
    }
    const fileSetDescriptor = await readExtent(
      fileSetLba,
      logicalVolume.fileSetDescriptor.extentLength,
      "filesystem_metadata",
      MAX_FILE_ENTRY_BYTES,
    );
    validateUdfTag(fileSetDescriptor, [256]);
    const rootIcb = readUdfLongAllocationDescriptor(fileSetDescriptor, 400);

    const visitedIcbs = new Set<string>();
    const parseUdfNode = async (
      icb: UdfLongAllocationDescriptor,
      path: string,
      depth = 0,
    ): Promise<void> => {
      if (depth > MAX_DIRECTORY_DEPTH) {
        throw new Error("DVD UDF directory depth exceeds its safety bound");
      }
      if (icb.extentType !== 0 || icb.extentLength <= 0) {
        throw new Error("DVD UDF ICB extent is unsupported");
      }
      const icbLba = partitionAbsoluteLba(icb, partitionsByReference);
      const key = `${icb.partitionReferenceNumber}:${icb.logicalBlockNumber}`;
      if (visitedIcbs.has(key)) {
        throw new Error("DVD UDF allocation graph is cyclic or ambiguous");
      }
      visitedIcbs.add(key);
      const fileEntry = await readExtent(
        icbLba,
        icb.extentLength,
        "filesystem_metadata",
        MAX_FILE_ENTRY_BYTES,
      );
      const identifier = validateUdfTag(fileEntry, [261, 266]);
      const fileType = fileEntry[27]!;
      const allocationType = fileEntry.readUInt16LE(34) & 0x0007;
      const informationLengthBigInt = fileEntry.readBigUInt64LE(56);
      if (informationLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("DVD UDF file length is invalid");
      }
      const informationLength = Number(informationLengthBigInt);
      const extendedAttributeLengthOffset = identifier === 261 ? 168 : 208;
      const allocationDescriptorLengthOffset = identifier === 261 ? 172 : 212;
      const descriptorBaseOffset = identifier === 261 ? 176 : 216;
      const extendedAttributeLength = fileEntry.readUInt32LE(
        extendedAttributeLengthOffset,
      );
      const allocationDescriptorLength = fileEntry.readUInt32LE(
        allocationDescriptorLengthOffset,
      );
      const allocationOffset = descriptorBaseOffset + extendedAttributeLength;
      if (
        allocationOffset + allocationDescriptorLength > fileEntry.byteLength ||
        informationLength > retainedByteCount
      ) {
        throw new Error("DVD UDF file entry is malformed");
      }
      const isDirectory = fileType === 4;
      if (!isDirectory && fileType !== 5) {
        throw new Error("DVD UDF file type is unsupported");
      }
      const normalizedPath = path.toUpperCase();
      const dataExtents: Array<{ startLba: number; byteCount: number }> = [];
      let fileByteOffset = 0;
      if (allocationType === 3) {
        if (allocationDescriptorLength < informationLength) {
          throw new Error("DVD UDF embedded file data is truncated");
        }
      } else {
        const descriptorSize = allocationType === 0
          ? 8
          : allocationType === 1
          ? 16
          : allocationType === 2
          ? 20
          : 0;
        if (descriptorSize === 0 ||
          allocationDescriptorLength % descriptorSize !== 0) {
          throw new Error("DVD UDF allocation descriptors are unsupported");
        }
        for (
          let offset = allocationOffset;
          offset < allocationOffset + allocationDescriptorLength;
          offset += descriptorSize
        ) {
          const rawLength = fileEntry.readUInt32LE(offset);
          const extentLength = rawLength & UDF_EXTENT_LENGTH_MASK;
          const extentType = rawLength & UDF_EXTENT_TYPE_MASK;
          if (extentLength === 0) {
            continue;
          }
          if (extentType !== 0) {
            throw new Error("DVD UDF continuation or sparse extent is unsupported");
          }
          const logicalBlockNumber = allocationType === 0
            ? fileEntry.readUInt32LE(offset + 4)
            : allocationType === 1
            ? fileEntry.readUInt32LE(offset + 4)
            : fileEntry.readUInt32LE(offset + 12);
          const partitionReferenceNumber = allocationType === 0
            ? icb.partitionReferenceNumber
            : allocationType === 1
            ? fileEntry.readUInt16LE(offset + 8)
            : fileEntry.readUInt16LE(offset + 16);
          const startLba = partitionAbsoluteLba(
            {
              extentLength,
              extentType,
              logicalBlockNumber,
              partitionReferenceNumber,
            },
            partitionsByReference,
          );
          dataExtents.push({ startLba, byteCount: extentLength });
          const extentReason = isDirectory
            ? "directory_data"
            : classifyDvdPath(path);
          const fileSectorOffset = fileByteOffset % DVD_SECTOR_SIZE_BYTES === 0
            ? fileByteOffset / DVD_SECTOR_SIZE_BYTES
            : undefined;
          addExtent(
            startLba,
            sectorCountForBytes(extentLength),
            extentReason,
            !isDirectory && fileSectorOffset !== undefined
              ? {
                  path: normalizedPath,
                  sectorOffset: fileSectorOffset,
                  source: "udf",
                }
              : undefined,
          );
          fileByteOffset += extentLength;
        }
      }
      if (!isDirectory) {
        udfDvdPaths.add(normalizedPath);
        const fileLayout = {
          byteCount: informationLength,
          embedded: allocationType === 3,
          extents: dataExtents,
          path: normalizedPath,
        } satisfies DvdFileLayout;
        const existingFile = udfDvdFiles.get(normalizedPath);
        if (
          existingFile !== undefined &&
          JSON.stringify(existingFile) !== JSON.stringify(fileLayout)
        ) {
          throw new Error("DVD UDF file layout is ambiguous");
        }
        udfDvdFiles.set(normalizedPath, fileLayout);
        return;
      }

      let directory: Buffer;
      if (allocationType === 3) {
        directory = fileEntry.subarray(
          allocationOffset,
          allocationOffset + informationLength,
        );
      } else {
        if (informationLength > MAX_DIRECTORY_BYTES) {
          throw new Error("DVD UDF directory exceeds its safety bound");
        }
        directory = Buffer.alloc(informationLength);
        let written = 0;
        for (const extent of dataExtents) {
          const bytesToRead = Math.min(
            extent.byteCount,
            informationLength - written,
          );
          if (bytesToRead <= 0) {
            break;
          }
          const content = await readExtent(
            extent.startLba,
            bytesToRead,
            "directory_data",
            MAX_DIRECTORY_BYTES,
          );
          content.copy(directory, written);
          written += bytesToRead;
        }
        if (written !== informationLength) {
          throw new Error("DVD UDF directory data is incomplete");
        }
      }
      let offset = 0;
      while (offset < directory.byteLength) {
        if (offset + 38 > directory.byteLength) {
          throw new Error("DVD UDF directory entry is truncated");
        }
        const descriptor = directory.subarray(offset);
        validateUdfTag(descriptor, [257]);
        udfDirectoryEntryCount += 1;
        if (udfDirectoryEntryCount > MAX_DIRECTORY_ENTRIES) {
          throw new Error("DVD UDF directory entry count exceeds its bound");
        }
        const fileCharacteristics = descriptor[18]!;
        const fileIdentifierLength = descriptor[19]!;
        const implementationUseLength = descriptor.readUInt16LE(36);
        const recordLength = Math.ceil(
          (38 + implementationUseLength + fileIdentifierLength) / 4,
        ) * 4;
        if (recordLength <= 0 || offset + recordLength > directory.byteLength) {
          throw new Error("DVD UDF directory entry length is invalid");
        }
        if ((fileCharacteristics & 0x0c) === 0) {
          const name = decodeOstaCompressedUnicode(
            descriptor.subarray(
              38 + implementationUseLength,
              38 + implementationUseLength + fileIdentifierLength,
            ),
          );
          if (name.length === 0 || name.includes("/") || name.includes("\0")) {
            throw new Error("DVD UDF file identifier is invalid");
          }
          await parseUdfNode(
            readUdfLongAllocationDescriptor(descriptor, 20),
            `${path}/${name}`.replace(/^\/+/, ""),
            depth + 1,
          );
        }
        offset += recordLength;
      }
    };
    await parseUdfNode(rootIcb, "");
    return {
      damagedRecognition: false,
      hasUdf: true,
      partitions: partitionsByReference,
    };
  };

  const validateFileExtentOverlaps = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    source: "ISO" | "UDF",
  ) => {
    const extents = [...dvdFiles.values()].flatMap((file) => {
      const allocatedByteCount = file.extents.reduce(
        (total, extent) => total + extent.byteCount,
        0,
      );
      if (file.embedded || file.byteCount === 0) {
        if (file.extents.length > 0) {
          throw new Error(`DVD ${source} file layout is ambiguous`);
        }
        return [];
      }
      if (
        file.extents.length === 0 ||
        allocatedByteCount < file.byteCount
      ) {
        throw new Error(`DVD ${source} file layout is incomplete`);
      }
      return file.extents.map((extent) => {
        const sectorCount = sectorCountForBytes(extent.byteCount);
        requireSafeExtent(extent.startLba, sectorCount, totalSectorCount);
        return {
          endLba: extent.startLba + sectorCount,
          path: file.path,
          startLba: extent.startLba,
        };
      });
    }).sort((left, right) =>
      left.startLba - right.startLba || left.endLba - right.endLba ||
      left.path.localeCompare(right.path)
    );
    for (let leftIndex = 0; leftIndex < extents.length; leftIndex += 1) {
      const left = extents[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < extents.length;
        rightIndex += 1
      ) {
        const right = extents[rightIndex]!;
        if (right.startLba >= left.endLba) {
          break;
        }
        if (
          right.startLba !== left.startLba ||
          right.endLba !== left.endLba
        ) {
          throw new Error(
            `DVD ${source} file extents overlap ambiguously`,
          );
        }
      }
    }
  };

  const validateFilesDoNotOverlapStructures = () => {
    const fileExtents = allocatedExtents.filter((extent) =>
      extent.fileLocation !== undefined
    );
    const structuralExtents = allocatedExtents.filter((extent) =>
      extent.fileLocation === undefined
    );
    for (const fileExtent of fileExtents) {
      const fileEndLba = fileExtent.startLba + fileExtent.sectorCount;
      if (structuralExtents.some((structuralExtent) => {
        const structuralEndLba = structuralExtent.startLba +
          structuralExtent.sectorCount;
        return fileExtent.startLba < structuralEndLba &&
          structuralExtent.startLba < fileEndLba;
      })) {
        throw new Error("DVD file and filesystem structures overlap ambiguously");
      }
    }
  };

  const canonicalDvdVideoLayout = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
  ) => JSON.stringify(
    [...dvdFiles.values()]
      .filter((file) => file.path.startsWith("VIDEO_TS/"))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => {
        const extents = file.extents.reduce<Array<{
          sectorCount: number;
          startLba: number;
        }>>((normalized, extent) => {
          const sectorCount = sectorCountForBytes(extent.byteCount);
          const previous = normalized.at(-1);
          if (
            previous !== undefined &&
            previous.startLba + previous.sectorCount === extent.startLba
          ) {
            previous.sectorCount += sectorCount;
          } else {
            normalized.push({ sectorCount, startLba: extent.startLba });
          }
          return normalized;
        }, []);
        return { byteCount: file.byteCount, extents, path: file.path };
      }),
  );

  const validateCompleteDvdVideoView = async (
    source: "iso" | "udf",
  ): Promise<string> => {
    const dvdFiles = source === "iso" ? isoDvdFiles : udfDvdFiles;
    const dvdPaths = source === "iso" ? isoDvdPaths : udfDvdPaths;
    if (REQUIRED_DVD_VIDEO_PATHS.some((path) => !dvdPaths.has(path))) {
      throw new Error("DVD-Video control structures are missing");
    }
    validateFileExtentOverlaps(dvdFiles, source === "iso" ? "ISO" : "UDF");
    const validateBackupAndReadIfo = async (
      ifoPath: string,
      bupPath: string,
    ): Promise<Buffer> => {
      const ifo = dvdFiles.get(ifoPath);
      const bup = dvdFiles.get(bupPath);
      if (ifo === undefined || bup === undefined) {
        throw new Error("DVD-Video control structures are missing");
      }
      const [ifoContent, bupContent] = await Promise.all([
        readDvdFile(ifo, MAX_FILE_ENTRY_BYTES * 16),
        readDvdFile(bup, MAX_FILE_ENTRY_BYTES * 16),
      ]);
      if (!ifoContent.equals(bupContent)) {
        throw new Error("DVD-Video backup does not match its IFO");
      }
      return ifoContent;
    };
    const menuVobSectorCount = (path: string): number => {
      const file = dvdFiles.get(path);
      if (file === undefined) {
        return 0;
      }
      if (
        file.embedded ||
        file.byteCount <= 0 ||
        file.byteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
        file.extents.some((extent) =>
          extent.byteCount % DVD_SECTOR_SIZE_BYTES !== 0
        )
      ) {
        throw new Error("DVD menu VOB layout is malformed");
      }
      return file.byteCount / DVD_SECTOR_SIZE_BYTES;
    };
    const managerIfoContent = await validateBackupAndReadIfo(
      "VIDEO_TS/VIDEO_TS.IFO",
      "VIDEO_TS/VIDEO_TS.BUP",
    );
    const globalTitles = await parseGlobalTitles(dvdFiles);
    const managerMenuSectorCount = menuVobSectorCount(
      "VIDEO_TS/VIDEO_TS.VOB",
    );
    const managerAddressMap = parseVobuAddressMap(
      managerIfoContent,
      0xdc,
      managerMenuSectorCount,
      "menu",
    );
    const managerProgramChainUnits = parseMenuProgramChainUnits(
      managerIfoContent,
      0xc8,
      managerMenuSectorCount,
    );
    const managerProgramChainCount = managerProgramChainUnits.length === 0
      ? undefined
      : Math.min(...managerProgramChainUnits.map((unit) =>
        unit.programChains.length
      ));
    for (const unit of managerProgramChainUnits) {
      for (const chain of unit.programChains) {
        validateProgramChainNavigation(chain, {
          currentTitleSetNumber: 0,
          globalTitles,
          managerProgramChainCount: unit.programChains.length,
          navigationSectors: managerAddressMap,
          programChainCount: unit.programChains.length,
        });
      }
    }
    const menuNavigation = [{
      addressMap: [...managerAddressMap],
      programChainUnits: managerProgramChainUnits,
      titleSetNumber: 0,
    }];
    const titleSetNumbers = [...new Set(
      globalTitles.map((title) => title.titleSetNumber),
    )].sort((left, right) => left - right);
    for (const titleSetNumber of titleSetNumbers) {
      const titleVobParts = [...dvdFiles.values()]
        .map((file) => ({ file, identity: titleVobIdentity(file.path) }))
        .filter(({ identity }) => identity?.titleSetNumber === titleSetNumber)
        .sort((left, right) =>
          left.identity!.partNumber - right.identity!.partNumber
        );
      if (
        titleVobParts.length === 0 ||
        titleVobParts.some(({ file, identity }, index) =>
          identity!.partNumber !== index + 1 ||
          file.byteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
          file.extents.some((extent) =>
            extent.byteCount % DVD_SECTOR_SIZE_BYTES !== 0
          )
        )
      ) {
        throw new Error("DVD title VOB layout is incomplete");
      }
      const titleVobSectorCount = titleVobParts.reduce(
        (total, { file }) => total + file.byteCount / DVD_SECTOR_SIZE_BYTES,
        0,
      );
      await readTitleVobuAddressMap(
        dvdFiles,
        titleSetNumber,
        titleVobSectorCount,
      );
      await readTitleAssociations(
        source,
        titleSetNumber,
        titleVobSectorCount,
        managerProgramChainCount,
      );
      const titleSetPrefix = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0`;
      const titleSetIfoContent = await validateBackupAndReadIfo(
        `${titleSetPrefix}.IFO`,
        `${titleSetPrefix}.BUP`,
      );
      const titleSetMenuSectorCount = menuVobSectorCount(
        `${titleSetPrefix}.VOB`,
      );
      const titleSetAddressMap = parseVobuAddressMap(
        titleSetIfoContent,
        0xdc,
        titleSetMenuSectorCount,
        "menu",
      );
      const titleSetProgramChainUnits = parseMenuProgramChainUnits(
        titleSetIfoContent,
        0xd0,
        titleSetMenuSectorCount,
      );
      for (const unit of titleSetProgramChainUnits) {
        for (const chain of unit.programChains) {
          validateProgramChainNavigation(chain, {
            currentTitleSetNumber: titleSetNumber,
            globalTitles,
            managerProgramChainCount,
            navigationSectors: titleSetAddressMap,
            programChainCount: unit.programChains.length,
          });
        }
      }
      menuNavigation.push({
        addressMap: [...titleSetAddressMap],
        programChainUnits: titleSetProgramChainUnits,
        titleSetNumber,
      });
    }
    return JSON.stringify({
      dvdVideoLayout: canonicalDvdVideoLayout(dvdFiles),
      globalTitles,
      menuNavigation,
    });
  };

  const completeAnalysis = (
    damageClassification: DvdDamageClassification,
  ): DvdLayoutAnalysis => {
    if (maximumReferencedLba < 0) {
      throw new Error("DVD image has no referenced extents");
    }
    return { damageClassification, maximumReferencedLba };
  };

  try {
    const isoBounds = await parseIso();
    const udfBounds = await parseUdf();
    if (!isoBounds.hasIso && !udfBounds.hasUdf) {
      throw new Error("DVD image has no supported filesystem view");
    }
    if (
      (isoBounds.hasIso &&
        REQUIRED_DVD_VIDEO_PATHS.some((path) => !isoDvdPaths.has(path))) ||
      (udfBounds.hasUdf &&
        REQUIRED_DVD_VIDEO_PATHS.some((path) => !udfDvdPaths.has(path)))
    ) {
      throw new Error("DVD-Video control structures are missing");
    }
    await policy.validateDvdVideoViews({
      hasIso: isoBounds.hasIso,
      hasUdf: udfBounds.hasUdf,
      validateFileStructureOverlaps: validateFilesDoNotOverlapStructures,
      validateView: validateCompleteDvdVideoView,
    });
    const badSectorCountsByTitle = new Map<
      number,
      { badSectorCount: number; titleSetNumber: number }
    >();
    for (const badLba of badSectors) {
      const allocations = allocatedExtents.filter((extent) =>
        extentContainsLba(extent, badLba)
      );
      if (allocations.length > 0) {
        const structural = allocations.find((extent) =>
          extent.reason !== "referenced_content"
        );
        if (structural !== undefined) {
          return completeAnalysis({
            outcome: "rejected",
            reason: structural.reason,
          });
        }
        if (udfBounds.hasUdf) {
          const allocationSources = new Set(
            allocations.map((extent) => extent.fileLocation?.source),
          );
          if (
            !allocationSources.has("iso") ||
            !allocationSources.has("udf")
          ) {
            return completeAnalysis({
              outcome: "rejected",
              reason: "ambiguous",
            });
          }
        }
        const titleVobClassifications = await Promise.all(
          allocations.map((extent) => classifyTitleVobSector(extent, badLba)),
        );
        if (titleVobClassifications.some(({ outcome }) =>
          outcome === "ambiguous"
        )) {
          return completeAnalysis({ outcome: "rejected", reason: "ambiguous" });
        }
        const conclusiveClassifications = titleVobClassifications.filter(
          (classification) => classification.outcome !== "ambiguous",
        );
        if (
          new Set(
            conclusiveClassifications.map(({ evidenceKey }) => evidenceKey),
          ).size !== 1
        ) {
          return completeAnalysis({ outcome: "rejected", reason: "ambiguous" });
        }
        const classification = conclusiveClassifications[0]!;
        if (classification.outcome === "navigation") {
          return completeAnalysis({
            outcome: "rejected",
            reason: "navigation",
          });
        }
        for (const titleNumber of classification.affectedTitleNumbers) {
          const existing = badSectorCountsByTitle.get(titleNumber);
          if (
            existing !== undefined &&
            existing.titleSetNumber !== classification.titleSetNumber
          ) {
            return completeAnalysis({
              outcome: "rejected",
              reason: "ambiguous",
            });
          }
          badSectorCountsByTitle.set(titleNumber, {
            badSectorCount: (existing?.badSectorCount ?? 0) + 1,
            titleSetNumber: classification.titleSetNumber,
          });
        }
        continue;
      }
      if (
        udfBounds.damagedRecognition &&
        recognitionDescriptorsContainLba(badLba)
      ) {
        return completeAnalysis({ outcome: "rejected", reason: "ambiguous" });
      }
      if (
        (isoBounds.hasIso && badLba >= isoBounds.volumeSpaceSize) ||
        (udfBounds.hasUdf && !udfBounds.partitions.some((partition) =>
          badLba >= partition.startLba &&
          badLba < partition.startLba + partition.sectorCount
        ))
      ) {
        return completeAnalysis({ outcome: "rejected", reason: "unmappable" });
      }
      if (badLba < 16) {
        return completeAnalysis({ outcome: "rejected", reason: "ambiguous" });
      }
      const sector = Buffer.alloc(DVD_SECTOR_SIZE_BYTES);
      const { bytesRead } = await handle.read(
        sector,
        0,
        sector.byteLength,
        badLba * DVD_SECTOR_SIZE_BYTES,
      );
      if (bytesRead !== sector.byteLength || sector.some((byte) => byte !== 0)) {
        throw new Error("DVD salvage substituted sector data is invalid");
      }
    }
    return completeAnalysis(
      badSectorCountsByTitle.size === 0
        ? { affectedTitleBadSectorCounts: [], outcome: "accepted" }
        : {
          affectedTitleBadSectorCounts: [...badSectorCountsByTitle]
            .sort(([left], [right]) => left - right)
            .map(([titleNumber, evidence]) => ({
              ...evidence,
              titleNumber,
            })),
          outcome: "accepted",
        },
    );
  } catch (error) {
    if (error instanceof ClassifiedDamageError) {
      return completeAnalysis({ outcome: "rejected", reason: error.reason });
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function proveDvdImageLayoutCompleteness({
  candidateBoundaryLba,
  imagePath,
}: {
  candidateBoundaryLba: number;
  imagePath: string;
}): Promise<{ maximumReferencedLba: number }> {
  const { maximumReferencedLba } = await analyzeDvdImageLayout({
    candidateBoundaryLba,
    imagePath,
    purpose: { kind: "completeness-proof" },
  });
  return { maximumReferencedLba };
}

export async function classifyDvdImageDamage({
  imagePath,
  expectedByteCount,
  unreadableSectorRanges,
}: {
  imagePath: string;
  expectedByteCount: number;
  unreadableSectorRanges: readonly UnreadableSectorRange[];
}): Promise<DvdDamageClassification> {
  if (
    !Number.isSafeInteger(expectedByteCount) ||
    expectedByteCount <= 0 ||
    expectedByteCount % DVD_SECTOR_SIZE_BYTES !== 0
  ) {
    throw new Error("DVD salvage image size is invalid");
  }
  const { damageClassification } = await analyzeDvdImageLayout({
    candidateBoundaryLba: expectedByteCount / DVD_SECTOR_SIZE_BYTES,
    imagePath,
    purpose: {
      exactImageByteCount: expectedByteCount,
      kind: "salvage-classification",
      unreadableSectorRanges,
    },
  });
  return damageClassification;
}
