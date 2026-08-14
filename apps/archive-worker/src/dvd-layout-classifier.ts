import { lstat, open } from "node:fs/promises";

import type { UnreadableSectorRange } from "@rip-dvd/data-access";

import {
  DVD_SECTOR_SIZE_BYTES,
} from "./dvd-recovery-contracts.js";
import type { DvdSalvageRejectionReason } from "./dvd-salvage-validator.js";

const MAX_DESCRIPTOR_SECTORS = 256;
const MAX_DIRECTORY_BYTES = 16 * 1_024 * 1_024;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_FILE_ENTRY_BYTES = 1_048_576;
const UDF_EXTENT_LENGTH_MASK = 0x3fff_ffff;
const UDF_EXTENT_TYPE_MASK = 0xc000_0000;

interface SectorExtent {
  startLba: number;
  sectorCount: number;
  reason: DvdSalvageRejectionReason;
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

export async function classifyDvdImageDamage({
  imagePath,
  expectedByteCount,
  unreadableSectorRanges,
}: {
  imagePath: string;
  expectedByteCount: number;
  unreadableSectorRanges: readonly UnreadableSectorRange[];
}): Promise<{ outcome: "accepted" } | {
  outcome: "rejected";
  reason: DvdSalvageRejectionReason;
}> {
  if (
    !Number.isSafeInteger(expectedByteCount) ||
    expectedByteCount <= 0 ||
    expectedByteCount % DVD_SECTOR_SIZE_BYTES !== 0
  ) {
    throw new Error("DVD salvage image size is invalid");
  }
  const metadata = await lstat(imagePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expectedByteCount
  ) {
    throw new Error("DVD salvage image is not the expected regular file");
  }
  const totalSectorCount = expectedByteCount / DVD_SECTOR_SIZE_BYTES;
  const badSectors = badSectorSet(unreadableSectorRanges);
  if (badSectors.size === 0) {
    throw new Error("DVD salvage damage map is empty");
  }
  for (const lba of badSectors) {
    if (lba < 0 || lba >= totalSectorCount) {
      throw new Error("DVD salvage damage map exceeds the image");
    }
  }

  const handle = await open(imagePath, "r");
  const allocatedExtents: SectorExtent[] = [];
  const isoDvdPaths = new Set<string>();
  const udfDvdPaths = new Set<string>();
  const addExtent = (
    startLba: number,
    sectorCount: number,
    reason: DvdSalvageRejectionReason,
  ) => {
    requireSafeExtent(startLba, sectorCount, totalSectorCount);
    allocatedExtents.push({ startLba, sectorCount, reason });
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
  ): Promise<void> => {
    const key = `${startLba}:${byteCount}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    const directory = await readExtent(
      startLba,
      byteCount,
      "directory_data",
      MAX_DIRECTORY_BYTES,
    );
    let offset = 0;
    let entryCount = 0;
    while (offset < directory.byteLength) {
      const recordLength = directory[offset]!;
      if (recordLength === 0) {
        offset = Math.ceil((offset + 1) / DVD_SECTOR_SIZE_BYTES) *
          DVD_SECTOR_SIZE_BYTES;
        continue;
      }
      entryCount += 1;
      if (entryCount > MAX_DIRECTORY_ENTRIES || recordLength < 34 ||
        offset + recordLength > directory.byteLength) {
        throw new Error("DVD ISO directory is malformed");
      }
      const record = directory.subarray(offset, offset + recordLength);
      const extentLba = record.readUInt32LE(2);
      const extentLbaBe = record.readUInt32BE(6);
      const extentBytes = record.readUInt32LE(10);
      const extentBytesBe = record.readUInt32BE(14);
      const flags = record[25]!;
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
      if (!isSpecial && extentBytes > 0) {
        const name = identifier.toString("ascii").replace(/;\d+$/, "");
        const path = `${parentPath}/${name}`.replace(/^\/+/, "");
        if ((flags & 0x02) !== 0) {
          await parseIsoDirectory(
            extentLba,
            extentBytes,
            path,
            visited,
          );
        } else {
          isoDvdPaths.add(path.toUpperCase());
          addExtent(
            extentLba,
            sectorCountForBytes(extentBytes),
            classifyDvdPath(path),
          );
        }
      }
      offset += recordLength;
    }
  };

  const parseIso = async (): Promise<number> => {
    let primaryVolumeDescriptor: Buffer | undefined;
    const filesystemDescriptors: Buffer[] = [];
    let volumeDescriptorCount = 0;
    for (let lba = 16; lba < 16 + MAX_DESCRIPTOR_SECTORS; lba += 1) {
      const descriptor = await readSector(lba);
      if (descriptor.toString("ascii", 1, 6) !== "CD001" ||
        descriptor[6] !== 1) {
        if (volumeDescriptorCount === 0) {
          continue;
        }
        throw new Error("DVD ISO volume descriptor sequence is malformed");
      }
      volumeDescriptorCount += 1;
      const type = descriptor[0]!;
      if (type === 0 || type === 3) {
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
        break;
      }
    }
    if (primaryVolumeDescriptor === undefined) {
      throw new Error("DVD ISO primary volume descriptor is missing");
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
      for (const lba of [
        descriptor.readUInt32LE(140),
        descriptor.readUInt32LE(144),
        descriptor.readUInt32BE(148),
        descriptor.readUInt32BE(152),
      ]) {
        if (lba > 0) {
          classifyBeforeMetadataRead(lba, pathTableSectorCount);
        }
      }
      const rootRecord = descriptor.subarray(156);
      if (rootRecord[0]! < 34) {
        throw new Error("DVD ISO root directory record is invalid");
      }
      const rootLba = rootRecord.readUInt32LE(2);
      const rootBytes = rootRecord.readUInt32LE(10);
      if (
        rootLba !== rootRecord.readUInt32BE(6) ||
        rootBytes !== rootRecord.readUInt32BE(14) ||
        rootBytes <= 0
      ) {
        throw new Error("DVD ISO root directory extent is invalid");
      }
      await parseIsoDirectory(rootLba, rootBytes, "", new Set());
    }
    return volumeSpaceSize;
  };

  const partitionAbsoluteLba = (
    descriptor: UdfLongAllocationDescriptor,
    partitionsByReference: readonly UdfPartition[],
  ): number => {
    const partition = partitionsByReference[descriptor.partitionReferenceNumber];
    if (partition === undefined ||
      descriptor.logicalBlockNumber >= partition.sectorCount) {
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
    for (const anchorLba of [totalSectorCount - 256, totalSectorCount - 1]) {
      if (anchorLba >= 0 && anchorLba !== 256) {
        classifyBeforeMetadataRead(anchorLba, 1);
      }
    }
    const mainSequenceLength = anchor.readUInt32LE(16);
    const mainSequenceStart = anchor.readUInt32LE(20);
    const reserveSequenceLength = anchor.readUInt32LE(24);
    const reserveSequenceStart = anchor.readUInt32LE(28);
    const mainSequenceSectors = sectorCountForBytes(mainSequenceLength);
    const reserveSequenceSectors = sectorCountForBytes(reserveSequenceLength);
    classifyBeforeMetadataRead(mainSequenceStart, mainSequenceSectors);
    classifyBeforeMetadataRead(reserveSequenceStart, reserveSequenceSectors);

    const partitions = new Map<number, UdfPartition>();
    let logicalVolume: UdfLogicalVolume | undefined;
    let sawTerminator = false;
    for (let index = 0; index < mainSequenceSectors; index += 1) {
      const descriptor = await readSector(mainSequenceStart + index);
      const identifier = validateUdfTag(descriptor, [1, 3, 4, 5, 6, 7, 8, 9]);
      if (identifier === 5) {
        const partition: UdfPartition = {
          number: descriptor.readUInt16LE(22),
          startLba: descriptor.readUInt32LE(188),
          sectorCount: descriptor.readUInt32LE(192),
        };
        requireSafeExtent(
          partition.startLba,
          partition.sectorCount,
          totalSectorCount,
        );
        if (partitions.has(partition.number)) {
          throw new Error("DVD UDF partition number is duplicated");
        }
        partitions.set(partition.number, partition);
        for (const headerOffset of [56, 64, 72, 80, 88]) {
          const rawLength = descriptor.readUInt32LE(headerOffset);
          const extentLength = rawLength & UDF_EXTENT_LENGTH_MASK;
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
        if (logicalVolume !== undefined ||
          descriptor.readUInt32LE(212) !== DVD_SECTOR_SIZE_BYTES) {
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
          if (mapType !== 1 || mapLength !== 6 ||
            mapOffset + mapLength > 440 + mapTableLength) {
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
        logicalVolume = {
          fileSetDescriptor: readUdfLongAllocationDescriptor(descriptor, 248),
          integritySequenceLength: descriptor.readUInt32LE(432),
          integritySequenceStartLba: descriptor.readUInt32LE(436),
          partitionNumbersByReference,
        };
      } else if (identifier === 8) {
        sawTerminator = true;
        break;
      }
    }
    let reserveTerminatorSeen = false;
    for (let index = 0; index < reserveSequenceSectors; index += 1) {
      const descriptor = await readSector(reserveSequenceStart + index);
      const identifier = validateUdfTag(
        descriptor,
        [1, 3, 4, 5, 6, 7, 8, 9],
      );
      if (identifier === 8) {
        reserveTerminatorSeen = true;
        break;
      }
    }
    if (!sawTerminator || logicalVolume === undefined || partitions.size === 0) {
      throw new Error("DVD UDF volume descriptor sequence is incomplete");
    }
    if (!reserveTerminatorSeen) {
      throw new Error("DVD UDF reserve descriptor sequence is incomplete");
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
    const fileSetDescriptor = await readExtent(
      fileSetLba,
      Math.max(logicalVolume.fileSetDescriptor.extentLength, 512),
      "filesystem_metadata",
      MAX_FILE_ENTRY_BYTES,
    );
    validateUdfTag(fileSetDescriptor, [256]);
    const rootIcb = readUdfLongAllocationDescriptor(fileSetDescriptor, 400);

    const visitedIcbs = new Set<string>();
    const parseUdfNode = async (
      icb: UdfLongAllocationDescriptor,
      path: string,
    ): Promise<void> => {
      if (icb.extentType !== 0 || icb.extentLength <= 0) {
        throw new Error("DVD UDF ICB extent is unsupported");
      }
      const icbLba = partitionAbsoluteLba(icb, partitionsByReference);
      const key = `${icb.partitionReferenceNumber}:${icb.logicalBlockNumber}`;
      if (visitedIcbs.has(key)) {
        return;
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
        informationLength > expectedByteCount
      ) {
        throw new Error("DVD UDF file entry is malformed");
      }
      const isDirectory = fileType === 4;
      if (!isDirectory && fileType !== 5) {
        throw new Error("DVD UDF file type is unsupported");
      }
      const dataExtents: Array<{ startLba: number; byteCount: number }> = [];
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
          if (extentType === 0xc000_0000 || extentType === 0x8000_0000) {
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
          addExtent(startLba, sectorCountForBytes(extentLength), extentReason);
        }
      }
      if (!isDirectory) {
        udfDvdPaths.add(path.toUpperCase());
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
      let entryCount = 0;
      while (offset < directory.byteLength) {
        if (offset + 38 > directory.byteLength) {
          throw new Error("DVD UDF directory entry is truncated");
        }
        const descriptor = directory.subarray(offset);
        validateUdfTag(descriptor, [257]);
        entryCount += 1;
        if (entryCount > MAX_DIRECTORY_ENTRIES) {
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

  try {
    const isoVolumeSpaceSize = await parseIso();
    const udfBounds = await parseUdf();
    const requiredDvdPaths = [
      "VIDEO_TS/VIDEO_TS.IFO",
      "VIDEO_TS/VIDEO_TS.BUP",
    ];
    if (requiredDvdPaths.some((path) => !isoDvdPaths.has(path)) ||
      (udfBounds.hasUdf &&
        requiredDvdPaths.some((path) => !udfDvdPaths.has(path)))) {
      throw new Error("DVD-Video control structures are missing");
    }
    for (const badLba of badSectors) {
      const allocated = allocatedExtents.find((extent) =>
        extentContainsLba(extent, badLba)
      );
      if (allocated !== undefined) {
        return { outcome: "rejected", reason: allocated.reason };
      }
      if (
        udfBounds.damagedRecognition &&
        recognitionDescriptorsContainLba(badLba)
      ) {
        return { outcome: "rejected", reason: "ambiguous" };
      }
      if (
        badLba >= isoVolumeSpaceSize ||
        (udfBounds.hasUdf && !udfBounds.partitions.some((partition) =>
          badLba >= partition.startLba &&
          badLba < partition.startLba + partition.sectorCount
        ))
      ) {
        return { outcome: "rejected", reason: "unmappable" };
      }
      if (badLba < 16) {
        return { outcome: "rejected", reason: "ambiguous" };
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
    return { outcome: "accepted" };
  } catch (error) {
    if (error instanceof ClassifiedDamageError) {
      return { outcome: "rejected", reason: error.reason };
    }
    throw error;
  } finally {
    await handle.close();
  }
}
