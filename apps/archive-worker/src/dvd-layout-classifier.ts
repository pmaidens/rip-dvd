import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { UnreadableSectorRange } from "@rip-dvd/data-access";

import {
  DVD_SECTOR_SIZE_BYTES,
} from "./dvd-recovery-contracts.js";
import type { DvdSalvageRejectionReason } from "./dvd-salvage-validator.js";

const MAX_DESCRIPTOR_SECTORS = 256;
const MAX_AGGREGATE_DIRECTORY_BYTES = 128 * 1_024 * 1_024;
const MAX_AGGREGATE_PATH_BYTES = 16 * 1_024 * 1_024;
const MAX_DIRECTORY_BYTES = 16 * 1_024 * 1_024;
const MAX_DIRECTORY_DEPTH = 256;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_FILE_ENTRY_BYTES = 1_048_576;
const MAX_DVD_CONTROL_FILE_BYTES = MAX_FILE_ENTRY_BYTES * 16;
const MAX_DVD_CONTROL_CACHE_BYTES = 128 * 1_024 * 1_024;
const MAX_DVD_NAVIGATION_OBJECTS = 250_000;
const MAX_REFERENCED_EXTENTS = 250_000;
const MAX_UNREADABLE_SECTORS = 250_000;
const MAX_UDF_ALLOCATION_DESCRIPTORS = 50_000;
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
  depth: number;
  extendedAttributeSectorCount: number;
  extentLba: number;
  path: string;
  pathByteCount: number;
}

