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
const MAX_VOBU_ENTRIES = 100_000;
const DVD_NAV_PCI_PACKET_OFFSET = 38;
const DVD_NAV_PCI_PAYLOAD_OFFSET = 45;
const DVD_NAV_DSI_PACKET_OFFSET = 1_024;
const DVD_NAV_DSI_PAYLOAD_OFFSET = 1_031;
const DVD_PRIVATE_STREAM_2_START_CODE = 0x0000_01bf;
const DVD_PROGRAM_STREAM_PACK_START_CODE = 0x0000_01ba;
const UDF_EXTENT_LENGTH_MASK = 0x3fff_ffff;
const UDF_EXTENT_TYPE_MASK = 0xc000_0000;
const SUPPORTED_DVD_VM_LINK_SUB_OPERATIONS = new Set([
  0,
  1,
  2,
  3,
  5,
  6,
  7,
  9,
  10,
  11,
  12,
  13,
  16,
]);
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
  continueAfterUnrecognizedIsoDescriptor(isUnreadable: boolean): boolean;
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
      continueAfterUnrecognizedIsoDescriptor: (isUnreadable) => isUnreadable,
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
    continueAfterUnrecognizedIsoDescriptor: () => false,
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
          validateUdfTag(alternateAnchor, [2], anchorLba);
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

class DvdExtentFieldError extends Error {}

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