interface DvdFilesystemView {
  dvdFiles: Map<string, DvdFileLayout>;
  dvdPaths: Set<string>;
  key: string;
  normalizedNodePaths: Set<string>;
  source: "iso" | "udf";
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
  validateIsoDirectoryRecordTail(
    record: Buffer,
    identifierEnd: number,
    identifierLength: number,
  ): void;
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
      validateIsoDirectoryRecordTail() {},
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
    validateIsoDirectoryRecordTail(
      record,
      identifierEnd,
      identifierLength,
    ) {
      const systemUseOffset = identifierEnd +
        (identifierLength % 2 === 0 ? 1 : 0);
      if (
        systemUseOffset !== record.byteLength ||
        identifierLength % 2 === 0 && record[identifierEnd] !== 0
      ) {
        throw new Error("DVD ISO directory record is unsupported");
      }
    },
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

function badSectorSet(
  ranges: readonly UnreadableSectorRange[],
  totalSectorCount: number,
): Set<number> {
  let unreadableSectorCount = 0;
  let previousEndLba = -1;
  for (const range of ranges) {
    const endLba = range.startLba + range.sectorCount;
    if (
      !Number.isSafeInteger(range.startLba) ||
      range.startLba < 0 ||
      !Number.isSafeInteger(range.sectorCount) ||
      range.sectorCount <= 0 ||
      !Number.isSafeInteger(endLba) ||
      endLba > totalSectorCount
    ) {
      throw new Error("DVD salvage damage map exceeds the image");
    }
    if (range.startLba <= previousEndLba) {
      throw new Error("DVD salvage damage map is not normalized");
    }
    unreadableSectorCount += range.sectorCount;
    if (
      !Number.isSafeInteger(unreadableSectorCount) ||
      unreadableSectorCount > MAX_UNREADABLE_SECTORS
    ) {
      throw new Error("DVD salvage damage map exceeds its safety bound");
    }
    previousEndLba = endLba;
  }
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
  let expectedCrcLength: number;
  if ([1, 2, 3, 4, 5, 8, 256].includes(identifier)) {
    expectedCrcLength = 496;
  } else if (identifier === 6) {
    if (buffer.byteLength < 268) {
      throw new Error("DVD UDF descriptor CRC length is invalid");
    }
    expectedCrcLength = 424 + buffer.readUInt32LE(264);
  } else if (identifier === 7) {
    if (buffer.byteLength < 24) {
      throw new Error("DVD UDF descriptor CRC length is invalid");
    }
    expectedCrcLength = 8 + buffer.readUInt32LE(20) * 8;
  } else if (identifier === 9) {
    if (buffer.byteLength < 80) {
      throw new Error("DVD UDF descriptor CRC length is invalid");
    }
    expectedCrcLength = 64 + buffer.readUInt32LE(72) * 8 +
      buffer.readUInt32LE(76);
  } else if (identifier === 257) {
    expectedCrcLength = buffer.byteLength - 16;
  } else if (identifier === 261 || identifier === 266) {
    const extendedAttributeLengthOffset = identifier === 261 ? 168 : 208;
    const allocationDescriptorLengthOffset = identifier === 261 ? 172 : 212;
    const descriptorBaseOffset = identifier === 261 ? 176 : 216;
    if (buffer.byteLength < descriptorBaseOffset) {
      throw new Error("DVD UDF descriptor CRC length is invalid");
    }
    expectedCrcLength = descriptorBaseOffset - 16 +
      buffer.readUInt32LE(extendedAttributeLengthOffset) +
      buffer.readUInt32LE(allocationDescriptorLengthOffset);
  } else if (identifier === 262) {
    expectedCrcLength = 8;
  } else {
    throw new Error("DVD UDF descriptor CRC length is invalid");
  }
  if (
    !Number.isSafeInteger(expectedCrcLength) ||
    expectedCrcLength < 0 ||
    expectedCrcLength > buffer.byteLength - 16 ||
    crcLength !== expectedCrcLength
  ) {
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
  return identifier.toString("latin1");
}

function validateUdfCharacterSet(buffer: Buffer, offset: number): void {
  if (
    offset < 0 ||
    offset + 64 > buffer.byteLength ||
    buffer[offset] !== 0 ||
    buffer.toString("latin1", offset + 1, offset + 24) !==
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
  const badSectors = badSectorSet(unreadableSectorRanges, totalSectorCount);
  policy.validateDamageMap(badSectors);

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
  const aggregateIsoFilesystemView: DvdFilesystemView = {
    dvdFiles: isoDvdFiles,
    dvdPaths: isoDvdPaths,
    key: "iso",
    normalizedNodePaths: new Set(),
    source: "iso",
  };
  const udfFilesystemView: DvdFilesystemView = {
    dvdFiles: udfDvdFiles,
    dvdPaths: udfDvdPaths,
    key: "udf",
    normalizedNodePaths: new Set(),
    source: "udf",
  };
  const isoFilesystemViews: DvdFilesystemView[] = [];
  let aggregateDirectoryByteCount = 0;
  let aggregateFilesystemPathByteCount = 0;
  let dvdNavigationObjectCount = 0;
  let isoDirectoryEntryCount = 0;
  let udfAllocationDescriptorCount = 0;
  let udfDirectoryEntryCount = 0;
  let maximumReferencedLba = -1;
  const consumeDirectoryBytes = (byteCount: number) => {
    const nextByteCount = aggregateDirectoryByteCount + byteCount;
    if (
      !Number.isSafeInteger(byteCount) ||
      byteCount < 0 ||
      !Number.isSafeInteger(nextByteCount) ||
      nextByteCount > MAX_AGGREGATE_DIRECTORY_BYTES
    ) {
      throw new Error("DVD directories exceed their aggregate safety bound");
    }
    aggregateDirectoryByteCount = nextByteCount;
  };
  const consumeFilesystemPath = (path: string) => {
    const byteCount = Buffer.byteLength(path);
    const nextByteCount = aggregateFilesystemPathByteCount + byteCount;
    if (
      !Number.isSafeInteger(nextByteCount) ||
      nextByteCount > MAX_AGGREGATE_PATH_BYTES
    ) {
      throw new Error(
        "DVD filesystem paths exceed their aggregate safety bound",
      );
    }
    aggregateFilesystemPathByteCount = nextByteCount;
  };
  const consumeDvdNavigationObjects = (count: number) => {
    const nextCount = dvdNavigationObjectCount + count;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(nextCount) ||
      nextCount > MAX_DVD_NAVIGATION_OBJECTS
    ) {
      throw new Error("DVD navigation data exceeds its aggregate safety bound");
    }
    dvdNavigationObjectCount = nextCount;
  };
  const consumeUdfAllocationDescriptor = () => {
    udfAllocationDescriptorCount += 1;
    if (udfAllocationDescriptorCount > MAX_UDF_ALLOCATION_DESCRIPTORS) {
      throw new Error(
        "DVD UDF allocation descriptors exceed their aggregate safety bound",
      );
    }
  };
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
    if (allocatedExtents.length >= MAX_REFERENCED_EXTENTS) {
      throw new Error("DVD filesystem extents exceed their aggregate safety bound");
    }
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
    filesystemView: DvdFilesystemView,
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
    const normalizedParentPath = parentPath.toUpperCase();
    if (filesystemView.normalizedNodePaths.has(normalizedParentPath)) {
      throw new Error("DVD ISO file layout is ambiguous");
    }
    filesystemView.normalizedNodePaths.add(normalizedParentPath);
    consumeFilesystemPath(parentPath);
    directoryLayouts.set(parentPath, {
      depth,
      extendedAttributeSectorCount,
      extentLba,
      path: parentPath,
      pathByteCount: Buffer.byteLength(parentPath),
    });
    const currentDirectory = {
      byteCount,
      extendedAttributeSectorCount,
      extentLba,
    };
    consumeDirectoryBytes(byteCount);
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
      const identifierEnd = 33 + identifierLength;
      if (
        extentLba !== extentLbaBe ||
        extentBytes !== extentBytesBe ||
        identifierEnd > record.byteLength ||
        record[26] !== 0 ||
        record[27] !== 0 ||
        record.readUInt16LE(28) !== 1 ||
        record.readUInt16BE(30) !== 1 ||
        (flags & 0x80) !== 0
      ) {
        throw new Error("DVD ISO directory record is unsupported");
      }
      policy.validateIsoDirectoryRecordTail(
        record,
        identifierEnd,
        identifierLength,
      );
      const identifier = record.subarray(33, 33 + identifierLength);
      const isSpecial = identifierLength === 1 &&
        (identifier[0] === 0 || identifier[0] === 1);
      const dataSectorCount = sectorCountForBytes(extentBytes);
      if (extentBytes > 0 || extendedAttributeSectorCount > 0) {
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
      } else {
        if (recordIndex < 2) {
          throw new Error("DVD ISO file identifier is malformed");
        }
        let decodedIdentifier: string;
        if (identifierEncoding === "ascii") {
          if (identifier.some((byte) => byte === 0 || byte === 0x2f)) {
            throw new Error("DVD ISO file identifier is malformed");
          }
          decodedIdentifier = identifier.toString("latin1");
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
          if (extentBytes === 0) {
            throw new Error("DVD ISO directory extent is invalid");
          }
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
            filesystemView,
            currentDirectory,
            depth + 1,
          );
        } else {
          const normalizedPath = path.toUpperCase();
          if (filesystemView.normalizedNodePaths.has(normalizedPath)) {
            throw new Error("DVD ISO file layout is ambiguous");
          }
          filesystemView.normalizedNodePaths.add(normalizedPath);
          consumeFilesystemPath(normalizedPath);
          filesystemView.dvdPaths.add(normalizedPath);
          isoDvdPaths.add(normalizedPath);
          const fileLayout = {
            byteCount: extentBytes,
            embedded: false,
            extents: extentBytes === 0
              ? []
              : [{ byteCount: extentBytes, startLba: dataLba }],
            path: normalizedPath,
          } satisfies DvdFileLayout;
          const existingFile = isoDvdFiles.get(normalizedPath);
          const existingViewFile = filesystemView.dvdFiles.get(normalizedPath);
          if (
            existingViewFile !== undefined ||
            existingFile !== undefined &&
              JSON.stringify(existingFile) !== JSON.stringify(fileLayout)
          ) {
            throw new Error("DVD ISO file layout is ambiguous");
          }
          filesystemView.dvdFiles.set(normalizedPath, fileLayout);
          isoDvdFiles.set(normalizedPath, fileLayout);
          if (extentBytes > 0) {
            addExtent(
              dataLba,
              dataSectorCount,
              classifyDvdPath(path),
              {
                path: normalizedPath,
                sectorOffset: 0,
                source: "iso",
              },
            );
          }
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

  const dvdControlFileContents = new Map<string, Promise<Buffer>>();
  let cachedDvdControlFileBytes = 0;
  const readDvdControlFile = (file: DvdFileLayout): Promise<Buffer> => {
    const cacheKey = JSON.stringify({
      byteCount: file.byteCount,
      embedded: file.embedded,
      extents: file.extents,
    });
    const existing = dvdControlFileContents.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }
    if (
      file.byteCount <= 0 ||
      file.byteCount >
        MAX_DVD_CONTROL_CACHE_BYTES - cachedDvdControlFileBytes
    ) {
      throw new Error("DVD-Video control files exceed their aggregate bound");
    }
    cachedDvdControlFileBytes += file.byteCount;
    const content = readDvdFile(file, MAX_DVD_CONTROL_FILE_BYTES);
    dvdControlFileContents.set(cacheKey, content);
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

  const validateDvdInformationExtentFields = (
    content: Buffer,
    {
      errorMessage,
      ifo,
      ifoDescription,
      menuVob,
      relatedFiles,
      titleVob,
    }: {
      errorMessage: string;
      ifo: DvdFileLayout;
      ifoDescription: string;
      menuVob?: DvdFileLayout;
      relatedFiles: readonly DvdFileLayout[];
      titleVob?: DvdFileLayout;
    },
  ): void => {
    const ifoRange = contiguousDvdFileRange(ifo, ifoDescription);
    const relatedRanges = relatedFiles.map((file) =>
      contiguousDvdFileRange(file, `${ifoDescription} related file`)
    );
    const expectedLastSector = Math.max(
      ...relatedRanges.map((range) => range.endLba),
    ) - ifoRange.startLba - 1;
    const expectedMenuStart = menuVob === undefined
      ? 0
      : contiguousDvdFileRange(menuVob, `${ifoDescription} menu VOB`).startLba -
        ifoRange.startLba;
    const expectedTitleStart = titleVob === undefined
      ? undefined
      : contiguousDvdFileRange(titleVob, "title VOB").startLba -
        ifoRange.startLba;
    const lastByte = content.readUInt32BE(0x80);
    if (
      content.readUInt32BE(0x0c) !== expectedLastSector ||
      content.readUInt32BE(0x1c) !== ifoRange.sectorCount - 1 ||
      lastByte < 341 ||
      lastByte >= ifo.byteCount ||
      Math.floor(lastByte / DVD_SECTOR_SIZE_BYTES) >
        content.readUInt32BE(0x1c) ||
      content.readUInt32BE(0xc0) !== expectedMenuStart ||
      expectedTitleStart !== undefined &&
        content.readUInt32BE(0xc4) !== expectedTitleStart
    ) {
      throw new DvdExtentFieldError(errorMessage);
    }
  };

  const validateDvdManagerExtentFields = (
    content: Buffer,
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    managerIfo: DvdFileLayout,
  ): void => {
    const managerPaths = [
      "VIDEO_TS/VIDEO_TS.IFO",
      "VIDEO_TS/VIDEO_TS.BUP",
      "VIDEO_TS/VIDEO_TS.VOB",
    ];
    const managerFiles = managerPaths.flatMap((path) => {
      const file = dvdFiles.get(path);
      return file === undefined ? [] : [file];
    });
    validateDvdInformationExtentFields(content, {
      errorMessage: "DVD video manager extent fields are malformed",
      ifo: managerIfo,
      ifoDescription: "video manager IFO",
      menuVob: dvdFiles.get("VIDEO_TS/VIDEO_TS.VOB"),
      relatedFiles: managerFiles,
    });
  };

  const validateDvdTitleSetExtentFields = (
    content: Buffer,
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumber: number,
    titleSetIfo: DvdFileLayout,
  ): void => {
    const prefix = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}`;
    const titleSetFiles = [...dvdFiles.values()].filter((file) =>
      file.path.startsWith(`${prefix}_`)
    );
    const menuVob = dvdFiles.get(`${prefix}_0.VOB`);
    const titleVob = dvdFiles.get(`${prefix}_1.VOB`);
    if (titleVob === undefined) {
      throw new Error("DVD title VOB layout is incomplete");
    }
    validateDvdInformationExtentFields(content, {
      errorMessage: "DVD title-set extent fields are malformed",
      ifo: titleSetIfo,
      ifoDescription: "title-set IFO",
      menuVob,
      relatedFiles: titleSetFiles,
      titleVob,
    });
  };

  const readDvdManagerTable = (
    content: Buffer,
    {
      description,
      lastByteOffset,
      minimumByteCount,
      pointerOffset,
      required,
    }: {
      description: string;
      lastByteOffset: number;
      minimumByteCount: number;
      pointerOffset: number;
      required: boolean;
    },
  ): Buffer | undefined => {
    const tableSector = content.readUInt32BE(pointerOffset);
    if (tableSector === 0) {
      if (required) {
        throw new Error(`DVD ${description} table is missing`);
      }
      return undefined;
    }
    const tableOffset = tableSector * DVD_SECTOR_SIZE_BYTES;
    const managerInformationByteCount =
      (content.readUInt32BE(0x1c) + 1) * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(tableOffset) ||
      !Number.isSafeInteger(managerInformationByteCount) ||
      managerInformationByteCount > content.byteLength ||
      tableOffset < DVD_SECTOR_SIZE_BYTES ||
      tableOffset + minimumByteCount > managerInformationByteCount
    ) {
      throw new Error(`DVD ${description} table is outside the video manager`);
    }
    const tableByteCount = content.readUInt32BE(
      tableOffset + lastByteOffset,
    ) + 1;
    if (
      tableByteCount < minimumByteCount ||
      tableOffset + tableByteCount > managerInformationByteCount
    ) {
      throw new Error(`DVD ${description} table is malformed`);
    }
    return content.subarray(tableOffset, tableOffset + tableByteCount);
  };

  const validateNoByteRangeOverlaps = (
    ranges: readonly { end: number; start: number }[],
    message: string,
  ): void => {
    const orderedRanges = [...ranges].sort((left, right) =>
      left.start - right.start || left.end - right.end
    );
    for (let index = 1; index < orderedRanges.length; index += 1) {
      if (orderedRanges[index]!.start < orderedRanges[index - 1]!.end) {
        throw new Error(message);
      }
    }
  };

  const validateDvdParentalManagementTable = (
    content: Buffer,
    expectedTitleSetCount: number,
  ): void => {
    const parentalTable = readDvdManagerTable(content, {
      description: "parental management",
      lastByteOffset: 4,
      minimumByteCount: 8,
      pointerOffset: 0xcc,
      required: false,
    });
    if (parentalTable !== undefined) {
      const countryCount = parentalTable.readUInt16BE(0);
      const titleSetCount = parentalTable.readUInt16BE(2);
      const countryTableEnd = 8 + countryCount * 8;
      const parentalMaskByteCount = (titleSetCount + 1) * 16;
      if (
        countryCount <= 0 ||
        countryCount > 99 ||
        titleSetCount !== expectedTitleSetCount ||
        countryTableEnd > parentalTable.byteLength
      ) {
        throw new Error("DVD parental management table is malformed");
      }
      const maskRanges: Array<{ end: number; start: number }> = [];
      const countryCodes = new Set<number>();
      const maskOffsets = new Set<number>();
      for (let index = 0; index < countryCount; index += 1) {
        const countryOffset = 8 + index * 8;
        const countryCode = parentalTable.readUInt16BE(countryOffset);
        const maskOffset = parentalTable.readUInt16BE(countryOffset + 4);
        if (
          countryCode === 0 ||
          countryCodes.has(countryCode) ||
          maskOffsets.has(maskOffset) ||
          parentalTable.readUInt16BE(countryOffset + 2) !== 0 ||
          parentalTable.readUInt16BE(countryOffset + 6) !== 0 ||
          maskOffset < countryTableEnd ||
          maskOffset + parentalMaskByteCount > parentalTable.byteLength
        ) {
          throw new Error("DVD parental management table is malformed");
        }
        countryCodes.add(countryCode);
        maskOffsets.add(maskOffset);
        maskRanges.push({
          end: maskOffset + parentalMaskByteCount,
          start: maskOffset,
        });
      }
      validateNoByteRangeOverlaps(
        maskRanges,
        "DVD parental management table overlaps ambiguously",
      );
    }
  };

  const validateDvdTitleSetAttributeTable = async (
    content: Buffer,
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumbers: readonly number[],
  ): Promise<void> => {
    const attributeTable = readDvdManagerTable(content, {
      description: "title-set attribute",
      lastByteOffset: 4,
      minimumByteCount: 8,
      pointerOffset: 0xd0,
      required: true,
    })!;
    const attributeCount = attributeTable.readUInt16BE(0);
    const attributeOffsetsEnd = 8 + attributeCount * 4;
    if (
      attributeCount !== titleSetNumbers.length ||
      attributeCount <= 0 ||
      attributeCount > 99 ||
      attributeTable.readUInt16BE(2) !== 0 ||
      attributeOffsetsEnd > attributeTable.byteLength
    ) {
      throw new Error("DVD title-set attribute table is malformed");
    }
    let previousAttributeEnd = attributeOffsetsEnd;
    for (let index = 0; index < attributeCount; index += 1) {
      const attributeOffset = attributeTable.readUInt32BE(8 + index * 4);
      if (
        attributeOffset < previousAttributeEnd ||
        attributeOffset + 4 > attributeTable.byteLength
      ) {
        throw new Error("DVD title-set attribute table is malformed");
      }
      const attributeByteCount = attributeTable.readUInt32BE(attributeOffset) +
        1;
      const attributeEnd = attributeOffset + attributeByteCount;
      if (
        attributeByteCount < 356 ||
        attributeByteCount > 776 ||
        attributeEnd > attributeTable.byteLength
      ) {
        throw new Error("DVD title-set attribute table is malformed");
      }
      const attributes = attributeTable.subarray(
        attributeOffset,
        attributeEnd,
      );
      const menuAudioCount = attributes[11]!;
      const menuSubpictureCount = attributes[93]!;
      const titleAudioCount = attributes[267]!;
      const titleSubpictureCount = attributes[349]!;
      const availableTitleSubpictureCount = Math.min(
        32,
        Math.floor((attributes.byteLength - 350) / 6),
      );
      const titleSubpictureAttributesEnd =
        350 + availableTitleSubpictureCount * 6;
      const titleSetNumber = titleSetNumbers[index]!;
      const titleSetIfo = dvdFiles.get(
        `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0.IFO`,
      );
      if (titleSetIfo === undefined) {
        throw new Error("DVD title-set attribute target is missing");
      }
      const titleSetContent = await readDvdControlFile(titleSetIfo);
      if (
        attributes[10] !== 0 ||
        attributes.subarray(20, 93).some((byte) => byte !== 0) ||
        attributes.subarray(100, 264).some((byte) => byte !== 0) ||
        attributes[266] !== 0 ||
        attributes.subarray(332, 349).some((byte) => byte !== 0) ||
        menuAudioCount > 1 ||
        menuSubpictureCount > 1 ||
        titleAudioCount > 8 ||
        titleSubpictureCount > Math.min(32, availableTitleSubpictureCount) ||
        menuAudioCount !== titleSetContent[0x103] ||
        menuSubpictureCount !== titleSetContent[0x155] ||
        titleAudioCount !== titleSetContent[0x203] ||
        titleSubpictureCount !== titleSetContent[0x255] ||
        !attributes.subarray(8, 10).equals(
          titleSetContent.subarray(0x100, 0x102),
        ) ||
        !attributes.subarray(12, 20).equals(
          titleSetContent.subarray(0x104, 0x10c),
        ) ||
        !attributes.subarray(94, 100).equals(
          titleSetContent.subarray(0x156, 0x15c),
        ) ||
        !attributes.subarray(264, 266).equals(
          titleSetContent.subarray(0x200, 0x202),
        ) ||
        !attributes.subarray(268, 332).equals(
          titleSetContent.subarray(0x204, 0x244),
        ) ||
        !attributes.subarray(350, titleSubpictureAttributesEnd).equals(
          titleSetContent.subarray(
            0x256,
            0x256 + availableTitleSubpictureCount * 6,
          ),
        ) ||
        menuAudioCount === 0 &&
          attributes.subarray(12, 20).some((byte) => byte !== 0) ||
        menuSubpictureCount === 0 &&
          attributes.subarray(94, 100).some((byte) => byte !== 0) ||
        attributes.subarray(
          268 + titleAudioCount * 8,
          332,
        ).some((byte) => byte !== 0) ||
        attributes.subarray(
          350 + titleSubpictureCount * 6,
        ).some((byte) => byte !== 0)
      ) {
        throw new Error("DVD title-set attributes disagree with their IFO");
      }
      previousAttributeEnd = attributeEnd;
    }
  };

  const validateDvdTextDataManagerTable = (
    content: Buffer,
    titleCount: number,
  ): void => {
    const textTable = readDvdManagerTable(content, {
      description: "text data manager",
      lastByteOffset: 16,
      minimumByteCount: 20,
      pointerOffset: 0xd4,
      required: false,
    });
    if (textTable !== undefined) {
      const languageUnitCount = textTable.readUInt16BE(14);
      const languageUnitsEnd = 20 + languageUnitCount * 8;
      if (
        textTable.readUInt16BE(12) !== 0 ||
        languageUnitCount <= 0 ||
        languageUnitCount > 99 ||
        languageUnitsEnd > textTable.byteLength
      ) {
        throw new Error("DVD text data manager table is malformed");
      }
      const textRanges: Array<{ end: number; start: number }> = [];
      const languageCodes = new Set<number>();
      const textOffsets = new Set<number>();
      for (let index = 0; index < languageUnitCount; index += 1) {
        const unitOffset = 20 + index * 8;
        const languageCode = textTable.readUInt16BE(unitOffset);
        const characterSet = textTable[unitOffset + 3]!;
        const textOffset = textTable.readUInt32BE(unitOffset + 4);
        if (
          languageCode === 0 ||
          languageCodes.has(languageCode) ||
          textOffsets.has(textOffset) ||
          textTable[unitOffset + 2] !== 0 ||
          ![0, 1, 0x10, 0x11, 0x12].includes(characterSet) ||
          textOffset < languageUnitsEnd ||
          textOffset + 4 + (titleCount + 1) * 2 > textTable.byteLength
        ) {
          throw new Error("DVD text data manager table is malformed");
        }
        languageCodes.add(languageCode);
        textOffsets.add(textOffset);
        const textByteCount = textTable.readUInt32BE(textOffset) + 1;
        if (
          textByteCount < 4 + (titleCount + 1) * 2 ||
          textOffset + textByteCount > textTable.byteLength
        ) {
          throw new Error("DVD text data manager table is malformed");
        }
        let previousTitleOffset = 0;
        for (let titleIndex = 0; titleIndex <= titleCount; titleIndex += 1) {
          const titleOffset = textTable.readUInt16BE(
            textOffset + 4 + titleIndex * 2,
          );
          if (
            titleOffset !== 0 &&
              (titleOffset < 4 + (titleCount + 1) * 2 ||
                titleOffset >= textByteCount ||
                titleOffset < previousTitleOffset)
          ) {
            throw new Error("DVD text data manager table is malformed");
          }
          previousTitleOffset = Math.max(previousTitleOffset, titleOffset);
        }
        textRanges.push({
          end: textOffset + textByteCount,
          start: textOffset,
        });
      }
      validateNoByteRangeOverlaps(
        textRanges,
        "DVD text data manager table overlaps ambiguously",
      );
    }
  };

  const validateDvdManagerReferencedTables = async (
    content: Buffer,
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumbers: readonly number[],
    titleCount: number,
  ): Promise<void> => {
    validateDvdParentalManagementTable(content, titleSetNumbers.length);
    await validateDvdTitleSetAttributeTable(
      content,
      dvdFiles,
      titleSetNumbers,
    );
    validateDvdTextDataManagerTable(content, titleCount);
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

  const titleVobuAddressMaps = new WeakMap<
    DvdFileLayout,
    Map<number, Promise<ReadonlySet<number>>>
  >();
  const readTitleVobuAddressMap = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
    titleSetNumber: number,
    titleVobSectorCount: number,
  ): Promise<ReadonlySet<number>> => {
    const ifoPath = `VIDEO_TS/VTS_${String(titleSetNumber).padStart(2, "0")}_0.IFO`;
    const file = dvdFiles.get(ifoPath);
    if (file === undefined) {
      throw new Error("DVD title-set navigation file is missing");
    }
    const mapsByVobSize = titleVobuAddressMaps.get(file) ?? new Map();
    const existing = mapsByVobSize.get(titleVobSectorCount);
    if (existing !== undefined) {
      return existing;
    }
    const addressMap = (async () => {
      const content = await readDvdControlFile(file);
      if (
        content.byteLength < DVD_SECTOR_SIZE_BYTES ||
        content.toString("latin1", 0, 12) !== "DVDVIDEO-VTS"
      ) {
        throw new Error("DVD title-set navigation file is malformed");
      }
      return parseVobuAddressMap(
        content,
        0xe4,
        titleVobSectorCount,
        "title",
      );
    })();
    mapsByVobSize.set(titleVobSectorCount, addressMap);
    titleVobuAddressMaps.set(file, mapsByVobSize);
    return addressMap;
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
    fields: {
      angleNumber: number;
      anglePresent: boolean;
      audioStreamNumber: number;
      audioStreamPresent: boolean;
      commandClass: number;
      direct: boolean;
      globalTitleNumber: number;
      linkCellNumber: number;
      linkChapterNumber: number;
      linkProgramChainNumber: number;
      linkProgramNumber: number;
      linkSubOperation: number;
      managerProgramChainNumber: number;
      menuId: number;
      navigationTimer: number;
      navigationTimerProgramChainNumber: number;
      operation: number;
      partNumber: number;
      resumeCellNumber: number;
      setOperation: number;
      specialLineNumber: number;
      subpictureStreamPresent: boolean;
      subpictureStreamValue: number;
      targetKind: number;
      targetTitleNumber: number;
      targetTitleSetNumber: number;
    };
    toJSON: () => string;
  }

  const readDvdVmCommand = (commandBytes: Buffer): DvdVmCommand => {
    if (commandBytes.byteLength !== 8) {
      throw new Error("DVD VM command is truncated");
    }
    const encoded = commandBytes.toString("hex");
    const instruction = commandBytes.readBigUInt64BE();
    const bits = (start: number, count: number): number => {
      const shift = BigInt(start + 1 - count);
      return Number(
        instruction >> shift & (1n << BigInt(count)) - 1n,
      );
    };
    return {
      encoded,
      fields: {
        angleNumber: bits(22, 7),
        anglePresent: bits(23, 1) !== 0,
        audioStreamNumber: bits(38, 7),
        audioStreamPresent: bits(39, 1) !== 0,
        commandClass: bits(63, 3),
        direct: bits(60, 1) !== 0,
        globalTitleNumber: bits(22, 7),
        linkCellNumber: bits(7, 8),
        linkChapterNumber: bits(9, 10),
        linkProgramChainNumber: bits(14, 15),
        linkProgramNumber: bits(6, 7),
        linkSubOperation: bits(7, 8),
        managerProgramChainNumber: bits(46, 15),
        menuId: bits(19, 4),
        navigationTimer: bits(47, 16),
        navigationTimerProgramChainNumber: bits(30, 15),
        operation: bits(51, 4),
        partNumber: bits(41, 10),
        resumeCellNumber: bits(31, 8),
        setOperation: bits(59, 4),
        specialLineNumber: bits(7, 8),
        subpictureStreamPresent: bits(31, 1) !== 0,
        subpictureStreamValue: bits(30, 7),
        targetKind: bits(23, 2),
        targetTitleNumber: bits(39, 8),
        targetTitleSetNumber: bits(31, 8),
      },
      toJSON: () => encoded,
    };
  };

  interface DvdProgramChain {
    angleBlockLengths: readonly number[];
    availableAudioStreamNumbers: ReadonlySet<number>;
    availableSubpictureStreamNumbers: ReadonlySet<number>;
    byteCount: number;
    cells: readonly {
      blockMode: number;
      blockType: number;
      cellNumber: number;
      firstIlvuEndSector: number;
      firstSector: number;
      interleaved: boolean;
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
    endSector?: number;
    interleaved: boolean;
    interleavedUnitSectorCount?: number;
    vobId: number;
  }

  const readProgramChainRanges = (
    content: Buffer,
    pgcitOffset: number,
    pgcitByteCount: number,
    pgcCount: number,
    description: "menu program chain" | "program chain",
  ): readonly { endByte: number; startByte: number }[] => {
    const pointerArrayEnd = 8 + pgcCount * 8;
    const starts: number[] = [];
    const uniqueStarts = new Set<number>();
    for (let index = 0; index < pgcCount; index += 1) {
      const startByte = content.readUInt32BE(
        pgcitOffset + 8 + index * 8 + 4,
      );
      if (
        startByte < pointerArrayEnd ||
        startByte + 236 > pgcitByteCount ||
        uniqueStarts.has(startByte)
      ) {
        throw new Error(`DVD ${description} table is ambiguous`);
      }
      uniqueStarts.add(startByte);
      starts.push(startByte);
    }
    const orderedStarts = [...starts].sort((left, right) => left - right);
    const endsByStart = new Map<number, number>();
    for (const [index, startByte] of orderedStarts.entries()) {
      endsByStart.set(startByte, orderedStarts[index + 1] ?? pgcitByteCount);
    }
    return starts.map((startByte) => ({
      endByte: endsByStart.get(startByte)!,
      startByte,
    }));
  };

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
      content.toString("latin1", 0, 12) !== "DVDVIDEO-VMG"
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
    pgcStartByte: number,
    pgcEndByte: number,
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
      pgcEndByte - pgcStartByte,
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
    consumeDvdNavigationObjects(commandCount);
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

  const programChainCommandTableEndByte = (
    content: Buffer,
    pgcOffset: number,
    commandBlocks: DvdProgramChain["commandBlocks"],
  ): number => {
    const commandTableOffset = content.readUInt16BE(pgcOffset + 228);
    return commandTableOffset === 0
      ? 0
      : commandTableOffset + 8 + commandBlocks.reduce(
        (count, block) => count + block.commands.length,
        0,
      ) * 8;
  };

  const parseProgramChain = (
    content: Buffer,
    pgcitOffset: number,
    pgcStartByte: number,
    pgcEndByte: number,
    titleVobSectorCount: number,
  ): DvdProgramChain => {
    const pgcOffset = pgcitOffset + pgcStartByte;
    if (
      pgcStartByte < 8 ||
      pgcStartByte + 236 > pgcEndByte ||
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
      pgcStartByte,
      pgcEndByte,
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
      pgcStartByte + cellPositionOffset + cellCount * 4 > pgcEndByte
    ) {
      throw new Error("DVD program chain table is malformed");
    }
    consumeDvdNavigationObjects(1 + programCount + cellCount);
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
      const interleaved = (content[playbackOffset]! & 0x04) !== 0;
      const firstSector = content.readUInt32BE(playbackOffset + 8);
      const firstIlvuEndSector = content.readUInt32BE(playbackOffset + 12);
      const lastVobuStartSector = content.readUInt32BE(playbackOffset + 16);
      const lastSector = content.readUInt32BE(playbackOffset + 20);
      const vobId = content.readUInt16BE(positionOffset);
      const cellNumber = content[positionOffset + 3]!;
      if (
        firstSector > lastVobuStartSector ||
        firstSector > firstIlvuEndSector ||
        firstIlvuEndSector > lastSector ||
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
        firstIlvuEndSector,
        firstSector,
        interleaved,
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
      byteCount: Math.max(
        236,
        programChainCommandTableEndByte(content, pgcOffset, commandBlocks),
        programMapOffset + programCount,
        cellPlaybackOffset + cellCount * 24,
        cellPositionOffset + cellCount * 4,
      ),
      cells,
      commandBlocks,
      programStartCells,
    };
  };

  const parseMenuProgramChain = (
    content: Buffer,
    pgcitOffset: number,
    pgcStartByte: number,
    pgcEndByte: number,
    menuVobSectorCount: number,
  ): DvdProgramChain => {
    const pgcOffset = pgcitOffset + pgcStartByte;
    if (
      pgcStartByte < 8 ||
      pgcStartByte + 236 > pgcEndByte ||
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
        pgcStartByte,
        pgcEndByte,
        [],
      );
      consumeDvdNavigationObjects(1);
      return {
        angleBlockLengths: [],
        ...readProgramChainControls(content, pgcOffset),
        byteCount: Math.max(
          236,
          programChainCommandTableEndByte(content, pgcOffset, commandBlocks),
        ),
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
      pgcStartByte,
      pgcEndByte,
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
    const languageUnitRanges: Array<{ end: number; start: number }> = [];
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
      const languageUnitRange = {
        end: pgcitStartByte + pgcitByteCount,
        start: pgcitStartByte,
      };
      if (languageUnitRanges.some((range) =>
        languageUnitRange.start < range.end &&
        range.start < languageUnitRange.end
      )) {
        throw new Error("DVD menu program chain tables overlap ambiguously");
      }
      languageUnitRanges.push(languageUnitRange);
      const programChains: DvdProgramChain[] = [];
      const entryMenuIds = new Set<number>();
      const programChainRanges = readProgramChainRanges(
        content,
        pgcitOffset,
        pgcitByteCount,
        pgcCount,
        "menu program chain",
      );
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
        const range = programChainRanges[pgcIndex]!;
        programChains.push(parseMenuProgramChain(
          content,
          pgcitOffset,
          range.startByte,
          range.endByte,
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

  const validateDvdTopLevelTableRanges = (
    content: Buffer,
    domain: "manager" | "title-set",
    firstPlayProgramChain?: DvdProgramChain,
  ): void => {
    const tableFields = domain === "manager"
      ? [
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xc4 },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xc8 },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xcc },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xd0 },
          { lastByteOffset: 16, minimumByteCount: 20, pointerOffset: 0xd4 },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xd8 },
          { lastByteOffset: 0, minimumByteCount: 4, pointerOffset: 0xdc },
        ]
      : [
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xc8 },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xcc },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xd0 },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xd4 },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xd8 },
          { lastByteOffset: 0, minimumByteCount: 4, pointerOffset: 0xdc },
          { lastByteOffset: 4, minimumByteCount: 8, pointerOffset: 0xe0 },
          { lastByteOffset: 0, minimumByteCount: 4, pointerOffset: 0xe4 },
        ];
    const informationByteCount =
      (content.readUInt32BE(0x1c) + 1) * DVD_SECTOR_SIZE_BYTES;
    if (
      !Number.isSafeInteger(informationByteCount) ||
      informationByteCount > content.byteLength
    ) {
      throw new Error(`DVD ${domain} information size is malformed`);
    }
    const managementTableEnd = content.readUInt32BE(0x80) + 1;
    if (
      !Number.isSafeInteger(managementTableEnd) ||
      managementTableEnd <= 0 ||
      managementTableEnd > informationByteCount
    ) {
      throw new Error(`DVD ${domain} management table range is malformed`);
    }
    const ranges: Array<{ end: number; start: number }> = [{
      end: managementTableEnd,
      start: 0,
    }];
    for (const field of tableFields) {
      const tableSector = content.readUInt32BE(field.pointerOffset);
      if (tableSector === 0) {
        continue;
      }
      const start = tableSector * DVD_SECTOR_SIZE_BYTES;
      if (
        !Number.isSafeInteger(start) ||
        start < DVD_SECTOR_SIZE_BYTES ||
        start + field.lastByteOffset + 4 > informationByteCount
      ) {
        throw new Error(`DVD ${domain} table range is malformed`);
      }
      const byteCount = content.readUInt32BE(start + field.lastByteOffset) + 1;
      if (
        byteCount < field.minimumByteCount ||
        start + byteCount > informationByteCount
      ) {
        throw new Error(`DVD ${domain} table range is malformed`);
      }
      ranges.push({ end: start + byteCount, start });
    }
    const firstPlayOffset = domain === "manager"
      ? content.readUInt32BE(0x84)
      : 0;
    if ((firstPlayOffset === 0) !== (firstPlayProgramChain === undefined)) {
      throw new Error("DVD first-play program chain range is malformed");
    }
    if (firstPlayProgramChain !== undefined) {
      const end = firstPlayOffset + firstPlayProgramChain.byteCount;
      if (
        !Number.isSafeInteger(end) ||
        firstPlayOffset < 8 ||
        end > informationByteCount
      ) {
        throw new Error("DVD first-play program chain range is malformed");
      }
      ranges.push({ end, start: firstPlayOffset });
    }
    const orderedRanges = ranges.sort((left, right) =>
      left.start - right.start || left.end - right.end
    );
    for (let index = 1; index < orderedRanges.length; index += 1) {
      if (orderedRanges[index]!.start < orderedRanges[index - 1]!.end) {
        throw new Error(`DVD ${domain} tables overlap ambiguously`);
      }
    }
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
      consumeDvdNavigationObjects(1);
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
        consumeDvdNavigationObjects(1);
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
  ): Array<{ byteCount: number; sectorCount: number; startLba: number }> =>
    file.extents.reduce<Array<{
      byteCount: number;
      sectorCount: number;
      startLba: number;
    }>>((normalized, extent) => {
      const sectorCount = sectorCountForBytes(extent.byteCount);
      const previous = normalized.at(-1);
      if (
        previous !== undefined &&
        previous.byteCount % DVD_SECTOR_SIZE_BYTES === 0 &&
        previous.startLba + previous.sectorCount === extent.startLba
      ) {
        previous.byteCount += extent.byteCount;
        previous.sectorCount += sectorCount;
      } else {
        normalized.push({
          byteCount: extent.byteCount,
          sectorCount,
          startLba: extent.startLba,
        });
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
    streamDescription,
    suppliedIfoContent,
    view,
    vobPath,
  }: {
    expectedIdentifier: "DVDVIDEO-VMG" | "DVDVIDEO-VTS";
    ifoPath: string;
    malformedDescription: "title-set" | "video manager";
    menuProgramChainPointerOffset: number;
    streamDescription: "title-set menu" | "video manager";
    suppliedIfoContent?: Buffer;
    view: DvdFilesystemView;
    vobPath: string;
  }): Promise<{
    audioStreamCount: number;
    cellAddresses: ReadonlyMap<string, DvdCellAddress>;
    ifoContent: Buffer;
    menuVobSectorCount: number;
    programChainUnits: ReturnType<typeof parseMenuProgramChainUnits>;
    subpictureStreamCount: number;
  }> => {
    const { dvdFiles } = view;
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
    view: DvdFilesystemView,
    suppliedIfoContent?: Buffer,
  ) => {
    const { ifoContent, ...navigation } = await readMenuNavigation({
      expectedIdentifier: "DVDVIDEO-VMG",
      ifoPath: "VIDEO_TS/VIDEO_TS.IFO",
      malformedDescription: "video manager",
      menuProgramChainPointerOffset: 0xc8,
      streamDescription: "video manager",
      suppliedIfoContent,
      view,
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
            firstPlayOffset,
            ifoContent.byteLength,
            navigation.menuVobSectorCount,
          ),
    };
  };

  const readTitleSetMenuNavigation = async (
    view: DvdFilesystemView,
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
        streamDescription: "title-set menu",
        suppliedIfoContent,
        view,
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

  const indexVobExtents = (
    files: readonly DvdFileLayout[],
  ): readonly {
    logicalStartSector: number;
    physicalStartLba: number;
    sectorCount: number;
  }[] => {
    const indexedExtents = [];
    let logicalStartSector = 0;
    for (const file of files) {
      for (const extent of file.extents) {
        if (
          extent.byteCount <= 0 ||
          extent.byteCount % DVD_SECTOR_SIZE_BYTES !== 0
        ) {
          throw new Error("DVD VOB navigation layout is malformed");
        }
        const sectorCount = extent.byteCount / DVD_SECTOR_SIZE_BYTES;
        indexedExtents.push({
          logicalStartSector,
          physicalStartLba: extent.startLba,
          sectorCount,
        });
        logicalStartSector += sectorCount;
      }
    }
    return indexedExtents;
  };

  const readVobSector = async (
    indexedExtents: ReturnType<typeof indexVobExtents>,
    sector: number,
  ): Promise<Buffer> => {
    if (!Number.isSafeInteger(sector) || sector < 0) {
      throw new Error("DVD VOB navigation sector is invalid");
    }
    let low = 0;
    let high = indexedExtents.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const extent = indexedExtents[middle]!;
      if (sector < extent.logicalStartSector) {
        high = middle - 1;
      } else if (
        sector >= extent.logicalStartSector + extent.sectorCount
      ) {
        low = middle + 1;
      } else {
        return readRawSector(
          extent.physicalStartLba + sector - extent.logicalStartSector,
        );
      }
    }
    throw new Error("DVD VOB navigation sector is missing");
  };

  const validateVobNavigationPacks = async (
    files: readonly DvdFileLayout[],
    navigationSectors: ReadonlySet<number>,
    vobSectorCount: number,
  ): Promise<ReadonlyMap<number, DvdNavigationIdentity>> => {
    const indexedExtents = indexVobExtents(files);
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
      consumeDvdNavigationObjects(groupCount * buttonCount);
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
    const interleavedUnitReferences: Array<{
      description: "interleaved-unit" | "seamless angle";
      sectorCount: number;
      targetSector: number;
    }> = [];
    const identities = new Map<number, DvdNavigationIdentity>();
    for (const [index, sector] of orderedNavigationSectors.entries()) {
      consumeDvdNavigationObjects(1);
      const navPack = await readVobSector(indexedExtents, sector);
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
      const vobuEndExclusive = sector + vobuEndAddress + 1;
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
        )
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
        const targetSector = referencedNavigationSector(
          seamlessAngleAddress,
          sector,
          "encoded",
        );
        const hasSeamlessAngleAddress = targetSector !== undefined;
        if (
          (seamlessAngleAddress !== 0 &&
            seamlessAngleAddress !== 0x7fff_ffff &&
            !hasSeamlessAngleAddress) ||
          hasSeamlessAngleAddress !== (seamlessAngleSize !== 0) ||
          (targetSector !== undefined &&
            targetSector + seamlessAngleSize > vobSectorCount)
        ) {
          throw new Error("DVD VOB seamless angle reference is malformed");
        }
        if (targetSector !== undefined) {
          consumeDvdNavigationObjects(1);
          interleavedUnitReferences.push({
            description: "seamless angle",
            sectorCount: seamlessAngleSize,
            targetSector,
          });
        }
      }
      const interleavedUnitCategory = navPack.readUInt16BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 32,
      );
      const interleavedUnitKind = interleavedUnitCategory & 0xc000;
      const interleavedUnitBoundary = interleavedUnitCategory & 0x3000;
      const interleavedUnitEnd = navPack.readUInt32BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 34,
      );
      const nextInterleavedUnit = navPack.readUInt32BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 38,
      );
      const nextInterleavedUnitSize = navPack.readUInt16BE(
        DVD_NAV_DSI_PAYLOAD_OFFSET + 42,
      );
      const terminalInterleavedUnit = nextInterleavedUnit === 0xffff_ffff;
      const hasInterleavedUnit = interleavedUnitKind === 0x4000;
      const unsupportedNextInterleavedUnitDirection =
        nextInterleavedUnit !== 0 &&
        !terminalInterleavedUnit &&
        (nextInterleavedUnit & 0xc000_0000) !== 0;
      const nextInterleavedUnitTarget = terminalInterleavedUnit ||
          unsupportedNextInterleavedUnitDirection
        ? undefined
        : referencedNavigationSector(
            nextInterleavedUnit,
            sector,
            "forward",
          );
      const invalidInterleavedUnitCategory =
        (interleavedUnitCategory & 0x0fff) !== 0 ||
        interleavedUnitKind === 0xc000 ||
        (interleavedUnitBoundary !== 0 && interleavedUnitKind === 0);
      const invalidInterleavedUnitExtent = hasInterleavedUnit
        ? sector + interleavedUnitEnd >= vobSectorCount
        : interleavedUnitEnd !== 0 ||
          nextInterleavedUnit !== 0 ||
          nextInterleavedUnitSize !== 0;
      const invalidNextInterleavedUnit =
        (nextInterleavedUnit === 0 && nextInterleavedUnitSize !== 0) ||
        (terminalInterleavedUnit && nextInterleavedUnitSize !== 0xffff) ||
        (nextInterleavedUnit !== 0 &&
          !terminalInterleavedUnit &&
          (unsupportedNextInterleavedUnitDirection ||
            nextInterleavedUnitTarget === undefined ||
            nextInterleavedUnitSize === 0 ||
            nextInterleavedUnitSize === 0xffff ||
            nextInterleavedUnitTarget + nextInterleavedUnitSize >
              vobSectorCount));
      if (
        invalidInterleavedUnitCategory ||
        invalidInterleavedUnitExtent ||
        invalidNextInterleavedUnit
      ) {
        throw new Error("DVD VOB interleaved-unit reference is malformed");
      }
      if (nextInterleavedUnitTarget !== undefined) {
        consumeDvdNavigationObjects(1);
        interleavedUnitReferences.push({
          description: "interleaved-unit",
          sectorCount: nextInterleavedUnitSize,
          targetSector: nextInterleavedUnitTarget,
        });
      }
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
      if (vobuEndExclusive !== (nextSector ?? vobSectorCount)) {
        throw new Error("DVD VOB navigation data is malformed");
      }
      identities.set(sector, {
        buttonCommands: readButtonCommands(navPack),
        cellNumber,
        endSector: vobuEndExclusive - 1,
        interleaved: interleavedUnitKind === 0x4000,
        ...(hasInterleavedUnit
          ? { interleavedUnitSectorCount: interleavedUnitEnd + 1 }
          : {}),
        vobId,
      });
    }
    for (const reference of interleavedUnitReferences) {
      if (
        identities.get(reference.targetSector)?.interleavedUnitSectorCount !==
          reference.sectorCount
      ) {
        throw new Error(
          `DVD VOB ${reference.description} size is malformed`,
        );
      }
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
        sector > address.lastSector ||
        identity.endSector !== undefined &&
          identity.endSector > address.lastSector
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

  const managerProgramChainCountByView = new Map<
    string,
    Promise<number | undefined>
  >();
  const readManagerProgramChainCount = (
    view: DvdFilesystemView,
  ): Promise<number | undefined> => {
    const existing = managerProgramChainCountByView.get(view.key);
    if (existing !== undefined) {
      return existing;
    }
    const count = (async () => {
      const { programChainUnits: units } = await readManagerNavigation(view);
      return commonProgramChainCount(units);
    })();
    managerProgramChainCountByView.set(view.key, count);
    return count;
  };

  const dvdVmCommandTargetsManagerProgramChain = (
    command: DvdVmCommand,
  ): boolean =>
    command.fields.commandClass === 1 &&
    command.fields.direct &&
    (command.fields.operation === 6 || command.fields.operation === 8) &&
    command.fields.targetKind === 3;

  const dvdVmMenuTarget = (
    command: DvdVmCommand,
    currentTitleSetNumber: number,
  ): { domain: "manager" } | {
    domain: "title-set";
    titleSetNumber: number;
  } | undefined => {
    if (
      command.fields.commandClass !== 1 ||
      !command.fields.direct ||
      (command.fields.operation !== 6 && command.fields.operation !== 8)
    ) {
      return undefined;
    }
    const targetKind = command.fields.targetKind;
    if (targetKind === 1) {
      return { domain: "manager" };
    }
    if (targetKind !== 2) {
      return undefined;
    }
    return {
      domain: "title-set",
      titleSetNumber:
        command.fields.operation === 6 &&
          command.fields.targetTitleSetNumber !== 0
          ? command.fields.targetTitleSetNumber
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
      currentTitleChapterCount?: number;
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
      const operation = command.fields.operation;
      if (operation === 1) {
        const linkSubOperation = command.fields.linkSubOperation;
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
        ? command.fields.linkProgramChainNumber
        : operation === 5
        ? command.fields.linkChapterNumber
        : operation === 6
        ? command.fields.linkProgramNumber
        : operation === 7
        ? command.fields.linkCellNumber
        : 0;
      const maximum = operation === 4
        ? context.programChainCount
        : operation === 5
        ? context.currentTitleChapterCount ??
          Math.max(0, ...context.globalTitles
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
      const operation = command.fields.operation;
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
        const titleNumber = command.fields.globalTitleNumber;
        if (titleNumber <= 0 || titleNumber > context.globalTitles.length) {
          throw new Error("DVD VM jump command target is invalid");
        }
        return;
      }
      if (operation === 3 || operation === 5) {
        const titleNumber = command.fields.globalTitleNumber;
        const title = context.globalTitles.find((candidate) =>
          candidate.titleSetNumber === context.currentTitleSetNumber &&
          candidate.titleSetTitleNumber === titleNumber
        );
        const partNumber = operation === 5
          ? command.fields.partNumber
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
        const targetKind = command.fields.targetKind;
        if (
          operation === 6 &&
          ((targetKind === 0 &&
            context.domain !== "manager-menu" &&
            context.domain !== "title-set-menu") ||
            ((targetKind === 1 || targetKind === 3) &&
              context.domain === "title") ||
            (targetKind === 2 &&
              (command.fields.targetTitleSetNumber === 0
                ? context.domain !== "title-set-menu"
                : context.domain === "title")))
        ) {
          throw new Error("DVD VM jump command is illegal in this domain");
        }
        const resumeCell = operation === 8
          ? command.fields.resumeCellNumber
          : 0;
        if (resumeCell > context.cellCount) {
          throw new Error("DVD VM call command target is invalid");
        }
        if (targetKind === 0) {
          return;
        }
        if (targetKind === 1) {
          const menuId = command.fields.menuId;
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
          const titleSetNumber =
            operation === 6 && command.fields.targetTitleSetNumber !== 0
              ? command.fields.targetTitleSetNumber
              : context.currentTitleSetNumber;
          const titleNumber = operation === 6
            ? command.fields.targetTitleNumber
            : 1;
          const menuId = command.fields.menuId;
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
        const pgcNumber = command.fields.managerProgramChainNumber;
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

    const commandClass = command.fields.commandClass;
    if (commandClass === 0) {
      const operation = command.fields.operation;
      const line = command.fields.specialLineNumber;
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
      if (command.fields.direct) {
        validateJump();
      } else {
        validateLink();
      }
      return;
    }
    if (commandClass === 2) {
      const systemSetOperation = command.fields.setOperation;
      if (![1, 2, 3, 6].includes(systemSetOperation)) {
        throw new Error("DVD VM system-set command is unsupported");
      }
      if (systemSetOperation === 1) {
        if (!command.fields.direct) {
          throw new Error("DVD VM indirect stream selection is unsupported");
        }
        if (
          command.fields.audioStreamPresent &&
          !context.availableAudioStreamNumbers.has(
            command.fields.audioStreamNumber,
          )
        ) {
          throw new Error("DVD VM audio stream target is invalid");
        }
        const subpicture = command.fields.subpictureStreamValue;
        if (
          command.fields.subpictureStreamPresent &&
          ((subpicture & 0x20) !== 0 ||
            !context.availableSubpictureStreamNumbers.has(
              subpicture & 0x1f,
            ))
        ) {
          throw new Error("DVD VM subpicture stream target is invalid");
        }
        const angle = command.fields.angleNumber;
        if (
          command.fields.anglePresent &&
          (angle <= 0 || angle > context.angleCount)
        ) {
          throw new Error("DVD VM angle target is invalid");
        }
      } else if (systemSetOperation === 2) {
        if (!command.fields.direct) {
          throw new Error("DVD VM indirect navigation timer is unsupported");
        }
        const timer = command.fields.navigationTimer;
        const programChain =
          command.fields.navigationTimerProgramChainNumber;
        if (
          (timer === 0 && programChain !== 0) ||
          (timer !== 0 &&
            (programChain <= 0 || programChain > context.programChainCount))
        ) {
          throw new Error("DVD VM navigation timer target is invalid");
        }
      }
      if (command.fields.operation !== 0) {
        validateLink();
      }
      return;
    }
    if (commandClass >= 3 && commandClass <= 6) {
      if (command.fields.setOperation > 11) {
        throw new Error("DVD VM set command is unsupported");
      }
      if (commandClass === 3 && command.fields.operation !== 0) {
        validateLink();
      } else if (
        commandClass >= 4 &&
        !SUPPORTED_DVD_VM_LINK_SUB_OPERATIONS.has(
          command.fields.linkSubOperation,
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
      currentTitleChapterCount?: number;
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
      currentTitleChapterCount: context.currentTitleChapterCount,
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
      const firstVobuIdentity = context.navigationIdentities.get(
        cellVobuStarts[0] ?? -1,
      );
      const hasCompleteNavigationIdentity =
        firstVobuIdentity?.endSector !== undefined;
      if (
        cellAddress === undefined ||
        cellAddress.firstSector !== cell.firstSector ||
        cellAddress.lastSector !== cell.lastSector ||
        cellVobuStarts[0] !== cell.firstSector ||
        cellVobuStarts.at(-1) !== cell.lastVobuStartSector ||
        (hasCompleteNavigationIdentity &&
          (cellVobuStarts.some((sector) =>
            context.navigationIdentities.get(sector)?.interleaved !==
              cell.interleaved
          ) ||
            (cell.interleaved
              ? firstVobuIdentity.interleavedUnitSectorCount === undefined ||
                cell.firstSector +
                    firstVobuIdentity.interleavedUnitSectorCount - 1 !==
                  cell.firstIlvuEndSector
              : cell.firstIlvuEndSector !== cell.firstSector)))
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

  const titleAssociationsByViewAndSet = new Map<
    string,
    Promise<readonly {
      angleCount: number;
      sectors: readonly { firstSector: number; lastSector: number }[];
      titleNumber: number;
    }[]>
  >();
  const readTitleAssociations = (
    view: DvdFilesystemView,
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
    const key = [
      view.key,
      titleSetNumber,
      titleVobSectorCount,
      navigationTargets.managerProgramChainCount ?? "unknown",
      managerMenuKey,
      titleSetMenuKey,
    ].join(":");
    const existing = titleAssociationsByViewAndSet.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const associations = (async () => {
      const { dvdFiles } = view;
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
        content.toString("latin1", 0, 12) !== "DVDVIDEO-VTS"
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
          consumeDvdNavigationObjects(1);
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
      if (titleParts.some((parts) =>
        parts.some((part) => part.pgcNumber > pgcCount)
      )) {
        throw new Error("DVD part-of-title table is malformed");
      }
      const programChains = new Map<number, DvdProgramChain>();
      const programChainRanges = readProgramChainRanges(
        content,
        pgcitOffset,
        pgcitByteCount,
        pgcCount,
        "program chain",
      );
      for (let pgcNumber = 1; pgcNumber <= pgcCount; pgcNumber += 1) {
        const range = programChainRanges[pgcNumber - 1]!;
        programChains.set(
          pgcNumber,
          parseProgramChain(
            content,
            pgcitOffset,
            range.startByte,
            range.endByte,
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
        : (() => {
            const identities = new Map<number, DvdNavigationIdentity>();
            const orderedAddresses = [...cellAddresses.values()].sort(
              (left, right) => left.firstSector - right.firstSector ||
                left.lastSector - right.lastSector,
            );
            const orderedSectors = [...navigationSectors].sort(
              (left, right) => left - right,
            );
            let addressIndex = 0;
            for (const sector of orderedSectors) {
              while (
                orderedAddresses[addressIndex] !== undefined &&
                orderedAddresses[addressIndex]!.lastSector < sector
              ) {
                addressIndex += 1;
              }
              const address = orderedAddresses[addressIndex];
              if (
                address === undefined ||
                sector < address.firstSector
              ) {
                throw new Error("DVD title VOBU has no cell address");
              }
              consumeDvdNavigationObjects(1);
              identities.set(sector, {
                buttonCommands: [],
                cellNumber: address.cellNumber,
                interleaved: false,
                vobId: address.vobId,
              });
            }
            return identities;
          })();
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
          managerNavigation ??= await readManagerNavigation(view);
          managerMenuEntryIds = commonMenuEntryIds(
            managerNavigation.programChainUnits,
          );
        } else if (
          target?.domain === "title-set" &&
          !titleSetMenuEntryIds.has(target.titleSetNumber)
        ) {
          const targetNavigation = await readTitleSetMenuNavigation(
            view,
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
            ? await readManagerProgramChainCount(view)
            : commonProgramChainCount(managerNavigation.programChainUnits)
          : undefined);
      const executableTitlesByProgramChain = new Map<
        number,
        Map<number, GlobalDvdTitle>
      >();
      const pendingExecutableTitles: Array<{
        pgcNumber: number;
        title: GlobalDvdTitle;
      }> = [];
      const addExecutableTitle = (
        pgcNumber: number,
        title: GlobalDvdTitle,
      ): void => {
        if (pgcNumber <= 0 || pgcNumber > pgcCount) {
          return;
        }
        const titles = executableTitlesByProgramChain.get(pgcNumber) ??
          new Map<number, GlobalDvdTitle>();
        if (titles.has(title.titleNumber)) {
          return;
        }
        titles.set(title.titleNumber, title);
        executableTitlesByProgramChain.set(pgcNumber, titles);
        pendingExecutableTitles.push({ pgcNumber, title });
      };
      for (const title of globalTitles) {
        for (const part of titleParts[title.titleSetTitleNumber - 1]!) {
          addExecutableTitle(part.pgcNumber, title);
        }
      }
      const programChainTargetsForCommands = (
        commands: readonly DvdVmCommand[],
      ): ReadonlySet<number> => {
        const targets = new Set<number>();
        for (const command of commands) {
          const { fields } = command;
          const hasLinkOperation =
            fields.commandClass === 1 && !fields.direct ||
            fields.commandClass === 2 && fields.operation !== 0 ||
            fields.commandClass === 3 && fields.operation !== 0;
          if (hasLinkOperation && fields.operation === 4) {
            targets.add(fields.linkProgramChainNumber);
          }
          if (
            fields.commandClass === 2 &&
            fields.setOperation === 2 &&
            fields.navigationTimerProgramChainNumber > 0
          ) {
            targets.add(fields.navigationTimerProgramChainNumber);
          }
        }
        return targets;
      };
      const buttonTargetsByCell = new Map<string, Set<number>>();
      for (const identity of navigationIdentities.values()) {
        const key = `${identity.vobId}:${identity.cellNumber}`;
        const cellTargets = buttonTargetsByCell.get(key) ?? new Set<number>();
        for (const target of programChainTargetsForCommands(
          identity.buttonCommands,
        )) {
          cellTargets.add(target);
        }
        buttonTargetsByCell.set(key, cellTargets);
      }
      const targetProgramChainsBySource = new Map<
        number,
        ReadonlySet<number>
      >();
      for (const [pgcNumber, chain] of programChains) {
        const targetProgramChains = new Set(
          chain.programChainReferences.filter((reference) => reference > 0),
        );
        for (const target of programChainTargetsForCommands(
          chain.commandBlocks.flatMap((block) => block.commands),
        )) {
          targetProgramChains.add(target);
        }
        for (const cell of chain.cells) {
          for (const target of buttonTargetsByCell.get(
            `${cell.vobId}:${cell.cellNumber}`,
          ) ?? []) {
            targetProgramChains.add(target);
          }
        }
        targetProgramChainsBySource.set(pgcNumber, targetProgramChains);
      }
      for (
        let pendingIndex = 0;
        pendingIndex < pendingExecutableTitles.length;
        pendingIndex += 1
      ) {
        const { pgcNumber, title } = pendingExecutableTitles[pendingIndex]!;
        for (const target of targetProgramChainsBySource.get(pgcNumber) ?? []) {
          addExecutableTitle(target, title);
        }
      }
      for (const [pgcNumber, chain] of programChains) {
        const executableTitles = [
          ...(executableTitlesByProgramChain.get(pgcNumber)?.values() ??
            globalTitles),
        ];
        validateProgramChainNavigation(chain, {
          angleCount: Math.min(
            ...executableTitles.map((title) => title.angleCount),
          ),
          audioStreamCount,
          cellAddresses,
          currentTitleChapterCount: Math.min(
            ...executableTitles.map((title) => title.chapterCount),
          ),
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
          consumeDvdNavigationObjects(lastCell - firstCell + 1);
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
    titleAssociationsByViewAndSet.set(key, associations);
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
    const filesystemView = extent.fileLocation.source === "iso"
      ? aggregateIsoFilesystemView
      : udfFilesystemView;
    const { dvdFiles } = filesystemView;
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
        filesystemView,
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
    let aggregatePathByteCount = 0;
    let offset = 0;
    while (offset < content.byteLength) {
      const identifierLength = content[offset]!;
      const entryByteCount = 8 + identifierLength + identifierLength % 2;
      if (
        identifierLength <= 0 ||
        entryByteCount <= 8 ||
        offset + entryByteCount > content.byteLength ||
        identifierLength % 2 === 1 &&
          content[offset + 8 + identifierLength] !== 0 ||
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
      let depth: number;
      let path: string;
      let pathByteCount: number;
      if (directoryNumber === 1) {
        if (
          identifierLength !== 1 ||
          identifier[0] !== 0 ||
          parentDirectoryNumber !== 1
        ) {
          throw new Error("DVD ISO path table root is malformed");
        }
        depth = 0;
        path = "";
        pathByteCount = 0;
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
          name = identifier.toString("latin1");
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
        depth = parent.depth + 1;
        pathByteCount =
          parent.pathByteCount +
          (parent.path.length === 0 ? 0 : 1) +
          Buffer.byteLength(name);
        aggregatePathByteCount += pathByteCount;
        if (
          depth > MAX_DIRECTORY_DEPTH ||
          aggregatePathByteCount > MAX_AGGREGATE_PATH_BYTES
        ) {
          throw new Error("DVD ISO path table hierarchy exceeds its safety bound");
        }
        path = `${parent.path}/${name}`.replace(/^\/+/, "");
      }
      if (paths.has(path)) {
        throw new Error("DVD ISO path table is ambiguous");
      }
      paths.add(path);
      layouts.push({
        depth,
        extendedAttributeSectorCount: content[offset + 1]!,
        extentLba: readUInt32(offset + 2),
        path,
        pathByteCount,
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
        descriptor.toString("latin1", 1, 6) === "CD001";
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
      primaryVolumeDescriptor.readUInt16LE(120) !== 1 ||
      primaryVolumeDescriptor.readUInt16BE(122) !== 1 ||
      primaryVolumeDescriptor.readUInt16LE(124) !== 1 ||
      primaryVolumeDescriptor.readUInt16BE(126) !== 1 ||
      primaryVolumeDescriptor.readUInt16LE(128) !== DVD_SECTOR_SIZE_BYTES ||
      primaryVolumeDescriptor.readUInt16BE(130) !== DVD_SECTOR_SIZE_BYTES
    ) {
      throw new Error("DVD ISO volume geometry is invalid");
    }
    recordReferencedExtent(0, volumeSpaceSize);
    for (
      const [viewIndex, { descriptor, identifierEncoding }] of
        filesystemDescriptors.entries()
    ) {
      const filesystemView: DvdFilesystemView = {
        dvdFiles: new Map(),
        dvdPaths: new Set(),
        key: `iso:${viewIndex}`,
        normalizedNodePaths: new Set(),
        source: "iso",
      };
      if (
        descriptor.readUInt32LE(80) !== volumeSpaceSize ||
        descriptor.readUInt32BE(84) !== volumeSpaceSize ||
        descriptor.readUInt16LE(120) !== 1 ||
        descriptor.readUInt16BE(122) !== 1 ||
        descriptor.readUInt16LE(124) !== 1 ||
        descriptor.readUInt16BE(126) !== 1 ||
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
      const rootRecord = descriptor.subarray(156, 190);
      if (
        rootRecord[0] !== 34 ||
        rootRecord[25] !== 0x02 ||
        rootRecord[26] !== 0 ||
        rootRecord[27] !== 0 ||
        rootRecord.readUInt16LE(28) !== 1 ||
        rootRecord.readUInt16BE(30) !== 1 ||
        rootRecord[32] !== 1 ||
        rootRecord[33] !== 0
      ) {
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
        filesystemView,
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
      isoFilesystemViews.push(filesystemView);
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
    const recognitionDescriptors: Array<{
      content: Buffer;
      lba: number;
      identifier: string;
    }> = [];
    for (let lba = 16; lba < 16 + 32; lba += 1) {
      const descriptor = await readRawSector(lba);
      recognitionDescriptors.push({
        content: descriptor,
        lba,
        identifier: descriptor.toString("latin1", 1, 6),
      });
    }
    const nsrIndexes = recognitionDescriptors.flatMap(
      ({ identifier }, index) =>
        identifier === "NSR02" || identifier === "NSR03" ? [index] : [],
    );
    const nsrIndex = nsrIndexes[0] ?? -1;
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
    const beginningIndexes = recognitionDescriptors.flatMap(
      ({ identifier }, index) => identifier === "BEA01" ? [index] : [],
    );
    const terminatorIndexes = recognitionDescriptors.flatMap(
      ({ identifier }, index) => identifier === "TEA01" ? [index] : [],
    );
    const beginningIndex = beginningIndexes[0] ?? -1;
    const terminatorIndex = terminatorIndexes[0] ?? -1;
    if (
      beginningIndexes.length !== 1 ||
      nsrIndexes.length !== 1 ||
      terminatorIndexes.length !== 1 ||
      beginningIndex >= nsrIndex ||
      nsrIndex >= terminatorIndex
    ) {
      if (recognitionDescriptors.some(({ lba }) => badSectors.has(lba))) {
        throw new ClassifiedDamageError("filesystem_metadata");
      }
      throw new Error("DVD UDF recognition sequence is incomplete");
    }
    for (let index = beginningIndex + 1; index < terminatorIndex; index += 1) {
      if (index === nsrIndex) {
        continue;
      }
      if (recognitionDescriptors[index]!.identifier === "BOOT2") {
        throw new Error("DVD UDF boot descriptor is unsupported");
      }
      throw new Error("DVD UDF recognition sequence is unsupported");
    }
    for (const index of [beginningIndex, nsrIndex, terminatorIndex]) {
      const descriptor = recognitionDescriptors[index]!.content;
      if (
        descriptor[0] !== 0 ||
        descriptor[6] !== 1 ||
        descriptor.subarray(7).some((byte) => byte !== 0)
      ) {
        throw new Error("DVD UDF recognition descriptor is malformed");
      }
    }
    classifyBeforeMetadataRead(
      recognitionDescriptors[beginningIndex]!.lba,
      recognitionDescriptors[terminatorIndex]!.lba -
        recognitionDescriptors[beginningIndex]!.lba + 1,
    );
    const nsrIdentifier = recognitionDescriptors[nsrIndex]!.identifier;
    const supportedDomainRevisions = nsrIdentifier === "NSR02"
      ? new Set([0x0102, 0x0150])
      : new Set([0x0200, 0x0201, 0x0250, 0x0260]);
    const validateSupportedDomainIdentifier = (
      descriptor: Buffer,
      offset: number,
      description: "file set descriptor" | "logical volume",
    ): void => {
      if (
        udfEntityIdentifier(descriptor, offset) !==
          "*OSTA UDF Compliant" ||
        !supportedDomainRevisions.has(descriptor.readUInt16LE(offset + 24)) ||
        (descriptor[offset + 26]! & ~0x03) !== 0 ||
        descriptor.subarray(offset + 27, offset + 32).some((byte) =>
          byte !== 0
        )
      ) {
        throw new Error(`DVD UDF ${description} is unsupported`);
      }
    };
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
    if (
      mainSequenceStart < reserveSequenceStart + reserveSequenceSectors &&
      reserveSequenceStart < mainSequenceStart + mainSequenceSectors
    ) {
      throw new Error("DVD UDF descriptor sequences overlap");
    }
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
      unallocatedExtents: readonly { endLba: number; startLba: number }[];
    }> => {
      const sequencePartitions = new Map<number, UdfPartition>();
      const descriptorBodies: string[] = [];
      const unallocatedExtents: Array<{
        endLba: number;
        startLba: number;
      }> = [];
      let sequenceLogicalVolume: UdfLogicalVolume | undefined;
      let sawPrimaryVolumeDescriptor = false;
      let sawTerminator = false;
      let sawUnallocatedSpaceDescriptor = false;
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
          if (descriptor.readUInt32LE(484) !== 0) {
            throw new Error(
              "DVD UDF predecessor volume descriptor sequence is unsupported",
            );
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
          if (
            udfEntityIdentifier(descriptor, 24) !== `+${nsrIdentifier}` ||
            descriptor.subarray(48, 56).some((byte) => byte !== 0)
          ) {
            throw new Error("DVD UDF partition contents are unsupported");
          }
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
          if (descriptor.subarray(56, 184).some((byte) => byte !== 0)) {
            throw new Error(
              "DVD UDF partition metadata extent is unsupported",
            );
          }
        } else if (identifier === 6) {
          validateSupportedDomainIdentifier(descriptor, 216, "logical volume");
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
              descriptor.readUInt16LE(mapOffset + 2) !== 1 ||
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
          if (sawUnallocatedSpaceDescriptor) {
            throw new Error(
              "DVD UDF unallocated-space descriptor is duplicated",
            );
          }
          sawUnallocatedSpaceDescriptor = true;
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
            unallocatedExtents.push(extent);
          }
        }
      }
      if (
        !sawTerminator ||
        !sawPrimaryVolumeDescriptor ||
        !sawUnallocatedSpaceDescriptor ||
        sequenceLogicalVolume === undefined ||
        sequencePartitions.size === 0
      ) {
        throw new Error(
          `DVD UDF ${sequenceName} volume descriptor sequence is incomplete`,
        );
      }
      unallocatedExtents.sort((left, right) =>
        left.startLba - right.startLba || left.endLba - right.endLba
      );
      for (let index = 1; index < unallocatedExtents.length; index += 1) {
        if (
          unallocatedExtents[index]!.startLba <
            unallocatedExtents[index - 1]!.endLba
        ) {
          throw new Error("DVD UDF unallocated-space extents overlap");
        }
      }
      return {
        descriptorBodies,
        logicalVolume: sequenceLogicalVolume,
        partitions: sequencePartitions,
        unallocatedExtents,
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
    const unallocatedExtents = mainSequence.unallocatedExtents;
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
        if (nextLength !== 0) {
          break;
        }
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
    validateSupportedDomainIdentifier(
      fileSetDescriptor,
      416,
      "file set descriptor",
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
      const normalizedPath = path.toUpperCase();
      if (udfFilesystemView.normalizedNodePaths.has(normalizedPath)) {
        throw new Error("DVD UDF file layout is ambiguous");
      }
      udfFilesystemView.normalizedNodePaths.add(normalizedPath);
      consumeFilesystemPath(normalizedPath);
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
      if (
        fileEntry.readUInt32LE(16) !== 0 ||
        fileEntry.readUInt16LE(20) !== 4 ||
        fileEntry.readUInt16LE(22) !== 0 ||
        fileEntry.readUInt16LE(24) !== 1 ||
        fileEntry[26] !== 0 ||
        fileEntry.subarray(28, 34).some((byte) => byte !== 0) ||
        (fileEntry.readUInt16LE(34) & 0xe000) !== 0
      ) {
        throw new Error("DVD UDF ICB hierarchy is unsupported");
      }
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
      const logicalBlocksRecorded = fileEntry.readBigUInt64LE(
        identifier === 261 ? 64 : 72,
      );
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
      const dataExtents: Array<{
        byteCount: number;
        fileByteOffset: number;
        logicalBlockNumber: number;
        startLba: number;
      }> = [];
      let fileByteOffset = 0;
      let recordedLogicalBlockCount = 0;
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
          consumeUdfAllocationDescriptor();
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
          recordedLogicalBlockCount += sectorCountForBytes(extentLength);
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
      if (logicalBlocksRecorded !== BigInt(recordedLogicalBlockCount)) {
        throw new Error("DVD UDF file allocation accounting is malformed");
      }
      if (allocationType !== 3 && fileByteOffset < informationLength) {
        throw new Error("DVD UDF file layout is incomplete");
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

      consumeDirectoryBytes(fileEntry.byteLength);
      consumeDirectoryBytes(informationLength);
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
      let containingExtentIndex = 0;
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
        const remainingDirectoryBlock = directory.subarray(offset, blockEnd);
        while (
          dataExtents[containingExtentIndex] !== undefined &&
          offset >=
            dataExtents[containingExtentIndex]!.fileByteOffset +
              dataExtents[containingExtentIndex]!.byteCount
        ) {
          containingExtentIndex += 1;
        }
        const candidateContainingExtent = dataExtents[containingExtentIndex];
        const containingExtent = allocationType === 3 ||
            candidateContainingExtent === undefined ||
            offset < candidateContainingExtent.fileByteOffset
          ? undefined
          : candidateContainingExtent;
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
        const fileCharacteristics = remainingDirectoryBlock[18]!;
        const fileIdentifierLength = remainingDirectoryBlock[19]!;
        const implementationUseLength = remainingDirectoryBlock.readUInt16LE(
          36,
        );
        const recordLength = Math.ceil(
          (38 + implementationUseLength + fileIdentifierLength) / 4,
        ) * 4;
        const entryEnd = offset + recordLength;
        const identifierEnd = 38 + implementationUseLength +
          fileIdentifierLength;
        if (
          remainingDirectoryBlock.readUInt16LE(16) !== 1 ||
          (fileCharacteristics & ~0x0e) !== 0 ||
          (fileCharacteristics & 0x04) !== 0 ||
          remainingDirectoryBlock.subarray(30, 36).some((byte) => byte !== 0) ||
          implementationUseLength !== 0 ||
          recordLength <= 0 ||
          entryEnd > blockEnd ||
          16 + remainingDirectoryBlock.readUInt16LE(10) > recordLength ||
          directory.subarray(offset + identifierEnd, entryEnd).some((byte) =>
            byte !== 0
          )
        ) {
          throw new Error("DVD UDF directory entry length is invalid");
        }
        const descriptor = directory.subarray(offset, entryEnd);
        validateUdfTag(descriptor, [257], expectedTagLocation);
        udfDirectoryEntryCount += 1;
        if (udfDirectoryEntryCount > MAX_DIRECTORY_ENTRIES) {
          throw new Error("DVD UDF directory entry count exceeds its bound");
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
    const allocatedUdfSpace = [
      ...[...partitions.values()].map((partition) => ({
        endLba: partition.startLba + partition.sectorCount,
        startLba: partition.startLba,
      })),
      ...allocatedExtents.map((extent) => ({
        endLba: extent.startLba + extent.sectorCount,
        startLba: extent.startLba,
      })),
    ].sort((left, right) =>
      left.startLba - right.startLba || left.endLba - right.endLba
    );
    let allocatedIndex = 0;
    for (const unallocatedExtent of unallocatedExtents) {
      while (
        allocatedUdfSpace[allocatedIndex] !== undefined &&
        allocatedUdfSpace[allocatedIndex]!.endLba <=
          unallocatedExtent.startLba
      ) {
        allocatedIndex += 1;
      }
      if (
        allocatedUdfSpace[allocatedIndex] !== undefined &&
        allocatedUdfSpace[allocatedIndex]!.startLba <
          unallocatedExtent.endLba
      ) {
        throw new Error("DVD UDF unallocated space overlaps allocated layout");
      }
    }
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
    ).map((extent) => ({
      endLba: extent.startLba + extent.sectorCount,
      startLba: extent.startLba,
    })).sort((left, right) =>
      left.startLba - right.startLba || left.endLba - right.endLba
    );
    const structuralExtents = allocatedExtents.filter((extent) =>
      extent.fileLocation === undefined
    ).map((extent) => ({
      endLba: extent.startLba + extent.sectorCount,
      startLba: extent.startLba,
    })).sort((left, right) =>
      left.startLba - right.startLba || left.endLba - right.endLba
    );
    validateNoPartialExtentOverlaps(
      structuralExtents,
      "DVD filesystem structures overlap ambiguously",
    );
    let structuralIndex = 0;
    for (const fileExtent of fileExtents) {
      while (
        structuralExtents[structuralIndex] !== undefined &&
        structuralExtents[structuralIndex]!.endLba <= fileExtent.startLba
      ) {
        structuralIndex += 1;
      }
      const structuralExtent = structuralExtents[structuralIndex];
      if (
        structuralExtent !== undefined &&
        structuralExtent.startLba < fileExtent.endLba
      ) {
        throw new Error("DVD file and filesystem structures overlap ambiguously");
      }
    }
  };

  const canonicalFilesystemLayout = (
    dvdFiles: ReadonlyMap<string, DvdFileLayout>,
  ) => JSON.stringify(
    [...dvdFiles.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        byteCount: file.byteCount,
        extents: normalizeDvdFileExtents(file),
        path: file.path,
      })),
  );

  const validateCompleteDvdVideoView = async (
    view: DvdFilesystemView,
  ): Promise<string> => {
    const { dvdFiles, dvdPaths, source } = view;
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
      view,
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
    await validateDvdManagerReferencedTables(
      managerIfoContent,
      dvdFiles,
      titleSetNumbers,
      globalTitles.length,
    );
    validateDvdTopLevelTableRanges(
      managerIfoContent,
      "manager",
      firstPlayProgramChain,
    );
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
        view,
        titleSetNumber,
        titleSetIfoContent,
      );
      validateDvdTopLevelTableRanges(titleSetIfoContent, "title-set");
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
        view,
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
      filesystemLayout: canonicalFilesystemLayout(dvdFiles),
      filesystemNodes: [...view.normalizedNodePaths].sort(),
      globalTitles,
      menuNavigation,
    });
  };

  const validateCompleteIsoViews = async (): Promise<string> => {
    const parsedViews: string[] = [];
    for (const filesystemView of isoFilesystemViews) {
      parsedViews.push(await validateCompleteDvdVideoView(filesystemView));
    }
    if (
      parsedViews.length === 0 ||
      new Set(parsedViews).size !== 1
    ) {
      throw new Error("DVD ISO filesystem views disagree");
    }
    return parsedViews[0]!;
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
        isoFilesystemViews.some((filesystemView) =>
          REQUIRED_DVD_VIDEO_PATHS.some((path) =>
            !filesystemView.dvdPaths.has(path)
          )
        )) ||
      (udfBounds.hasUdf &&
        REQUIRED_DVD_VIDEO_PATHS.some((path) => !udfDvdPaths.has(path)))
    ) {
      throw new Error("DVD-Video control structures are missing");
    }
    await policy.validateDvdVideoViews({
      hasIso: isoBounds.hasIso,
      hasUdf: udfBounds.hasUdf,
      validateFileStructureOverlaps: validateFilesDoNotOverlapStructures,
      validateView: (source) =>
        source === "iso"
          ? validateCompleteIsoViews()
          : validateCompleteDvdVideoView(udfFilesystemView),
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