function validateUdfTag(
  buffer: Buffer,
  expectedIdentifiers: readonly number[],
  expectedLocation: number,
): number {
  if (buffer.byteLength < 16) {
    throw new Error("DVD UDF descriptor is truncated");
  }
  const identifier = buffer.readUInt16LE(0);
  if (!expectedIdentifiers.includes(identifier)) {
    throw new Error("DVD UDF descriptor has an unexpected type");
  }
  if (
    ![2, 3].includes(buffer.readUInt16LE(2)) ||
    buffer[5] !== 0
  ) {
    throw new Error("DVD UDF descriptor tag is malformed");
  }
  if (buffer.readUInt32LE(12) !== expectedLocation) {
    throw new Error("DVD UDF descriptor tag location is invalid");
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

function udfEntityIdentifier(buffer: Buffer, offset: number): string {
  if (offset < 0 || offset + 32 > buffer.byteLength || buffer[offset] !== 0) {
    throw new Error("DVD UDF entity identifier is malformed");
  }
  const rawIdentifier = buffer.subarray(offset + 1, offset + 24);
  const terminatorIndex = rawIdentifier.indexOf(0);
  const identifier = terminatorIndex === -1
    ? rawIdentifier
    : rawIdentifier.subarray(0, terminatorIndex);
  if (
    identifier.length === 0 ||
    identifier.some((byte) => byte < 0x20 || byte > 0x7e) ||
    terminatorIndex !== -1 &&
      rawIdentifier.subarray(terminatorIndex).some((byte) => byte !== 0)
  ) {
    throw new Error("DVD UDF entity identifier is malformed");
  }
  return identifier.toString("ascii");
}

function validateUdfCharacterSet(buffer: Buffer, offset: number): void {
  if (
    offset < 0 ||
    offset + 64 > buffer.byteLength ||
    buffer[offset] !== 0 ||
    buffer.toString("ascii", offset + 1, offset + 24) !==
      "OSTA Compressed Unicode" ||
    buffer.subarray(offset + 24, offset + 64).some((byte) => byte !== 0)
  ) {
    throw new Error("DVD UDF character set is unsupported");
  }
}

function validateUdfDstring(
  buffer: Buffer,
  offset: number,
  fieldLength: number,
): void {
  if (
    offset < 0 ||
    fieldLength < 2 ||
    offset + fieldLength > buffer.byteLength
  ) {
    throw new Error("DVD UDF descriptor string is malformed");
  }
  const recordedLength = buffer[offset + fieldLength - 1]!;
  if (recordedLength === 0) {
    if (
      buffer.subarray(offset, offset + fieldLength - 1)
        .some((byte) => byte !== 0)
    ) {
      throw new Error("DVD UDF descriptor string is malformed");
    }
    return;
  }
  const compressionId = buffer[offset]!;
  if (
    recordedLength > fieldLength - 1 ||
    (compressionId !== 8 && compressionId !== 16) ||
    compressionId === 16 && (recordedLength - 1) % 2 !== 0 ||
    buffer.subarray(offset + recordedLength, offset + fieldLength - 1)
      .some((byte) => byte !== 0)
  ) {
    throw new Error("DVD UDF descriptor string is malformed");
  }
}

function validateDvdInlineExtendedAttributes(
  content: Buffer,
  expectedTagLocation: number,
): void {
  if (content.byteLength < 24 || content.byteLength % 4 !== 0) {
    throw new Error("DVD UDF inline extended attributes are malformed");
  }
  validateUdfTag(content, [262], expectedTagLocation);
  const implementationAttributesLocation = content.readUInt32LE(16);
  const applicationAttributesLocation = content.readUInt32LE(20);
  if (
    implementationAttributesLocation !== 24 ||
    applicationAttributesLocation < implementationAttributesLocation ||
    applicationAttributesLocation !== content.byteLength ||
    applicationAttributesLocation % 4 !== 0
  ) {
    throw new Error("DVD UDF inline extended attributes are unsupported");
  }
  const seenIdentifiers = new Set<string>();
  let offset = implementationAttributesLocation;
  while (offset < applicationAttributesLocation) {
    if (offset + 48 > applicationAttributesLocation) {
      throw new Error("DVD UDF inline extended attribute is truncated");
    }
    const attribute = content.subarray(offset);
    const attributeLength = attribute.readUInt32LE(8);
    const implementationUseLength = attribute.readUInt32LE(12);
    if (
      attribute.readUInt32LE(0) !== 2_048 ||
      attribute[4] !== 1 ||
      attribute.subarray(5, 8).some((byte) => byte !== 0) ||
      attributeLength < 48 ||
      attributeLength % 4 !== 0 ||
      offset + attributeLength > applicationAttributesLocation ||
      implementationUseLength > attributeLength - 48 ||
      attributeLength >= DVD_SECTOR_SIZE_BYTES &&
        (offset % DVD_SECTOR_SIZE_BYTES !== 0 ||
          attributeLength % DVD_SECTOR_SIZE_BYTES !== 0)
    ) {
      throw new Error("DVD UDF inline extended attribute is malformed");
    }
    const identifier = udfEntityIdentifier(attribute, 16);
    if (seenIdentifiers.has(identifier)) {
      throw new Error("DVD UDF inline extended attributes are ambiguous");
    }
    seenIdentifiers.add(identifier);
    let expectedImplementationUseLength: number;
    if (identifier === "*UDF FreeEASpace") {
      expectedImplementationUseLength = 4;
      if (attribute.readUInt16LE(50) !== 0) {
        throw new Error("DVD UDF free extended attribute is malformed");
      }
    } else if (identifier === "*UDF DVD CGMS Info") {
      expectedImplementationUseLength = 8;
      const copyrightManagement = attribute[50]!;
      if (
        (copyrightManagement & 0x4f) !== 0 ||
        (copyrightManagement & 0x80) === 0 &&
          (copyrightManagement & 0x30) !== 0 ||
        attribute[51] !== 0 ||
        attribute[52]! > 1 ||
        attribute.subarray(53, 56).some((byte) => byte !== 0)
      ) {
        throw new Error("DVD UDF copyright attribute is malformed");
      }
    } else {
      throw new Error("DVD UDF inline extended attribute is unsupported");
    }
    if (
      implementationUseLength !== expectedImplementationUseLength ||
      attribute.subarray(0, 48).reduce(
          (checksum, byte) => (checksum + byte) & 0xffff,
          0,
        ) !== attribute.readUInt16LE(48) ||
      attribute.subarray(48 + implementationUseLength, attributeLength)
        .some((byte) => byte !== 0)
    ) {
      throw new Error("DVD UDF inline extended attribute is malformed");
    }
    offset += attributeLength;
  }
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
    identifierEncoding: "ascii" | "joliet",
    parentDirectory?: {
      byteCount: number;
      extendedAttributeSectorCount: number;
      extentLba: number;
    },
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
    const currentDirectory = {
      byteCount,
      extendedAttributeSectorCount,
      extentLba,
    };
    const directory = await readExtent(
      startLba,
      byteCount,
      "directory_data",
      MAX_DIRECTORY_BYTES,
    );
    let offset = 0;
    let recordIndex = 0;
    let sawParentRecord = false;
    let sawSelfRecord = false;
    while (offset < directory.byteLength) {
      const recordLength = directory[offset]!;
      if (recordLength === 0) {
        const nextSectorOffset = Math.min(
          directory.byteLength,
          Math.ceil((offset + 1) / DVD_SECTOR_SIZE_BYTES) *
            DVD_SECTOR_SIZE_BYTES,
        );
        if (
          directory.subarray(offset, nextSectorOffset).some((byte) => byte !== 0)
        ) {
          throw new Error("DVD ISO directory padding is malformed");
        }
        offset = nextSectorOffset;
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
      if (isSpecial) {
        const isSelf = identifier[0] === 0;
        const expected = isSelf || parentDirectory === undefined
          ? currentDirectory
          : parentDirectory;
        if (
          recordIndex !== (isSelf ? 0 : 1) ||
          (isSelf ? sawSelfRecord : sawParentRecord) ||
          (flags & 0x02) === 0 ||
          extentLba !== expected.extentLba ||
          extentBytes !== expected.byteCount ||
          extendedAttributeSectorCount !==
            expected.extendedAttributeSectorCount
        ) {
          throw new Error("DVD ISO special directory record is malformed");
        }
        if (isSelf) {
          sawSelfRecord = true;
        } else {
          sawParentRecord = true;
        }
      } else if (extentBytes > 0) {
        if (recordIndex < 2) {
          throw new Error("DVD ISO file identifier is malformed");
        }
        let decodedIdentifier: string;
        if (identifierEncoding === "ascii") {
          if (identifier.some((byte) => byte === 0 || byte === 0x2f)) {
            throw new Error("DVD ISO file identifier is malformed");
          }
          decodedIdentifier = identifier.toString("ascii");
        } else {
          if (identifier.byteLength % 2 !== 0) {
            throw new Error("DVD Joliet file identifier is malformed");
          }
          decodedIdentifier = "";
          for (let index = 0; index < identifier.byteLength; index += 2) {
            decodedIdentifier += String.fromCharCode(
              identifier.readUInt16BE(index),
            );
          }
        }
        const name = decodedIdentifier.replace(/;\d+$/, "");
        if (name.length === 0 || name.includes("/") || name.includes("\0")) {
          throw new Error("DVD ISO file identifier is malformed");
        }
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
            identifierEncoding,
            currentDirectory,
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
      recordIndex += 1;
    }
    if (!sawSelfRecord || !sawParentRecord) {
      throw new Error("DVD ISO special directory record is missing");
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

  const dvdControlFileContents = new Map<
    DvdFileLayout,
    Promise<Buffer>
  >();
  const readDvdControlFile = (file: DvdFileLayout): Promise<Buffer> => {
    const existing = dvdControlFileContents.get(file);
    if (existing !== undefined) {
      return existing;
    }
    const content = readDvdFile(file, MAX_FILE_ENTRY_BYTES * 16);
    dvdControlFileContents.set(file, content);
    return content;
  };

  const contiguousDvdFileRange = (
    file: DvdFileLayout,
    description: string,
  ): { endLba: number; sectorCount: number; startLba: number } => {
    if (
      file.embedded ||
      file.byteCount <= 0 ||
      file.byteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
      file.extents.length === 0
    ) {
      throw new Error(`DVD ${description} extent is malformed`);
    }
    let expectedLba = file.extents[0]!.startLba;
    let sectorCount = 0;
    for (const extent of file.extents) {
      if (
        extent.byteCount <= 0 ||
        extent.byteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
        extent.startLba !== expectedLba
      ) {
        throw new Error(`DVD ${description} extent is malformed`);
      }
      const extentSectorCount = extent.byteCount / DVD_SECTOR_SIZE_BYTES;
      sectorCount += extentSectorCount;
      expectedLba += extentSectorCount;
    }
    if (sectorCount * DVD_SECTOR_SIZE_BYTES !== file.byteCount) {
      throw new Error(`DVD ${description} extent is malformed`);
    }
    return {
      endLba: expectedLba,
      sectorCount,
      startLba: file.extents[0]!.startLba,
    };
  };

  const validateDvdManagerExtentFields = (
    content: Buffer,
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    managerIfo: DvdFileLayout,
  ): void => {
    const ifoRange = contiguousDvdFileRange(managerIfo, "video manager IFO");
    const managerPaths = [
      "VIDEO_TS/VIDEO_TS.IFO",
      "VIDEO_TS/VIDEO_TS.BUP",
      "VIDEO_TS/VIDEO_TS.VOB",
    ];
    const managerRanges = managerPaths.flatMap((path) => {
      const file = dvdFiles.get(path);
      return file === undefined
        ? []
        : [contiguousDvdFileRange(file, "video manager file")];
    });
    const menuVob = dvdFiles.get("VIDEO_TS/VIDEO_TS.VOB");
    const expectedMenuStart = menuVob === undefined
      ? 0
      : contiguousDvdFileRange(menuVob, "video manager VOB").startLba -
        ifoRange.startLba;
    const expectedLastSector = Math.max(
      ...managerRanges.map((range) => range.endLba),
    ) - ifoRange.startLba - 1;
    const lastByte = content.readUInt32BE(0x80);
    if (
      content.readUInt32BE(0x0c) !== expectedLastSector ||
      content.readUInt32BE(0x1c) !== ifoRange.sectorCount - 1 ||
      lastByte < 341 ||
      lastByte >= managerIfo.byteCount ||
      Math.floor(lastByte / DVD_SECTOR_SIZE_BYTES) >
        content.readUInt32BE(0x1c) ||
      content.readUInt32BE(0xc0) !== expectedMenuStart
    ) {
      throw new DvdExtentFieldError(
        "DVD video manager extent fields are malformed",
      );
    }
  };

  const validateDvdTitleSetExtentFields = (
    content: Buffer,
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumber: number,
    titleSetIfo: DvdFileLayout,
  ): void => {
    const prefix = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}`;
    const ifoRange = contiguousDvdFileRange(titleSetIfo, "title-set IFO");
    const titleSetRanges = [...dvdFiles.values()].filter((file) =>
      file.path.startsWith(`${prefix}_`)
    ).map((file) => contiguousDvdFileRange(file, "title-set file"));
    const menuVob = dvdFiles.get(`${prefix}_0.VOB`);
    const titleVob = dvdFiles.get(`${prefix}_1.VOB`);
    if (titleVob === undefined) {
      throw new Error("DVD title VOB layout is incomplete");
    }
    const expectedLastSector = Math.max(
      ...titleSetRanges.map((range) => range.endLba),
    ) - ifoRange.startLba - 1;
    const expectedMenuStart = menuVob === undefined
      ? 0
      : contiguousDvdFileRange(menuVob, "title-set menu VOB").startLba -
        ifoRange.startLba;
    const expectedTitleStart = contiguousDvdFileRange(
      titleVob,
      "title VOB",
    ).startLba - ifoRange.startLba;
    const lastByte = content.readUInt32BE(0x80);
    if (
      content.readUInt32BE(0x0c) !== expectedLastSector ||
      content.readUInt32BE(0x1c) !== ifoRange.sectorCount - 1 ||
      lastByte < 341 ||
      lastByte >= titleSetIfo.byteCount ||
      Math.floor(lastByte / DVD_SECTOR_SIZE_BYTES) >
        content.readUInt32BE(0x1c) ||
      content.readUInt32BE(0xc0) !== expectedMenuStart ||
      content.readUInt32BE(0xc4) !== expectedTitleStart
    ) {
      throw new DvdExtentFieldError("DVD title-set extent fields are malformed");
    }
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
      (tableByteCount - 4) / 4 > MAX_VOBU_ENTRIES ||
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
    const content = await readDvdControlFile(file);
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

  interface DvdVmCommand {
    encoded: string;
    instruction: bigint;
    toJSON: () => string;
  }

  const readDvdVmCommand = (commandBytes: Buffer): DvdVmCommand => {
    if (commandBytes.byteLength !== 8) {
      throw new Error("DVD VM command is truncated");
    }
    const encoded = commandBytes.toString("hex");
    return {
      encoded,
      instruction: commandBytes.readBigUInt64BE(),
      toJSON: () => encoded,
    };
  };

  interface DvdProgramChain {
    angleBlockLengths: readonly number[];
    availableAudioStreamNumbers: ReadonlySet<number>;
    availableSubpictureStreamNumbers: ReadonlySet<number>;
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
      commands: readonly DvdVmCommand[];
      section: "cell" | "post" | "pre";
    }[];
    programChainReferences: readonly number[];
    programStartCells: readonly number[];
  }

  interface DvdCellAddress {
    cellNumber: number;
    firstSector: number;
    lastSector: number;
    vobId: number;
  }

  interface DvdNavigationIdentity {
    buttonCommands: readonly DvdVmCommand[];
    cellNumber: number;
    vobId: number;
  }

  const parseGlobalTitlesUncached = async (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
  ): Promise<readonly GlobalDvdTitle[]> => {
    const file = dvdFiles.get("VIDEO_TS/VIDEO_TS.IFO");
    if (file === undefined) {
      throw new Error("DVD video manager navigation file is missing");
    }
    const content = await readDvdControlFile(file);
    if (
      content.byteLength < DVD_SECTOR_SIZE_BYTES ||
      content.toString("ascii", 0, 12) !== "DVDVIDEO-VMG"
    ) {
      throw new Error("DVD video manager navigation file is malformed");
    }
    validateDvdManagerExtentFields(content, dvdFiles, file);
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
      const titleSetIfo = dvdFiles.get(
        `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0.IFO`,
      );
      const key = `${titleSetNumber}:${titleSetTitleNumber}`;
      if (
        angleCount <= 0 ||
        angleCount > 9 ||
        chapterCount <= 0 ||
        titleSetNumber <= 0 ||
        titleSetNumber > 99 ||
        titleSetTitleNumber <= 0 ||
        titleSetTitleNumber > 99 ||
        titleSetIfo === undefined ||
        content.readUInt32BE(offset + 8) !== contiguousDvdFileRange(
          titleSetIfo,
          "title-set IFO",
        ).startLba ||
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
    const declaredTitleSetCount = content.readUInt16BE(0x3e);
    const titleSetNumbers = new Set(titles.map((title) => title.titleSetNumber));
    if (
      declaredTitleSetCount !== titleSetNumbers.size ||
      declaredTitleSetCount <= 0 ||
      [...titleSetNumbers].some((titleSetNumber) =>
        titleSetNumber > declaredTitleSetCount
      )
    ) {
      throw new Error("DVD video manager title-set count is malformed");
    }
    return titles;
  };

  const globalTitlesByView = new WeakMap<
    ReadonlyMap<string, DvdFileLayout>,
    Promise<readonly GlobalDvdTitle[]>
  >();
  const parseGlobalTitles = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
  ): Promise<readonly GlobalDvdTitle[]> => {
    const existing = globalTitlesByView.get(dvdFiles);
    if (existing !== undefined) {
      return existing;
    }
    const titles = parseGlobalTitlesUncached(dvdFiles);
    globalTitlesByView.set(dvdFiles, titles);
    return titles;
  };

  const readProgramChainCommands = (
    content: Buffer,
    pgcitOffset: number,
    pgcitByteCount: number,
    pgcStartByte: number,
    followingOffsets: readonly number[],
  ): readonly {
    commands: readonly DvdVmCommand[];
    section: "cell" | "post" | "pre";
  }[] => {
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
    const commandSections = ["pre", "post", "cell"] as const;
    return commandCounts.map((count, blockIndex) => {
      const commands = [];
      for (let index = 0; index < count; index += 1) {
        const commandBytes = content.subarray(
          commandOffset,
          commandOffset + 8,
        );
        commands.push(readDvdVmCommand(commandBytes));
        commandOffset += 8;
      }
      return {
        commands,
        section: commandSections[blockIndex]!,
      };
    });
  };

  const readProgramChainControls = (
    content: Buffer,
    pgcOffset: number,
  ): Pick<
    DvdProgramChain,
    | "availableAudioStreamNumbers"
    | "availableSubpictureStreamNumbers"
    | "programChainReferences"
  > => {
    const availableAudioStreamNumbers = new Set<number>();
    for (let stream = 0; stream < 8; stream += 1) {
      if ((content.readUInt16BE(pgcOffset + 12 + stream * 2) & 0x8000) !== 0) {
        availableAudioStreamNumbers.add(stream);
      }
    }
    const availableSubpictureStreamNumbers = new Set<number>();
    for (let stream = 0; stream < 32; stream += 1) {
      if (
        (content.readUInt32BE(pgcOffset + 28 + stream * 4) & 0x8000_0000) !== 0
      ) {
        availableSubpictureStreamNumbers.add(stream);
      }
    }
    return {
      availableAudioStreamNumbers,
      availableSubpictureStreamNumbers,
      programChainReferences: [156, 158, 160].map((offset) =>
        content.readUInt16BE(pgcOffset + offset)
      ),
    };
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
    const controls = readProgramChainControls(content, pgcOffset);
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
        cellNumber <= 0 ||
        content[playbackOffset + 3]! >
          (commandBlocks[2]?.commands.length ?? 0)
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
    return {
      angleBlockLengths,
      ...controls,
      cells,
      commandBlocks,
      programStartCells,
    };
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
        ...readProgramChainControls(content, pgcOffset),
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
    entryMenuIds: readonly number[];
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
      const entryMenuIds = new Set<number>();
      const starts = new Set<number>();
      for (let pgcIndex = 0; pgcIndex < pgcCount; pgcIndex += 1) {
        const searchPointerOffset = pgcitOffset + 8 + pgcIndex * 8;
        const entryId = content[searchPointerOffset]!;
        if (entryId !== 0) {
          const menuId = entryId & 0x7f;
          if (
            (entryId & 0x80) === 0 ||
            menuId < 2 ||
            menuId > 7 ||
            entryMenuIds.has(menuId)
          ) {
            throw new Error("DVD menu program chain entry is malformed");
          }
          entryMenuIds.add(menuId);
        }
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
      units.push({
        entryMenuIds: [...entryMenuIds].sort((left, right) => left - right),
        languageCode,
        programChains,
      });
    }
    return units;
  };

  const parseCellAddressTable = (
    content: Buffer,
    tablePointerOffset: number,
    vobSectorCount: number,
    required: boolean,
    description: "menu" | "title",
  ): ReadonlyMap<string, DvdCellAddress> => {
    const tableSector = content.readUInt32BE(tablePointerOffset);
    if (tableSector === 0) {
      if (required) {
        throw new Error(`DVD ${description} cell address table is missing`);
      }
      return new Map();
    }
    const tableOffset = tableSector * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(tableOffset) ||
      tableOffset < DVD_SECTOR_SIZE_BYTES ||
      tableOffset + 8 > content.byteLength
    ) {
      throw new Error(`DVD ${description} cell address table is missing`);
    }
    const declaredVobCount = content.readUInt16BE(tableOffset);
    const tableByteCount = content.readUInt32BE(tableOffset + 4) + 1;
    if (
      declaredVobCount <= 0 ||
      declaredVobCount > 99 ||
      content.readUInt16BE(tableOffset + 2) !== 0 ||
      tableByteCount < 20 ||
      (tableByteCount - 8) % 12 !== 0 ||
      (tableByteCount - 8) / 12 > MAX_DIRECTORY_ENTRIES ||
      tableOffset + tableByteCount > content.byteLength
    ) {
      throw new Error(`DVD ${description} cell address table is malformed`);
    }
    const addresses = new Map<string, DvdCellAddress>();
    const vobIds = new Set<number>();
    const physicalExtents: Array<{ endLba: number; startLba: number }> = [];
    for (let offset = 8; offset < tableByteCount; offset += 12) {
      const entryOffset = tableOffset + offset;
      const vobId = content.readUInt16BE(entryOffset);
      const cellNumber = content[entryOffset + 2]!;
      const firstSector = content.readUInt32BE(entryOffset + 4);
      const lastSector = content.readUInt32BE(entryOffset + 8);
      const key = `${vobId}:${cellNumber}`;
      if (
        vobId <= 0 ||
        cellNumber <= 0 ||
        content[entryOffset + 3] !== 0 ||
        firstSector > lastSector ||
        lastSector >= vobSectorCount ||
        addresses.has(key)
      ) {
        throw new Error(`DVD ${description} cell address table is malformed`);
      }
      vobIds.add(vobId);
      physicalExtents.push({ endLba: lastSector + 1, startLba: firstSector });
      addresses.set(key, { cellNumber, firstSector, lastSector, vobId });
    }
    if (
      vobIds.size !== declaredVobCount ||
      [...vobIds].some((vobId) => vobId > declaredVobCount)
    ) {
      throw new Error(`DVD ${description} cell address table is malformed`);
    }
    const ordered = physicalExtents.sort((left, right) =>
      left.startLba - right.startLba || left.endLba - right.endLba
    );
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.startLba < ordered[index - 1]!.endLba) {
        throw new Error(`DVD ${description} cell address table overlaps`);
      }
    }
    return addresses;
  };

  const validateTimeMapTable = (
    content: Buffer,
    programChainCount: number,
    titleVobSectorCount: number,
  ): void => {
    const tableSector = content.readUInt32BE(0xd4);
    if (tableSector === 0) {
      return;
    }
    const tableOffset = tableSector * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(tableOffset) ||
      tableOffset < DVD_SECTOR_SIZE_BYTES ||
      tableOffset + 8 > content.byteLength
    ) {
      throw new Error("DVD title time map table is missing");
    }
    const mapCount = content.readUInt16BE(tableOffset);
    const tableByteCount = content.readUInt32BE(tableOffset + 4) + 1;
    if (
      mapCount !== programChainCount ||
      mapCount <= 0 ||
      content.readUInt16BE(tableOffset + 2) !== 0 ||
      tableByteCount < 8 + mapCount * 4 ||
      tableOffset + tableByteCount > content.byteLength
    ) {
      throw new Error("DVD title time map table is malformed");
    }
    const starts = new Set<number>();
    const mapExtents: Array<{ endOffset: number; startOffset: number }> = [];
    for (let index = 0; index < mapCount; index += 1) {
      const mapStart = content.readUInt32BE(tableOffset + 8 + index * 4);
      const mapOffset = tableOffset + mapStart;
      if (
        mapStart < 8 + mapCount * 4 ||
        starts.has(mapStart) ||
        mapOffset + 4 > tableOffset + tableByteCount
      ) {
        throw new Error("DVD title time map table is malformed");
      }
      starts.add(mapStart);
      const entryCount = content.readUInt16BE(mapOffset + 2);
      if (
        content[mapOffset] === 0 ||
        content[mapOffset + 1] !== 0 ||
        entryCount > MAX_VOBU_ENTRIES ||
        mapStart + 4 + entryCount * 4 > tableByteCount
      ) {
        throw new Error("DVD title time map table is malformed");
      }
      mapExtents.push({
        endOffset: mapStart + 4 + entryCount * 4,
        startOffset: mapStart,
      });
      let previousSector = -1;
      for (let entry = 0; entry < entryCount; entry += 1) {
        const sector = content.readUInt32BE(mapOffset + 4 + entry * 4) &
          0x7fff_ffff;
        if (sector <= previousSector || sector >= titleVobSectorCount) {
          throw new Error("DVD title time map entry is invalid");
        }
        previousSector = sector;
      }
    }
    const orderedMaps = mapExtents.sort((left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset
    );
    for (let index = 1; index < orderedMaps.length; index += 1) {
      if (
        orderedMaps[index]!.startOffset < orderedMaps[index - 1]!.endOffset
      ) {
        throw new Error("DVD title time map table overlaps");
      }
    }
  };

  const commonMenuEntryIds = (
    units: ReturnType<typeof parseMenuProgramChainUnits>,
  ): ReadonlySet<number> => {
    if (units.length === 0) {
      return new Set();
    }
    return new Set(
      units[0]!.entryMenuIds.filter((menuId) =>
        units.every((unit) => unit.entryMenuIds.includes(menuId))
      ),
    );
  };

  const commonProgramChainCount = (
    units: ReturnType<typeof parseMenuProgramChainUnits>,
  ): number | undefined => units.length === 0
    ? undefined
    : Math.min(...units.map((unit) => unit.programChains.length));

  const vobFileSectorCount = (
    file: DvdFileLayout,
  ): number | undefined => {
    if (
      file.embedded ||
      file.byteCount <= 0 ||
      file.byteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
      file.extents.length === 0 ||
      file.extents.reduce((total, extent) => total + extent.byteCount, 0) !==
        file.byteCount ||
      file.extents.some((extent) =>
        extent.byteCount <= 0 ||
        extent.byteCount % DVD_SECTOR_SIZE_BYTES !== 0
      )
    ) {
      return undefined;
    }
    return file.byteCount / DVD_SECTOR_SIZE_BYTES;
  };

  const normalizeDvdFileExtents = (
    file: DvdFileLayout,
  ): Array<{ sectorCount: number; startLba: number }> =>
    file.extents.reduce<Array<{
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

  const menuVobSectorCount = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    path: string,
  ): number => {
    const file = dvdFiles.get(path);
    if (file === undefined) {
      return 0;
    }
    const sectorCount = vobFileSectorCount(file);
    if (sectorCount === undefined) {
      throw new Error("DVD menu VOB layout is malformed");
    }
    return sectorCount;
  };

  const readMenuNavigation = async ({
    expectedIdentifier,
    ifoPath,
    malformedDescription,
    menuProgramChainPointerOffset,
    source,
    streamDescription,
    suppliedIfoContent,
    vobPath,
  }: {
    expectedIdentifier: "DVDVIDEO-VMG" | "DVDVIDEO-VTS";
    ifoPath: string;
    malformedDescription: "title-set" | "video manager";
    menuProgramChainPointerOffset: number;
    source: "iso" | "udf";
    streamDescription: "title-set menu" | "video manager";
    suppliedIfoContent?: Buffer;
    vobPath: string;
  }): Promise<{
    audioStreamCount: number;
    cellAddresses: ReadonlyMap<string, DvdCellAddress>;
    ifoContent: Buffer;
    menuVobSectorCount: number;
    programChainUnits: ReturnType<typeof parseMenuProgramChainUnits>;
    subpictureStreamCount: number;
  }> => {
    const dvdFiles = source === "iso" ? isoDvdFiles : udfDvdFiles;
    const ifo = dvdFiles.get(ifoPath);
    if (ifo === undefined) {
      throw new Error(`DVD ${malformedDescription} navigation file is missing`);
    }
    const ifoContent = suppliedIfoContent ?? await readDvdControlFile(ifo);
    if (
      ifoContent.byteLength < DVD_SECTOR_SIZE_BYTES ||
      ifoContent.toString("ascii", 0, 12) !== expectedIdentifier
    ) {
      throw new Error(
        `DVD ${malformedDescription} navigation file is malformed`,
      );
    }
    const sectorCount = menuVobSectorCount(dvdFiles, vobPath);
    const audioStreamCount = ifoContent[0x103]!;
    const subpictureStreamCount = ifoContent[0x155]!;
    if (audioStreamCount > 8 || subpictureStreamCount > 32) {
      throw new Error(
        `DVD ${streamDescription} stream attributes are malformed`,
      );
    }
    return {
      audioStreamCount,
      cellAddresses: parseCellAddressTable(
        ifoContent,
        0xd8,
        sectorCount,
        sectorCount > 0,
        "menu",
      ),
      ifoContent,
      menuVobSectorCount: sectorCount,
      programChainUnits: parseMenuProgramChainUnits(
        ifoContent,
        menuProgramChainPointerOffset,
        sectorCount,
      ),
      subpictureStreamCount,
    };
  };

  const readManagerNavigation = async (
    source: "iso" | "udf",
    suppliedIfoContent?: Buffer,
  ) => {
    const { ifoContent, ...navigation } = await readMenuNavigation({
      expectedIdentifier: "DVDVIDEO-VMG",
      ifoPath: "VIDEO_TS/VIDEO_TS.IFO",
      malformedDescription: "video manager",
      menuProgramChainPointerOffset: 0xc8,
      source,
      streamDescription: "video manager",
      suppliedIfoContent,
      vobPath: "VIDEO_TS/VIDEO_TS.VOB",
    });
    const firstPlayOffset = ifoContent.readUInt32BE(0x84);
    return {
      ...navigation,
      firstPlayProgramChain: firstPlayOffset === 0
        ? undefined
        : parseMenuProgramChain(
            ifoContent,
            0,
            ifoContent.byteLength,
            firstPlayOffset,
            navigation.menuVobSectorCount,
          ),
    };
  };

  const readTitleSetMenuNavigation = async (
    source: "iso" | "udf",
    titleSetNumber: number,
    suppliedIfoContent?: Buffer,
  ) => {
    const prefix = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0`;
    const { ifoContent: _ifoContent, ...navigation } =
      await readMenuNavigation({
        expectedIdentifier: "DVDVIDEO-VTS",
        ifoPath: `${prefix}.IFO`,
        malformedDescription: "title-set",
        menuProgramChainPointerOffset: 0xd0,
        source,
        streamDescription: "title-set menu",
        suppliedIfoContent,
        vobPath: `${prefix}.VOB`,
      });
    return navigation;
  };

  const titleVobLayout = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumber: number,
  ): {
    parts: readonly {
      file: DvdFileLayout;
      identity: { partNumber: number; titleSetNumber: number };
    }[];
    sectorCount: number;
  } | undefined => {
    const parts = [...dvdFiles.values()].flatMap((file) => {
      const identity = titleVobIdentity(file.path);
      return identity?.titleSetNumber === titleSetNumber
        ? [{ file, identity }]
        : [];
    }).sort((left, right) =>
      left.identity.partNumber - right.identity.partNumber
    );
    if (
      parts.length === 0 ||
      parts.some(({ file, identity }, index) =>
        identity.partNumber !== index + 1 ||
        vobFileSectorCount(file) === undefined
      )
    ) {
      return undefined;
    }
    return {
      parts,
      sectorCount: parts.reduce(
        (total, { file }) =>
          total + file.byteCount / DVD_SECTOR_SIZE_BYTES,
        0,
      ),
    };
  };

  const readVobSector = async (
    files: readonly DvdFileLayout[],
    sector: number,
  ): Promise<Buffer> => {
    if (!Number.isSafeInteger(sector) || sector < 0) {
      throw new Error("DVD VOB navigation sector is invalid");
    }
    let remainingByteOffset = sector * DVD_SECTOR_SIZE_BYTES;
    for (const file of files) {
      if (remainingByteOffset >= file.byteCount) {
        remainingByteOffset -= file.byteCount;
        continue;
      }
      for (const extent of file.extents) {
        if (remainingByteOffset >= extent.byteCount) {
          remainingByteOffset -= extent.byteCount;
          continue;
        }
        if (
          remainingByteOffset % DVD_SECTOR_SIZE_BYTES !== 0 ||
          remainingByteOffset + DVD_SECTOR_SIZE_BYTES > extent.byteCount
        ) {
          throw new Error("DVD VOB navigation layout is malformed");
        }
        return readRawSector(
          extent.startLba + remainingByteOffset / DVD_SECTOR_SIZE_BYTES,
        );
      }
      break;
    }
    throw new Error("DVD VOB navigation sector is missing");
  };

  const validateVobNavigationPacks = async (
    files: readonly DvdFileLayout[],
    navigationSectors: ReadonlySet<number>,
    vobSectorCount: number,
  ): Promise<ReadonlyMap<number, DvdNavigationIdentity>> => {
    const referencedNavigationSector = (
      value: number,
      currentSector: number,
      direction: "encoded" | "forward" | "backward",
    ): number | undefined => {
      const offset = value & 0x3fff_ffff;
      if (value === 0 || offset === 0x3fff_ffff) {
        return undefined;
      }
      if (offset === 0) {
        throw new Error("DVD VOB navigation reference is invalid");
      }
      const backward = direction === "backward" ||
        direction === "encoded" && (value & 0x8000_0000) !== 0;
      const target = backward
        ? currentSector - offset
        : currentSector + offset;
      if (
        target < 0 ||
        target >= vobSectorCount ||
        !navigationSectors.has(target)
      ) {
        throw new Error("DVD VOB navigation reference is invalid");
      }
      return target;
    };

    const readButtonCommands = (navPack: Buffer): readonly DvdVmCommand[] => {
      const highlightOffset = DVD_NAV_PCI_PAYLOAD_OFFSET + 96;
      const highlightStatus = navPack.readUInt16BE(highlightOffset);
      const groupWord = navPack.readUInt16BE(highlightOffset + 14);
      const groupCount = groupWord >> 12 & 0x03;
      const buttonCount = navPack[highlightOffset + 17]!;
      const selectableButtonCount = navPack[highlightOffset + 18]!;
      const forcedSelection = navPack[highlightOffset + 20]!;
      const forcedActivation = navPack[highlightOffset + 21]!;
      if (
        (highlightStatus & 0xfffc) !== 0 ||
        (groupWord & 0xc888) !== 0 ||
        (buttonCount & 0xc0) !== 0 ||
        buttonCount > 36 ||
        (selectableButtonCount & 0xc0) !== 0 ||
        selectableButtonCount > buttonCount ||
        (forcedSelection & 0xc0) !== 0 ||
        (forcedSelection & 0x3f) > buttonCount ||
        (forcedActivation & 0xc0) !== 0 ||
        (forcedActivation & 0x3f) > buttonCount ||
        navPack[highlightOffset + 19] !== 0 ||
        ((highlightStatus & 0x03) !== 0 &&
          (groupCount === 0 || buttonCount === 0)) ||
        ((groupCount === 0) !== (buttonCount === 0))
      ) {
        throw new Error("DVD VOB button navigation is malformed");
      }
      const commands: DvdVmCommand[] = [];
      const buttonsPerGroup = groupCount === 0 ? 0 : 36 / groupCount;
      if (buttonCount > buttonsPerGroup) {
        throw new Error("DVD VOB button navigation is malformed");
      }
      const buttonTableOffset = highlightOffset + 46;
      for (let group = 0; group < groupCount; group += 1) {
        for (let button = 0; button < buttonsPerGroup; button += 1) {
          const entryOffset = buttonTableOffset +
            (group * buttonsPerGroup + button) * 18;
          const entry = navPack.subarray(entryOffset, entryOffset + 18);
          const active = button < buttonCount;
          if (!active) {
            if (entry.some((byte) => byte !== 0)) {
              throw new Error("DVD VOB button navigation is malformed");
            }
            continue;
          }
          const horizontal = entry.readUIntBE(0, 3);
          const vertical = entry.readUIntBE(3, 3);
          const xStart = horizontal >> 12 & 0x03ff;
          const xEnd = horizontal & 0x03ff;
          const yStart = vertical >> 12 & 0x03ff;
          const yEnd = vertical & 0x03ff;
          const directionalTargets = [6, 7, 8, 9].map((offset) =>
            entry[offset]! & 0x3f
          );
          if (
            (horizontal & 0x0c00) !== 0 ||
            (vertical & 0x0c00) !== 0 ||
            xStart > xEnd ||
            yStart > yEnd ||
            [6, 7, 8, 9].some((offset) => (entry[offset]! & 0xc0) !== 0) ||
            directionalTargets.some((target) => target > buttonCount)
          ) {
            throw new Error("DVD VOB button navigation is malformed");
          }
          commands.push(readDvdVmCommand(entry.subarray(10, 18)));
        }
      }
      if (
        groupCount === 0 &&
        navPack.subarray(buttonTableOffset, buttonTableOffset + 36 * 18)
          .some((byte) => byte !== 0)
      ) {
        throw new Error("DVD VOB button navigation is malformed");
      }
      return commands;
    };

    const orderedNavigationSectors = [...navigationSectors].sort(
      (left, right) => left - right,
    );
    const identities = new Map<number, DvdNavigationIdentity>();
    for (const [index, sector] of orderedNavigationSectors.entries()) {
      const navPack = await readVobSector(files, sector);
      if (
        navPack.readUInt32BE(0) !== DVD_PROGRAM_STREAM_PACK_START_CODE ||
        navPack.readUInt32BE(DVD_NAV_PCI_PACKET_OFFSET) !==
          DVD_PRIVATE_STREAM_2_START_CODE ||
        navPack.readUInt16BE(DVD_NAV_PCI_PACKET_OFFSET + 4) !== 0x03d4 ||
        navPack[DVD_NAV_PCI_PAYLOAD_OFFSET - 1] !== 0 ||
        navPack.readUInt32BE(DVD_NAV_DSI_PACKET_OFFSET) !==
          DVD_PRIVATE_STREAM_2_START_CODE ||
        navPack.readUInt16BE(DVD_NAV_DSI_PACKET_OFFSET + 4) !== 0x03fa ||
        navPack[DVD_NAV_DSI_PAYLOAD_OFFSET - 1] !== 1
      ) {
        throw new Error("DVD VOB navigation pack is malformed");
      }
      const pciLbn = navPack.readUInt32BE(DVD_NAV_PCI_PAYLOAD_OFFSET);
      const pciStartTime = navPack.readUInt32BE(
        DVD_NAV_PCI_PAYLOAD_OFFSET + 12,
      );
      const pciEndTime = navPack.readUInt32BE(
        DVD_NAV_PCI_PAYLOAD_OFFSET + 16,
      );
      const dsiLbn = navPack.readUInt32BE(DVD_NAV_DSI_PAYLOAD_OFFSET + 4);
      const vobuEndAddress = navPack.readUInt32BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 8,
      );
      const referenceEndAddresses = [12, 16, 20].map((offset) =>
        navPack.readUInt32BE(DVD_NAV_DSI_PAYLOAD_OFFSET + offset)
      );
      const vobId = navPack.readUInt16BE(DVD_NAV_DSI_PAYLOAD_OFFSET + 24);
      const cellNumber = navPack[DVD_NAV_DSI_PAYLOAD_OFFSET + 27]!;
      const nextSector = orderedNavigationSectors[index + 1];
      if (
        pciLbn !== sector ||
        dsiLbn !== sector ||
        pciStartTime === 0 ||
        pciEndTime < pciStartTime ||
        vobId <= 0 ||
        navPack[DVD_NAV_DSI_PAYLOAD_OFFSET + 26] !== 0 ||
        cellNumber <= 0 ||
        sector + vobuEndAddress >= vobSectorCount ||
        referenceEndAddresses.some((address) =>
          address !== 0 && address > vobuEndAddress
        ) ||
        (nextSector !== undefined &&
          sector + vobuEndAddress >= nextSector)
      ) {
        throw new Error("DVD VOB navigation data is malformed");
      }
      for (let angle = 0; angle < 9; angle += 1) {
        referencedNavigationSector(
          navPack.readUInt32BE(DVD_NAV_PCI_PAYLOAD_OFFSET + 60 + angle * 4),
          sector,
          "encoded",
        );
        const seamlessAngleOffset = DVD_NAV_DSI_PAYLOAD_OFFSET + 180 +
          angle * 6;
        const seamlessAngleAddress = navPack.readUInt32BE(
          seamlessAngleOffset,
        );
        const seamlessAngleSize = navPack.readUInt16BE(
          seamlessAngleOffset + 4,
        );
        referencedNavigationSector(
          seamlessAngleAddress,
          sector,
          "encoded",
        );
        const hasSeamlessAngleAddress = seamlessAngleAddress !== 0 &&
          (seamlessAngleAddress & 0x3fff_ffff) !== 0x3fff_ffff;
        if (hasSeamlessAngleAddress !== (seamlessAngleSize !== 0)) {
          throw new Error("DVD VOB seamless angle reference is malformed");
        }
      }
      const interleavedUnitEnd = navPack.readUInt32BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 34,
      );
      const nextInterleavedUnit = navPack.readUInt32BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 38,
      );
      const nextInterleavedUnitSize = navPack.readUInt16BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 42,
      );
      const hasNextInterleavedUnit = nextInterleavedUnit !== 0 &&
        (nextInterleavedUnit & 0x3fff_ffff) !== 0x3fff_ffff;
      if (
        sector + interleavedUnitEnd >= vobSectorCount ||
        hasNextInterleavedUnit !== (nextInterleavedUnitSize !== 0)
      ) {
        throw new Error("DVD VOB interleaved-unit reference is malformed");
      }
      referencedNavigationSector(
        nextInterleavedUnit,
        sector,
        "encoded",
      );
      const searchOffset = DVD_NAV_DSI_PAYLOAD_OFFSET + 234;
      referencedNavigationSector(
        navPack.readUInt32BE(searchOffset),
        sector,
        "forward",
      );
      for (let search = 0; search < 19; search += 1) {
        referencedNavigationSector(
          navPack.readUInt32BE(searchOffset + 4 + search * 4),
          sector,
          "forward",
        );
      }
      referencedNavigationSector(
        navPack.readUInt32BE(searchOffset + 80),
        sector,
        "forward",
      );
      referencedNavigationSector(
        navPack.readUInt32BE(searchOffset + 84),
        sector,
        "backward",
      );
      for (let search = 0; search < 19; search += 1) {
        referencedNavigationSector(
          navPack.readUInt32BE(searchOffset + 88 + search * 4),
          sector,
          "backward",
        );
      }
      referencedNavigationSector(
        navPack.readUInt32BE(searchOffset + 164),
        sector,
        "backward",
      );
      const audioSyncOffset = searchOffset + 168;
      for (let stream = 0; stream < 8; stream += 1) {
        const address = navPack.readUInt16BE(audioSyncOffset + stream * 2);
        const offset = address & 0x3fff;
        if (address !== 0 && offset !== 0x3fff && offset > vobuEndAddress) {
          throw new Error("DVD VOB audio synchronization is malformed");
        }
      }
      const subpictureSyncOffset = audioSyncOffset + 16;
      for (let stream = 0; stream < 32; stream += 1) {
        const address = navPack.readUInt32BE(
          subpictureSyncOffset + stream * 4,
        );
        const offset = address & 0x3fff_ffff;
        if (address !== 0 && offset !== 0x3fff_ffff && offset > vobuEndAddress) {
          throw new Error("DVD VOB subpicture synchronization is malformed");
        }
      }
      identities.set(sector, {
        buttonCommands: readButtonCommands(navPack),
        cellNumber,
        vobId,
      });
    }
    return identities;
  };

  const validateNavigationCellAddresses = (
    identities: ReadonlyMap<number, DvdNavigationIdentity>,
    cellAddresses: ReadonlyMap<string, DvdCellAddress>,
  ): void => {
    for (const [sector, identity] of identities) {
      const address = cellAddresses.get(
        `${identity.vobId}:${identity.cellNumber}`,
      );
      if (
        address === undefined ||
        sector < address.firstSector ||
        sector > address.lastSector
      ) {
        throw new Error("DVD VOB navigation cell identity is invalid");
      }
    }
    for (const address of cellAddresses.values()) {
      const firstVobu = identities.get(address.firstSector);
      if (
        firstVobu?.vobId !== address.vobId ||
        firstVobu.cellNumber !== address.cellNumber
      ) {
        throw new Error("DVD cell address has no matching navigation data");
      }
    }
  };

  const navigationSectorsByCellCache = new WeakMap<
    ReadonlyMap<number, DvdNavigationIdentity>,
    ReadonlyMap<string, readonly number[]>
  >();
  const navigationSectorsByCell = (
    identities: ReadonlyMap<number, DvdNavigationIdentity>,
  ): ReadonlyMap<string, readonly number[]> => {
    const existing = navigationSectorsByCellCache.get(identities);
    if (existing !== undefined) {
      return existing;
    }
    const indexed = new Map<string, number[]>();
    for (const [sector, identity] of identities) {
      const key = `${identity.vobId}:${identity.cellNumber}`;
      const sectors = indexed.get(key) ?? [];
      sectors.push(sector);
      indexed.set(key, sectors);
    }
    for (const sectors of indexed.values()) {
      sectors.sort((left, right) => left - right);
    }
    navigationSectorsByCellCache.set(identities, indexed);
    return indexed;
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
      const { programChainUnits: units } = await readManagerNavigation(source);
      return commonProgramChainCount(units);
    })();
    managerProgramChainCountBySource.set(source, count);
    return count;
  };

  const dvdVmBits = (
    command: DvdVmCommand,
    start: number,
    count: number,
  ): number => {
    const shift = BigInt(start + 1 - count);
    return Number(
      command.instruction >> shift & (1n << BigInt(count)) - 1n,
    );
  };

  const dvdVmCommandTargetsManagerProgramChain = (
    command: DvdVmCommand,
  ): boolean =>
    dvdVmBits(command, 63, 3) === 1 &&
    dvdVmBits(command, 60, 1) === 1 &&
    (dvdVmBits(command, 51, 4) === 6 ||
      dvdVmBits(command, 51, 4) === 8) &&
    dvdVmBits(command, 23, 2) === 3;

  const dvdVmMenuTarget = (
    command: DvdVmCommand,
    currentTitleSetNumber: number,
  ): { domain: "manager" } | {
    domain: "title-set";
    titleSetNumber: number;
  } | undefined => {
    if (
      dvdVmBits(command, 63, 3) !== 1 ||
      dvdVmBits(command, 60, 1) !== 1 ||
      (dvdVmBits(command, 51, 4) !== 6 &&
        dvdVmBits(command, 51, 4) !== 8)
    ) {
      return undefined;
    }
    const targetKind = dvdVmBits(command, 23, 2);
    if (targetKind === 1) {
      return { domain: "manager" };
    }
    if (targetKind !== 2) {
      return undefined;
    }
    return {
      domain: "title-set",
      titleSetNumber: dvdVmBits(command, 51, 4) === 6
        ? dvdVmBits(command, 31, 8)
        : currentTitleSetNumber,
    };
  };

  const validateDvdVmCommand = (
    command: DvdVmCommand,
    commandCount: number,
    context: {
      angleCount: number;
      availableAudioStreamNumbers: ReadonlySet<number>;
      availableSubpictureStreamNumbers: ReadonlySet<number>;
      cellCount: number;
      commandSection: "button" | "cell" | "post" | "pre";
      currentTitleSetNumber: number;
      domain: "first-play" | "manager-menu" | "title" | "title-set-menu";
      globalTitles: readonly GlobalDvdTitle[];
      managerMenuEntryIds?: ReadonlySet<number>;
      managerProgramChainCount?: number;
      programCount: number;
      programChainCount: number;
      programChainReferences: readonly number[];
      titleSetMenuEntryIds?: ReadonlyMap<number, ReadonlySet<number>>;
    },
  ): void => {
    const validateLink = () => {
      const operation = dvdVmBits(command, 51, 4);
      if (operation === 1) {
        const linkSubOperation = dvdVmBits(command, 7, 8);
        if (
          !SUPPORTED_DVD_VM_LINK_SUB_OPERATIONS.has(
            linkSubOperation,
          )
        ) {
          throw new Error("DVD VM link command target is invalid");
        }
        const referenceIndex = linkSubOperation === 10
          ? 0
          : linkSubOperation === 11
          ? 1
          : linkSubOperation === 12
          ? 2
          : undefined;
        if (
          referenceIndex !== undefined &&
          context.programChainReferences[referenceIndex] === 0
        ) {
          throw new Error("DVD VM program chain reference is missing");
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
      if (
        (operation === 2 &&
          context.domain !== "first-play" &&
          context.domain !== "manager-menu") ||
        ((operation === 3 || operation === 5) &&
          context.domain !== "title" &&
          context.domain !== "title-set-menu") ||
        (operation === 8 && context.domain !== "title")
      ) {
        throw new Error("DVD VM jump command is illegal in this domain");
      }
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
        if (
          operation === 6 &&
          ((targetKind === 0 &&
            context.domain !== "manager-menu" &&
            context.domain !== "title-set-menu") ||
            ((targetKind === 1 || targetKind === 3) &&
              context.domain === "title") ||
            (targetKind === 2 &&
              (dvdVmBits(command, 31, 8) === 0
                ? context.domain !== "title-set-menu"
                : context.domain === "title")))
        ) {
          throw new Error("DVD VM jump command is illegal in this domain");
        }
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
          if (
            menuId < 2 ||
            menuId > 7 ||
            !context.managerMenuEntryIds?.has(menuId)
          ) {
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
            !context.titleSetMenuEntryIds?.get(titleSetNumber)?.has(menuId) ||
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
        (context.commandSection === "button" ||
          context.commandSection === "cell") && operation !== 0 ||
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
    if (commandClass === 2) {
      const systemSetOperation = dvdVmBits(command, 59, 4);
      if (![1, 2, 3, 6].includes(systemSetOperation)) {
        throw new Error("DVD VM system-set command is unsupported");
      }
      if (systemSetOperation === 1) {
        if (dvdVmBits(command, 60, 1) !== 1) {
          throw new Error("DVD VM indirect stream selection is unsupported");
        }
        if (
          dvdVmBits(command, 39, 1) !== 0 &&
          !context.availableAudioStreamNumbers.has(
            dvdVmBits(command, 38, 7),
          )
        ) {
          throw new Error("DVD VM audio stream target is invalid");
        }
        const subpicture = dvdVmBits(command, 30, 7);
        if (
          dvdVmBits(command, 31, 1) !== 0 &&
          ((subpicture & 0x20) !== 0 ||
            !context.availableSubpictureStreamNumbers.has(
              subpicture & 0x1f,
            ))
        ) {
          throw new Error("DVD VM subpicture stream target is invalid");
        }
        const angle = dvdVmBits(command, 22, 7);
        if (
          dvdVmBits(command, 23, 1) !== 0 &&
          (angle <= 0 || angle > context.angleCount)
        ) {
          throw new Error("DVD VM angle target is invalid");
        }
      } else if (systemSetOperation === 2) {
        if (dvdVmBits(command, 60, 1) !== 1) {
          throw new Error("DVD VM indirect navigation timer is unsupported");
        }
        const timer = dvdVmBits(command, 47, 16);
        const programChain = dvdVmBits(command, 30, 15);
        if (
          (timer === 0 && programChain !== 0) ||
          (timer !== 0 &&
            (programChain <= 0 || programChain > context.programChainCount))
        ) {
          throw new Error("DVD VM navigation timer target is invalid");
        }
      }
      if (dvdVmBits(command, 51, 4) !== 0) {
        validateLink();
      }
      return;
    }
    if (commandClass >= 3 && commandClass <= 6) {
      if (dvdVmBits(command, 59, 4) > 11) {
        throw new Error("DVD VM set command is unsupported");
      }
      if (commandClass === 3 && dvdVmBits(command, 51, 4) !== 0) {
        validateLink();
      } else if (
        commandClass >= 4 &&
        !SUPPORTED_DVD_VM_LINK_SUB_OPERATIONS.has(
          dvdVmBits(command, 7, 8),
        )
      ) {
        throw new Error("DVD VM link command target is invalid");
      }
      return;
    }
    throw new Error("DVD VM command class is unsupported");
  };

  const validateProgramChainNavigation = (
    chain: DvdProgramChain,
    context: {
      angleCount: number;
      audioStreamCount: number;
      cellAddresses: ReadonlyMap<string, DvdCellAddress>;
      currentTitleSetNumber: number;
      domain: "first-play" | "manager-menu" | "title" | "title-set-menu";
      globalTitles: readonly GlobalDvdTitle[];
      managerMenuEntryIds?: ReadonlySet<number>;
      managerProgramChainCount?: number;
      navigationIdentities: ReadonlyMap<number, DvdNavigationIdentity>;
      programChainCount: number;
      subpictureStreamCount: number;
      titleSetMenuEntryIds?: ReadonlyMap<number, ReadonlySet<number>>;
    },
  ): void => {
    if (
      chain.programChainReferences.some((reference) =>
        reference > context.programChainCount
      )
    ) {
      throw new Error("DVD program chain reference is invalid");
    }
    if (
      [...chain.availableAudioStreamNumbers].some((streamNumber) =>
        streamNumber >= context.audioStreamCount
      ) ||
      [...chain.availableSubpictureStreamNumbers].some((streamNumber) =>
        streamNumber >= context.subpictureStreamCount
      )
    ) {
      throw new Error("DVD program chain stream controls are malformed");
    }
    const indexedNavigationSectors = navigationSectorsByCell(
      context.navigationIdentities,
    );
    const validateCommand = (
      command: DvdVmCommand,
      commandCount: number,
      commandSection: "button" | "cell" | "post" | "pre",
    ) => validateDvdVmCommand(command, commandCount, {
      angleCount: context.angleCount,
      availableAudioStreamNumbers: chain.availableAudioStreamNumbers,
      availableSubpictureStreamNumbers:
        chain.availableSubpictureStreamNumbers,
      cellCount: chain.cells.length,
      commandSection,
      currentTitleSetNumber: context.currentTitleSetNumber,
      domain: context.domain,
      globalTitles: context.globalTitles,
      managerMenuEntryIds: context.managerMenuEntryIds,
      managerProgramChainCount: context.managerProgramChainCount,
      programCount: chain.programStartCells.length,
      programChainCount: context.programChainCount,
      programChainReferences: chain.programChainReferences,
      titleSetMenuEntryIds: context.titleSetMenuEntryIds,
    });
    for (const cell of chain.cells) {
      const cellKey = `${cell.vobId}:${cell.cellNumber}`;
      const cellAddress = context.cellAddresses.get(cellKey);
      const cellVobuStarts = indexedNavigationSectors.get(cellKey) ?? [];
      if (
        cellAddress === undefined ||
        cellAddress.firstSector !== cell.firstSector ||
        cellAddress.lastSector !== cell.lastSector ||
        cellVobuStarts[0] !== cell.firstSector ||
        cellVobuStarts.at(-1) !== cell.lastVobuStartSector
      ) {
        throw new Error("DVD program chain VOBU relationships are malformed");
      }
      for (const sector of cellVobuStarts) {
        for (
          const command of
            context.navigationIdentities.get(sector)?.buttonCommands ?? []
        ) {
          validateCommand(command, 1, "button");
        }
      }
    }
    for (const block of chain.commandBlocks) {
      for (const command of block.commands) {
        validateCommand(command, block.commands.length, block.section);
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
    navigationTargets: {
      managerMenuEntryIds?: ReadonlySet<number>;
      managerProgramChainCount?: number;
      titleSetMenuEntryIds?: ReadonlyMap<number, ReadonlySet<number>>;
    } = {},
  ) => {
    const managerMenuKey = navigationTargets.managerMenuEntryIds === undefined
      ? "unknown"
      : [...navigationTargets.managerMenuEntryIds].sort().join(",");
    const titleSetMenuKey = navigationTargets.titleSetMenuEntryIds === undefined
      ? "unknown"
      : [...navigationTargets.titleSetMenuEntryIds]
        .sort(([left], [right]) => left - right)
        .map(([number, ids]) => `${number}:${[...ids].sort().join(",")}`)
        .join(";");
    const key = `${source}:${titleSetNumber}:${titleVobSectorCount}:${navigationTargets.managerProgramChainCount ?? "unknown"}:${managerMenuKey}:${titleSetMenuKey}`;
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
      const content = await readDvdControlFile(file);
      if (
        content.byteLength < DVD_SECTOR_SIZE_BYTES ||
        content.toString("ascii", 0, 12) !== "DVDVIDEO-VTS"
      ) {
        throw new Error("DVD title-set navigation file is malformed");
      }
      validateDvdTitleSetExtentFields(
        content,
        dvdFiles,
        titleSetNumber,
        file,
      );
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
      const titleVob = titleVobLayout(dvdFiles, titleSetNumber);
      if (titleVob === undefined) {
        throw new Error("DVD title VOB layout is incomplete");
      }
      const cellAddresses = parseCellAddressTable(
        content,
        0xe0,
        titleVobSectorCount,
        true,
        "title",
      );
      const navigationIdentities = purpose.kind === "completeness-proof"
        ? await validateVobNavigationPacks(
            titleVob.parts.map((part) => part.file),
            navigationSectors,
            titleVobSectorCount,
          )
        : new Map([...navigationSectors].map((sector) => {
            const address = [...cellAddresses.values()].find((candidate) =>
              sector >= candidate.firstSector && sector <= candidate.lastSector
            );
            if (address === undefined) {
              throw new Error("DVD title VOBU has no cell address");
            }
            return [sector, {
              buttonCommands: [],
              cellNumber: address.cellNumber,
              vobId: address.vobId,
            }] as const;
          }));
      validateNavigationCellAddresses(navigationIdentities, cellAddresses);
      validateTimeMapTable(content, pgcCount, titleVobSectorCount);
      const audioStreamCount = content[0x203]!;
      const subpictureStreamCount = content[0x255]!;
      if (audioStreamCount > 8 || subpictureStreamCount > 32) {
        throw new Error("DVD title stream attributes are malformed");
      }
      const commands = [...programChains.values()].flatMap((chain) =>
        chain.commandBlocks.flatMap((block) => block.commands)
      );
      const targetsManagerProgramChain = [...programChains.values()].some(
        (chain) => chain.commandBlocks.some((block) =>
          block.commands.some(dvdVmCommandTargetsManagerProgramChain)
        )
      );
      let managerMenuEntryIds = navigationTargets.managerMenuEntryIds;
      const titleSetMenuEntryIds = new Map(
        navigationTargets.titleSetMenuEntryIds ?? [],
      );
      let managerNavigation:
        Awaited<ReturnType<typeof readManagerNavigation>> | undefined;
      for (const command of commands) {
        const target = dvdVmMenuTarget(command, titleSetNumber);
        if (target?.domain === "manager" && managerMenuEntryIds === undefined) {
          managerNavigation ??= await readManagerNavigation(source);
          managerMenuEntryIds = commonMenuEntryIds(
            managerNavigation.programChainUnits,
          );
        } else if (
          target?.domain === "title-set" &&
          !titleSetMenuEntryIds.has(target.titleSetNumber)
        ) {
          const targetNavigation = await readTitleSetMenuNavigation(
            source,
            target.titleSetNumber,
            target.titleSetNumber === titleSetNumber ? content : undefined,
          );
          titleSetMenuEntryIds.set(
            target.titleSetNumber,
            commonMenuEntryIds(targetNavigation.programChainUnits),
          );
        }
      }
      const validatedManagerProgramChainCount =
        navigationTargets.managerProgramChainCount ??
        (targetsManagerProgramChain
          ? managerNavigation === undefined
            ? await readManagerProgramChainCount(source)
            : commonProgramChainCount(managerNavigation.programChainUnits)
          : undefined);
      for (const chain of programChains.values()) {
        validateProgramChainNavigation(chain, {
          angleCount: Math.max(...globalTitles.map((title) => title.angleCount)),
          audioStreamCount,
          cellAddresses,
          currentTitleSetNumber: titleSetNumber,
          domain: "title",
          globalTitles: allGlobalTitles,
          managerMenuEntryIds,
          managerProgramChainCount: validatedManagerProgramChainCount,
          navigationIdentities,
          programChainCount: pgcCount,
          subpictureStreamCount,
          titleSetMenuEntryIds,
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
    const layout = titleVobLayout(dvdFiles, identity.titleSetNumber);
    if (layout === undefined) {
      return { outcome: "ambiguous" };
    }
    const currentPartIndex = layout.parts.findIndex(({ identity: partIdentity }) =>
      partIdentity.partNumber === identity.partNumber
    );
    if (currentPartIndex === -1) {
      return { outcome: "ambiguous" };
    }
    const precedingSectorCount = layout.parts
      .slice(0, currentPartIndex)
      .reduce(
        (total, { file }) => total + file.byteCount / DVD_SECTOR_SIZE_BYTES,
        0,
      );
    const titleVobSector = precedingSectorCount +
      extent.fileLocation.sectorOffset + badLba - extent.startLba;
    const titleVobSectorCount = layout.sectorCount;
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
    let navigationSectors: ReadonlySet<number>;
    let titleAssociations: Awaited<ReturnType<typeof readTitleAssociations>>;
    try {
      navigationSectors = await readTitleVobuAddressMap(
        dvdFiles,
        identity.titleSetNumber,
        titleVobSectorCount,
      );
      titleAssociations = await readTitleAssociations(
        extent.fileLocation.source,
        identity.titleSetNumber,
        titleVobSectorCount,
      );
    } catch (error) {
      if (
        error instanceof DvdExtentFieldError &&
        isoDvdFiles.has(ifoPath) &&
        udfDvdFiles.has(ifoPath)
      ) {
        return { outcome: "ambiguous" };
      }
      throw error;
    }
    const affectedTitleNumbers = titleAssociations
      .filter(({ sectors }) => sectors.some(({ firstSector, lastSector }) =>
        titleVobSector >= firstSector && titleVobSector <= lastSector
      ))
      .map(({ titleNumber }) => titleNumber)
      .sort((left, right) => left - right);
    if (affectedTitleNumbers.length === 0) {
      return { outcome: "ambiguous" };
    }
    const evidenceLayout = layout.parts.map(({ file }) => ({
      byteCount: file.byteCount,
      extents: normalizeDvdFileExtents(file),
      path: file.path,
    }));
    const evidenceKey = JSON.stringify({
      damagedPath: extent.fileLocation.path,
      layout: evidenceLayout,
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
    identifierEncoding: "ascii" | "joliet",
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
          identifierEncoding === "ascii" &&
            identifier.some((byte) => byte < 0x20 || byte > 0x7e)
        ) {
          throw new Error("DVD ISO path table hierarchy is malformed");
        }
        const parent = layouts[parentDirectoryNumber - 1];
        let name: string;
        if (identifierEncoding === "ascii") {
          name = identifier.toString("ascii");
        } else {
          if (identifier.byteLength % 2 !== 0) {
            throw new Error("DVD ISO path table hierarchy is malformed");
          }
          name = "";
          for (let offset = 0; offset < identifier.byteLength; offset += 2) {
            name += String.fromCharCode(identifier.readUInt16BE(offset));
          }
        }
        if (
          parent === undefined ||
          name.length === 0 ||
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
    const filesystemDescriptors: Array<{
      descriptor: Buffer;
      identifierEncoding: "ascii" | "joliet";
    }> = [];
    let volumeDescriptorCount = 0;
    let sawTerminator = false;
    for (let lba = 16; lba < 16 + MAX_DESCRIPTOR_SECTORS; lba += 1) {
      const descriptor = await readRawSector(lba);
      const hasIsoSignature =
        descriptor.toString("ascii", 1, 6) === "CD001";
      if (!hasIsoSignature) {
        if (volumeDescriptorCount === 0) {
          if (policy.continueAfterUnrecognizedIsoDescriptor(
            badSectors.has(lba),
          )) {
            continue;
          }
          return { hasIso: false, volumeSpaceSize: 0 };
        }
        throw new Error("DVD ISO volume descriptor sequence is malformed");
      }
      if (descriptor[6] !== 1) {
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
        const identifierEncoding = type === 1
          ? "ascii"
          : ["%/@", "%/C", "%/E"].includes(
              descriptor.toString("ascii", 88, 91),
            )
          ? "joliet"
          : undefined;
        if (identifierEncoding === undefined) {
          throw new Error("DVD ISO supplementary volume is unsupported");
        }
        filesystemDescriptors.push({ descriptor, identifierEncoding });
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
    for (const { descriptor, identifierEncoding } of filesystemDescriptors) {
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
        parsedPathTables.push(
          parseIsoPathTable(pathTable, byteOrder, identifierEncoding),
        );
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
        identifierEncoding,
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
    validateUdfTag(anchor, [2], 256);
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

    const recordUdfExtentDescriptor = (
      descriptor: Buffer,
      offset: number,
      description: string,
      allocated: boolean,
    ): { endLba: number; startLba: number } | undefined => {
      const extentLength = descriptor.readUInt32LE(offset);
      const startLba = descriptor.readUInt32LE(offset + 4);
      if (extentLength === 0) {
        if (startLba !== 0) {
          throw new Error(`DVD UDF ${description} extent is malformed`);
        }
        return undefined;
      }
      const sectorCount = sectorCountForBytes(extentLength);
      if (allocated) {
        addExtent(startLba, sectorCount, "filesystem_metadata");
      } else {
        recordReferencedExtent(startLba, sectorCount);
      }
      return { endLba: startLba + sectorCount, startLba };
    };

    const validateUdfLogicalVolumeIntegrity = (
      descriptor: Buffer,
      partitionsByReference: readonly UdfPartition[],
    ): { nextLength: number; nextStart: number } => {
      const integrityType = descriptor.readUInt32LE(28);
      const nextLength = descriptor.readUInt32LE(32);
      const nextStart = descriptor.readUInt32LE(36);
      const partitionCount = descriptor.readUInt32LE(72);
      const implementationUseLength = descriptor.readUInt32LE(76);
      const tablesEnd = 80 + partitionCount * 8;
      const descriptorEnd = tablesEnd + implementationUseLength;
      const declaredBodyLength = descriptor.readUInt16LE(10);
      if (
        integrityType > 1 ||
        (nextLength === 0) !== (nextStart === 0) ||
        nextLength % DVD_SECTOR_SIZE_BYTES !== 0 ||
        partitionCount !== partitionsByReference.length ||
        partitionCount > 16 ||
        implementationUseLength < 46 ||
        !Number.isSafeInteger(descriptorEnd) ||
        descriptorEnd > descriptor.byteLength ||
        declaredBodyLength !== 0 && declaredBodyLength < descriptorEnd - 16
      ) {
        throw new Error("DVD UDF logical volume integrity is malformed");
      }
      for (let index = 0; index < partitionCount; index += 1) {
        const freeSpace = descriptor.readUInt32LE(80 + index * 4);
        const partitionSize = descriptor.readUInt32LE(
          80 + partitionCount * 4 + index * 4,
        );
        if (
          partitionSize !== partitionsByReference[index]!.sectorCount ||
          freeSpace !== 0xffff_ffff && freeSpace > partitionSize
        ) {
          throw new Error("DVD UDF logical volume integrity is malformed");
        }
      }
      const implementationUseOffset = tablesEnd;
      if (
        udfEntityIdentifier(descriptor, implementationUseOffset) !==
          "*UDF LV Info"
      ) {
        throw new Error("DVD UDF integrity implementation use is malformed");
      }
      const minimumReadRevision = descriptor.readUInt16LE(
        implementationUseOffset + 40,
      );
      const minimumWriteRevision = descriptor.readUInt16LE(
        implementationUseOffset + 42,
      );
      const maximumWriteRevision = descriptor.readUInt16LE(
        implementationUseOffset + 44,
      );
      if (
        minimumReadRevision === 0 ||
        minimumWriteRevision === 0 ||
        maximumWriteRevision < minimumWriteRevision
      ) {
        throw new Error("DVD UDF integrity implementation use is malformed");
      }
      return { nextLength, nextStart };
    };

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
      let sawPrimaryVolumeDescriptor = false;
      let sawTerminator = false;
      for (let index = 0; index < sequenceSectorCount; index += 1) {
        const descriptor = await readRawSector(sequenceStartLba + index);
        const identifier = validateUdfTag(
          descriptor,
          [1, 3, 4, 5, 6, 7, 8, 9],
          sequenceStartLba + index,
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
        if (identifier === 9) {
          throw new Error(
            "DVD UDF integrity descriptor is outside its sequence",
          );
        }
        descriptorBodies.push(
          `${identifier}:${descriptor.subarray(16).toString("base64")}`,
        );
        if (identifier === 1) {
          if (sawPrimaryVolumeDescriptor) {
            throw new Error("DVD UDF primary volume descriptor is duplicated");
          }
          sawPrimaryVolumeDescriptor = true;
          recordUdfExtentDescriptor(
            descriptor,
            328,
            "volume abstract",
            true,
          );
          recordUdfExtentDescriptor(
            descriptor,
            336,
            "volume copyright",
            true,
          );
        } else if (identifier === 4) {
          if (udfEntityIdentifier(descriptor, 20) !== "*UDF LV Info") {
            throw new Error(
              "DVD UDF implementation-use volume descriptor is unsupported",
            );
          }
          validateUdfCharacterSet(descriptor, 52);
          validateUdfDstring(descriptor, 116, 128);
          validateUdfDstring(descriptor, 244, 36);
          validateUdfDstring(descriptor, 280, 36);
          validateUdfDstring(descriptor, 316, 36);
          udfEntityIdentifier(descriptor, 352);
        } else if (identifier === 5) {
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
        } else if (identifier === 7) {
          const allocationCount = descriptor.readUInt32LE(20);
          const allocationsEnd = 24 + allocationCount * 8;
          const declaredBodyLength = descriptor.readUInt16LE(10);
          if (
            allocationCount > 61 ||
            !Number.isSafeInteger(allocationsEnd) ||
            allocationsEnd > descriptor.byteLength ||
            declaredBodyLength !== 0 &&
              declaredBodyLength < allocationsEnd - 16
          ) {
            throw new Error("DVD UDF unallocated-space descriptor is malformed");
          }
          const allocations = [];
          for (
            let allocation = 0;
            allocation < allocationCount;
            allocation += 1
          ) {
            const extent = recordUdfExtentDescriptor(
              descriptor,
              24 + allocation * 8,
              "unallocated-space",
              false,
            );
            if (extent === undefined) {
              throw new Error(
                "DVD UDF unallocated-space descriptor is malformed",
              );
            }
            allocations.push(extent);
          }
          allocations.sort((left, right) =>
            left.startLba - right.startLba || left.endLba - right.endLba
          );
          for (
            let allocation = 1;
            allocation < allocations.length;
            allocation += 1
          ) {
            if (
              allocations[allocation]!.startLba <
                allocations[allocation - 1]!.endLba
            ) {
              throw new Error("DVD UDF unallocated-space extents overlap");
            }
          }
        }
      }
      if (
        !sawTerminator ||
        !sawPrimaryVolumeDescriptor ||
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
        const descriptor = await readRawSector(
          integritySequenceStart + index,
        );
        const identifier = validateUdfTag(
          descriptor,
          [8, 9],
          integritySequenceStart + index,
        );
        if (identifier === 8) {
          break;
        }
        sawIntegrityDescriptor = true;
        const next = validateUdfLogicalVolumeIntegrity(
          descriptor,
          partitionsByReference,
        );
        nextLength = next.nextLength;
        nextStart = next.nextStart;
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
    validateUdfTag(
      fileSetDescriptor,
      [256],
      logicalVolume.fileSetDescriptor.logicalBlockNumber,
    );
    if (
      fileSetDescriptor.subarray(448, 480).some((byte) => byte !== 0)
    ) {
      throw new Error("DVD UDF file set descriptor references are unsupported");
    }
    const rootIcb = readUdfLongAllocationDescriptor(fileSetDescriptor, 400);

    const visitedIcbs = new Set<string>();
    const sameUdfLongAllocationDescriptor = (
      left: UdfLongAllocationDescriptor,
      right: UdfLongAllocationDescriptor,
    ): boolean =>
      left.extentLength === right.extentLength &&
      left.extentType === right.extentType &&
      left.logicalBlockNumber === right.logicalBlockNumber &&
      left.partitionReferenceNumber === right.partitionReferenceNumber;
    const parseUdfNode = async (
      icb: UdfLongAllocationDescriptor,
      path: string,
      parentIcb: UdfLongAllocationDescriptor,
      expectedDirectory: boolean,
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
      const identifier = validateUdfTag(
        fileEntry,
        [261, 266],
        icb.logicalBlockNumber,
      );
      const fileType = fileEntry[27]!;
      const allocationType = fileEntry.readUInt16LE(34) & 0x0007;
      const unsupportedReferenceOffsets = identifier === 261
        ? [112]
        : [136, 152];
      if (unsupportedReferenceOffsets.some((offset) =>
        fileEntry.subarray(offset, offset + 16).some((byte) => byte !== 0)
      )) {
        throw new Error("DVD UDF file entry references are unsupported");
      }
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
      if (extendedAttributeLength > 0) {
        validateDvdInlineExtendedAttributes(
          fileEntry.subarray(descriptorBaseOffset, allocationOffset),
          icb.logicalBlockNumber,
        );
      }
      const isDirectory = fileType === 4;
      if (!isDirectory && fileType !== 5) {
        throw new Error("DVD UDF file type is unsupported");
      }
      if (isDirectory !== expectedDirectory) {
        throw new Error("DVD UDF directory entry type disagrees with its ICB");
      }
      const normalizedPath = path.toUpperCase();
      const dataExtents: Array<{
        byteCount: number;
        fileByteOffset: number;
        logicalBlockNumber: number;
        startLba: number;
      }> = [];
      let fileByteOffset = 0;
      if (allocationType === 2 || allocationType > 3) {
        throw new Error("DVD UDF allocation descriptors are unsupported");
      }
      if (allocationType === 3) {
        if (allocationDescriptorLength < informationLength) {
          throw new Error("DVD UDF embedded file data is truncated");
        }
      } else {
        const descriptorSize = allocationType === 0
          ? 8
          : 16;
        if (allocationDescriptorLength % descriptorSize !== 0) {
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
          const logicalBlockNumber = fileEntry.readUInt32LE(offset + 4);
          const partitionReferenceNumber = allocationType === 0
            ? icb.partitionReferenceNumber
            : fileEntry.readUInt16LE(offset + 8);
          const startLba = partitionAbsoluteLba(
            {
              extentLength,
              extentType,
              logicalBlockNumber,
              partitionReferenceNumber,
            },
            partitionsByReference,
          );
          dataExtents.push({
            byteCount: extentLength,
            fileByteOffset,
            logicalBlockNumber,
            startLba,
          });
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
      let parentEntryCount = 0;
      while (offset < directory.byteLength) {
        const blockEnd = Math.min(
          directory.byteLength,
          Math.ceil((offset + 1) / DVD_SECTOR_SIZE_BYTES) *
            DVD_SECTOR_SIZE_BYTES,
        );
        if (directory[offset] === 0 && directory[offset + 1] === 0) {
          if (directory.subarray(offset, blockEnd).some((byte) => byte !== 0)) {
            throw new Error("DVD UDF directory padding is malformed");
          }
          offset = blockEnd;
          continue;
        }
        if (offset + 38 > blockEnd) {
          throw new Error("DVD UDF directory entry is truncated");
        }
        const descriptor = directory.subarray(offset);
        const containingExtent = allocationType === 3
          ? undefined
          : dataExtents.find((extent) =>
            offset >= extent.fileByteOffset &&
            offset < extent.fileByteOffset + extent.byteCount
          );
        const expectedTagLocation = allocationType === 3
          ? icb.logicalBlockNumber
          : containingExtent === undefined
          ? undefined
          : containingExtent.logicalBlockNumber + Math.floor(
            (offset - containingExtent.fileByteOffset) /
              DVD_SECTOR_SIZE_BYTES,
          );
        if (expectedTagLocation === undefined) {
          throw new Error("DVD UDF directory entry location is invalid");
        }
        validateUdfTag(descriptor, [257], expectedTagLocation);
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
        const entryEnd = offset + recordLength;
        const identifierEnd = 38 + implementationUseLength +
          fileIdentifierLength;
        if (
          descriptor.readUInt16LE(16) !== 1 ||
          (fileCharacteristics & ~0x0e) !== 0 ||
          (fileCharacteristics & 0x04) !== 0 ||
          descriptor.subarray(30, 36).some((byte) => byte !== 0) ||
          implementationUseLength !== 0 ||
          recordLength <= 0 ||
          entryEnd > blockEnd ||
          directory.subarray(offset + identifierEnd, entryEnd).some((byte) =>
            byte !== 0
          )
        ) {
          throw new Error("DVD UDF directory entry length is invalid");
        }
        const referencedIcb = readUdfLongAllocationDescriptor(descriptor, 20);
        if ((fileCharacteristics & 0x08) !== 0) {
          if (
            fileCharacteristics !== 0x08 ||
            fileIdentifierLength !== 0 ||
            parentEntryCount !== 0 ||
            !sameUdfLongAllocationDescriptor(referencedIcb, parentIcb)
          ) {
            throw new Error("DVD UDF parent directory reference is invalid");
          }
          partitionAbsoluteLba(referencedIcb, partitionsByReference);
          parentEntryCount += 1;
        } else {
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
            referencedIcb,
            `${path}/${name}`.replace(/^\/+/, ""),
            icb,
            (fileCharacteristics & 0x02) !== 0,
            depth + 1,
          );
        }
        offset += recordLength;
      }
      if (parentEntryCount !== 1) {
        throw new Error("DVD UDF directory parent reference is missing");
      }
    };
    await parseUdfNode(rootIcb, "", rootIcb, true);
    return {
      damagedRecognition: false,
      hasUdf: true,
      partitions: partitionsByReference,
    };
  };

  const validateNoPartialExtentOverlaps = (
    extents: readonly { endLba: number; startLba: number }[],
    message: string,
  ): void => {
    const orderedExtents = [...extents].sort((left, right) =>
      left.startLba - right.startLba || left.endLba - right.endLba
    );
    let activeExtent: { endLba: number; startLba: number } | undefined;
    for (const extent of orderedExtents) {
      if (activeExtent !== undefined && extent.startLba < activeExtent.endLba) {
        if (
          extent.startLba !== activeExtent.startLba ||
          extent.endLba !== activeExtent.endLba
        ) {
          throw new Error(message);
        }
        continue;
      }
      activeExtent = extent;
    }
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
    });
    validateNoPartialExtentOverlaps(
      extents,
      `DVD ${source} file extents overlap ambiguously`,
    );
  };

  const validateFilesDoNotOverlapStructures = () => {
    const fileExtents = allocatedExtents.filter((extent) =>
      extent.fileLocation !== undefined
    );
    const structuralExtents = allocatedExtents.filter((extent) =>
      extent.fileLocation === undefined
    );
    validateNoPartialExtentOverlaps(
      structuralExtents.map((extent) => ({
        endLba: extent.startLba + extent.sectorCount,
        startLba: extent.startLba,
      })),
      "DVD filesystem structures overlap ambiguously",
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
      .map((file) => ({
        byteCount: file.byteCount,
        extents: normalizeDvdFileExtents(file),
        path: file.path,
      })),
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
        readDvdControlFile(ifo),
        readDvdControlFile(bup),
      ]);
      if (!ifoContent.equals(bupContent)) {
        throw new Error("DVD-Video backup does not match its IFO");
      }
      return ifoContent;
    };
    const managerIfoContent = await validateBackupAndReadIfo(
      "VIDEO_TS/VIDEO_TS.IFO",
      "VIDEO_TS/VIDEO_TS.BUP",
    );
    const globalTitles = await parseGlobalTitles(dvdFiles);
    const {
      audioStreamCount: managerAudioStreamCount,
      cellAddresses: managerCellAddresses,
      firstPlayProgramChain,
      menuVobSectorCount: managerMenuSectorCount,
      programChainUnits: managerProgramChainUnits,
      subpictureStreamCount: managerSubpictureStreamCount,
    } = await readManagerNavigation(
      source,
      managerIfoContent,
    );
    const managerAddressMap = parseVobuAddressMap(
      managerIfoContent,
      0xdc,
      managerMenuSectorCount,
      "menu",
    );
    const managerProgramChainCount = commonProgramChainCount(
      managerProgramChainUnits,
    );
    const managerMenuEntryIds = commonMenuEntryIds(managerProgramChainUnits);
    let managerNavigationIdentities: ReadonlyMap<
      number,
      DvdNavigationIdentity
    > = new Map();
    if (managerMenuSectorCount > 0) {
      const managerMenuVob = dvdFiles.get("VIDEO_TS/VIDEO_TS.VOB");
      if (managerMenuVob === undefined) {
        throw new Error("DVD menu VOB layout is malformed");
      }
      managerNavigationIdentities = await validateVobNavigationPacks(
        [managerMenuVob],
        managerAddressMap,
        managerMenuSectorCount,
      );
      validateNavigationCellAddresses(
        managerNavigationIdentities,
        managerCellAddresses,
      );
    }
    const menuNavigation = [{
      addressMap: [...managerAddressMap],
      programChainUnits: managerProgramChainUnits,
      titleSetNumber: 0,
    }];
    const titleSetNumbers = [...new Set(
      globalTitles.map((title) => title.titleSetNumber),
    )].sort((left, right) => left - right);
    const filesystemTitleSetNumbers = new Set<number>();
    for (const path of dvdPaths) {
      if (!path.startsWith("VIDEO_TS/VTS_")) {
        continue;
      }
      const match = /^VIDEO_TS\/VTS_(\d{2})_([0-9])\.(IFO|BUP|VOB)$/.exec(
        path,
      );
      if (
        match === null ||
        (match[2] === "0"
          ? !["IFO", "BUP", "VOB"].includes(match[3]!)
          : match[3] !== "VOB")
      ) {
        throw new Error("DVD title-set file inventory is unsupported");
      }
      filesystemTitleSetNumbers.add(Number(match[1]));
    }
    if (
      filesystemTitleSetNumbers.size !== titleSetNumbers.length ||
      titleSetNumbers.some((number) => !filesystemTitleSetNumbers.has(number))
    ) {
      throw new Error("DVD title-set file inventory disagrees with its titles");
    }
    const titleSetLayouts = new Map<number, {
      audioStreamCount: number;
      cellAddresses: ReadonlyMap<string, DvdCellAddress>;
      layout: NonNullable<ReturnType<typeof titleVobLayout>>;
      menuAddressMap: ReadonlySet<number>;
      menuNavigationIdentities: ReadonlyMap<number, DvdNavigationIdentity>;
      menuProgramChainUnits: ReturnType<typeof parseMenuProgramChainUnits>;
      subpictureStreamCount: number;
    }>();
    for (const titleSetNumber of titleSetNumbers) {
      const layout = titleVobLayout(dvdFiles, titleSetNumber);
      if (layout === undefined) {
        throw new Error("DVD title VOB layout is incomplete");
      }
      const titleVobSectorCount = layout.sectorCount;
      const titleSetPrefix = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0`;
      const titleSetIfoContent = await validateBackupAndReadIfo(
        `${titleSetPrefix}.IFO`,
        `${titleSetPrefix}.BUP`,
      );
      const {
        audioStreamCount,
        cellAddresses,
        menuVobSectorCount: titleSetMenuSectorCount,
        programChainUnits: titleSetProgramChainUnits,
        subpictureStreamCount,
      } = await readTitleSetMenuNavigation(
        source,
        titleSetNumber,
        titleSetIfoContent,
      );
      const titleSetAddressMap = parseVobuAddressMap(
        titleSetIfoContent,
        0xdc,
        titleSetMenuSectorCount,
        "menu",
      );
      let menuNavigationIdentities: ReadonlyMap<
        number,
        DvdNavigationIdentity
      > = new Map();
      if (titleSetMenuSectorCount > 0) {
        const titleSetMenuVob = dvdFiles.get(`${titleSetPrefix}.VOB`);
        if (titleSetMenuVob === undefined) {
          throw new Error("DVD menu VOB layout is malformed");
        }
        menuNavigationIdentities = await validateVobNavigationPacks(
          [titleSetMenuVob],
          titleSetAddressMap,
          titleSetMenuSectorCount,
        );
        validateNavigationCellAddresses(
          menuNavigationIdentities,
          cellAddresses,
        );
      }
      titleSetLayouts.set(titleSetNumber, {
        audioStreamCount,
        cellAddresses,
        layout,
        menuAddressMap: titleSetAddressMap,
        menuNavigationIdentities,
        menuProgramChainUnits: titleSetProgramChainUnits,
        subpictureStreamCount,
      });
      menuNavigation.push({
        addressMap: [...titleSetAddressMap],
        programChainUnits: titleSetProgramChainUnits,
        titleSetNumber,
      });
    }
    const titleSetMenuEntryIds = new Map(
      [...titleSetLayouts].map(([titleSetNumber, layout]) => [
        titleSetNumber,
        commonMenuEntryIds(layout.menuProgramChainUnits),
      ] as const),
    );
    const maximumAngleCount = Math.max(
      ...globalTitles.map((title) => title.angleCount),
    );
    if (firstPlayProgramChain !== undefined) {
      validateProgramChainNavigation(firstPlayProgramChain, {
        angleCount: maximumAngleCount,
        audioStreamCount: managerAudioStreamCount,
        cellAddresses: managerCellAddresses,
        currentTitleSetNumber: 0,
        domain: "first-play",
        globalTitles,
        managerMenuEntryIds,
        managerProgramChainCount,
        navigationIdentities: managerNavigationIdentities,
        programChainCount: 1,
        subpictureStreamCount: managerSubpictureStreamCount,
        titleSetMenuEntryIds,
      });
    }
    for (const unit of managerProgramChainUnits) {
      for (const chain of unit.programChains) {
        validateProgramChainNavigation(chain, {
          angleCount: maximumAngleCount,
          audioStreamCount: managerAudioStreamCount,
          cellAddresses: managerCellAddresses,
          currentTitleSetNumber: 0,
          domain: "manager-menu",
          globalTitles,
          managerMenuEntryIds,
          managerProgramChainCount: unit.programChains.length,
          navigationIdentities: managerNavigationIdentities,
          programChainCount: unit.programChains.length,
          subpictureStreamCount: managerSubpictureStreamCount,
          titleSetMenuEntryIds,
        });
      }
    }
    for (const [titleSetNumber, titleSetLayout] of titleSetLayouts) {
      await readTitleAssociations(
        source,
        titleSetNumber,
        titleSetLayout.layout.sectorCount,
        {
          managerMenuEntryIds,
          managerProgramChainCount,
          titleSetMenuEntryIds,
        },
      );
      for (const unit of titleSetLayout.menuProgramChainUnits) {
        for (const chain of unit.programChains) {
          validateProgramChainNavigation(chain, {
            angleCount: Math.max(...globalTitles.filter((title) =>
              title.titleSetNumber === titleSetNumber
            ).map((title) => title.angleCount)),
            audioStreamCount: titleSetLayout.audioStreamCount,
            cellAddresses: titleSetLayout.cellAddresses,
            currentTitleSetNumber: titleSetNumber,
            domain: "title-set-menu",
            globalTitles,
            managerMenuEntryIds,
            managerProgramChainCount,
            navigationIdentities:
              titleSetLayout.menuNavigationIdentities,
            programChainCount: unit.programChains.length,
            subpictureStreamCount: titleSetLayout.subpictureStreamCount,
            titleSetMenuEntryIds,
          });
        }
      }
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
