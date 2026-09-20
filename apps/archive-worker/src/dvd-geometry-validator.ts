import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { requireDvdContentSize } from "./dvd-content-policy.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";

const MAX_ISO_DESCRIPTOR_SECTORS = 256;
const MAX_UDF_DESCRIPTOR_SECTORS = 256;
const UDF_RECOGNITION_SECTORS = 32;
const UDF_EXTENT_LENGTH_MASK = 0x3fff_ffff;
const UDF_EXTENT_TYPE_MASK = 0xc000_0000;

export interface DvdGeometryValidationRequest {
  expectedByteCount: number;
  imagePath: string;
  signal: AbortSignal;
}

export interface DvdGeometryValidator {
  validate(request: DvdGeometryValidationRequest): Promise<void>;
}

export type DvdGeometryIssue =
  | "definite_truncation"
  | "malformed_metadata"
  | "unsupported_layout";

export interface DvdImageGeometry {
  imageSectorCount: number;
  isoVolumeSectorCount: number | null;
  udfMaximumDeclaredSectorCount: number | null;
}

export class DvdGeometryValidationError extends Error {
  override readonly name = "DvdGeometryValidationError";

  constructor(
    message: string,
    readonly issue: DvdGeometryIssue = "malformed_metadata",
    readonly geometry: DvdImageGeometry | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface IsoGeometryView {
  logicalBlockSize: number;
  volumeSequenceNumber: number;
  volumeSetSize: number;
  volumeSpaceSize: number;
}

interface UdfExtent {
  sectorCount: number;
  startLba: number;
}

interface UdfPartition {
  number: number;
  sectorCount: number;
  startLba: number;
}

interface UdfLongAllocationDescriptor {
  extentLength: number;
  extentType: number;
  logicalBlockNumber: number;
  partitionReferenceNumber: number;
}

interface UdfLogicalVolumeGeometry {
  fileSetDescriptor: UdfLongAllocationDescriptor;
  integritySequence: UdfExtent;
  logicalBlockSize: number;
  partitionNumbersByReference: readonly number[];
}

interface UdfSequenceGeometry {
  logicalVolume: UdfLogicalVolumeGeometry;
  partitions: readonly UdfPartition[];
  primaryVolumeExtents: readonly UdfExtent[];
  unallocatedExtents: readonly UdfExtent[];
}

interface UdfGeometryView {
  maximumDeclaredSectorCount: number;
}

interface DvdGeometryReader {
  readSector(lba: number): Promise<Buffer>;
  totalSectorCount: number;
}

function geometryError(
  message: string,
  issue: DvdGeometryIssue = "malformed_metadata",
  geometry: DvdImageGeometry | null = null,
): never {
  throw new DvdGeometryValidationError(message, issue, geometry);
}

function enrichGeometryError(
  error: unknown,
  geometry: DvdImageGeometry,
): never {
  if (!(error instanceof DvdGeometryValidationError)) {
    throw error;
  }
  throw new DvdGeometryValidationError(
    error.message,
    error.issue,
    {
      imageSectorCount: geometry.imageSectorCount,
      isoVolumeSectorCount:
        error.geometry?.isoVolumeSectorCount ?? geometry.isoVolumeSectorCount,
      udfMaximumDeclaredSectorCount:
        error.geometry?.udfMaximumDeclaredSectorCount ??
        geometry.udfMaximumDeclaredSectorCount,
    },
    { cause: error },
  );
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function requireExtentInsideImage(
  extent: UdfExtent,
  totalSectorCount: number,
  description: string,
): void {
  const endLba = extent.startLba + extent.sectorCount;
  if (
    !Number.isSafeInteger(extent.startLba) ||
    extent.startLba < 0 ||
    !Number.isSafeInteger(extent.sectorCount) ||
    extent.sectorCount <= 0 ||
    !Number.isSafeInteger(endLba)
  ) {
    geometryError(`DVD ${description} is malformed`);
  }
  if (endLba > totalSectorCount) {
    geometryError(
      `DVD ${description} exceeds the image`,
      "definite_truncation",
      {
        imageSectorCount: totalSectorCount,
        isoVolumeSectorCount: null,
        udfMaximumDeclaredSectorCount: endLba,
      },
    );
  }
}

function sectorCountForBytes(byteCount: number, description: string): number {
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0) {
    geometryError(`DVD ${description} is malformed`);
  }
  const sectorCount = Math.ceil(byteCount / DVD_SECTOR_SIZE_BYTES);
  if (!Number.isSafeInteger(sectorCount) || sectorCount <= 0) {
    geometryError(`DVD ${description} is malformed`);
  }
  return sectorCount;
}

function readBothEndian16(
  buffer: Buffer,
  offset: number,
  description: string,
): number {
  const littleEndian = buffer.readUInt16LE(offset);
  if (littleEndian !== buffer.readUInt16BE(offset + 2)) {
    geometryError(`DVD ${description} is malformed`);
  }
  return littleEndian;
}

function readBothEndian32(
  buffer: Buffer,
  offset: number,
  description: string,
): number {
  const littleEndian = buffer.readUInt32LE(offset);
  if (littleEndian !== buffer.readUInt32BE(offset + 4)) {
    geometryError(`DVD ${description} is malformed`);
  }
  return littleEndian;
}

function isoViewsAgree(
  left: IsoGeometryView,
  right: IsoGeometryView,
): boolean {
  return left.logicalBlockSize === right.logicalBlockSize &&
    left.volumeSequenceNumber === right.volumeSequenceNumber &&
    left.volumeSetSize === right.volumeSetSize &&
    left.volumeSpaceSize === right.volumeSpaceSize;
}

async function validateIsoGeometry(
  reader: DvdGeometryReader,
): Promise<IsoGeometryView | undefined> {
  if (reader.totalSectorCount <= 16) {
    return undefined;
  }
  const firstDescriptor = await reader.readSector(16);
  if (firstDescriptor.toString("latin1", 1, 6) !== "CD001") {
    return undefined;
  }

  const views: IsoGeometryView[] = [];
  let primaryViewCount = 0;
  let sawTerminator = false;
  for (let index = 0; index < MAX_ISO_DESCRIPTOR_SECTORS; index += 1) {
    const lba = 16 + index;
    if (lba >= reader.totalSectorCount) {
      geometryError("DVD ISO volume descriptor sequence is truncated");
    }
    const descriptor = index === 0
      ? firstDescriptor
      : await reader.readSector(lba);
    if (
      descriptor.toString("latin1", 1, 6) !== "CD001" ||
      descriptor[6] !== 1
    ) {
      geometryError("DVD ISO volume descriptor sequence is malformed");
    }
    const type = descriptor[0]!;
    if (type === 255) {
      sawTerminator = true;
      break;
    }
    if (type !== 1 && type !== 2) {
      continue;
    }
    if (
      type === 2 &&
      !["%/@", "%/C", "%/E"].includes(
        descriptor.toString("latin1", 88, 91),
      )
    ) {
      geometryError(
        "DVD ISO supplementary volume is unsupported",
        "unsupported_layout",
      );
    }
    if (type === 1) {
      primaryViewCount += 1;
      if (primaryViewCount > 1) {
        geometryError("DVD ISO has conflicting primary volume views");
      }
    }
    const volumeSpaceSize = readBothEndian32(
      descriptor,
      80,
      "ISO volume-space declaration",
    );
    const volumeSetSize = readBothEndian16(
      descriptor,
      120,
      "ISO volume-set size",
    );
    const volumeSequenceNumber = readBothEndian16(
      descriptor,
      124,
      "ISO volume-sequence number",
    );
    const logicalBlockSize = readBothEndian16(
      descriptor,
      128,
      "ISO logical-block size",
    );
    if (
      volumeSpaceSize <= 0 ||
      volumeSetSize <= 0 ||
      volumeSequenceNumber <= 0 ||
      volumeSequenceNumber > volumeSetSize ||
      logicalBlockSize !== DVD_SECTOR_SIZE_BYTES
    ) {
      geometryError("DVD ISO volume geometry is malformed");
    }
    if (volumeSpaceSize > reader.totalSectorCount) {
      geometryError(
        "DVD ISO volume-space declaration exceeds the image",
        "definite_truncation",
        {
          imageSectorCount: reader.totalSectorCount,
          isoVolumeSectorCount: volumeSpaceSize,
          udfMaximumDeclaredSectorCount: null,
        },
      );
    }
    views.push({
      logicalBlockSize,
      volumeSequenceNumber,
      volumeSetSize,
      volumeSpaceSize,
    });
  }
  if (!sawTerminator) {
    geometryError("DVD ISO volume descriptor sequence exceeds its read bound");
  }
  if (primaryViewCount !== 1 || views.length === 0) {
    geometryError("DVD ISO primary volume geometry is missing");
  }
  if (views.some((view) => !isoViewsAgree(view, views[0]!))) {
    geometryError("DVD ISO filesystem geometry views disagree");
  }
  return views[0]!;
}

function udfDescriptorCrcLength(buffer: Buffer, identifier: number): number {
  if ([1, 2, 3, 4, 5, 8].includes(identifier)) {
    return 496;
  }
  if (identifier === 6) {
    const mapTableLength = buffer.readUInt32LE(264);
    const crcLength = 424 + mapTableLength;
    if (!Number.isSafeInteger(crcLength)) {
      geometryError("DVD UDF descriptor CRC length is malformed");
    }
    return crcLength;
  }
  if (identifier === 7) {
    const allocationCount = buffer.readUInt32LE(20);
    const crcLength = 8 + allocationCount * 8;
    if (!Number.isSafeInteger(crcLength)) {
      geometryError("DVD UDF descriptor CRC length is malformed");
    }
    return crcLength;
  }
  geometryError(
    "DVD UDF descriptor type is unsupported",
    "unsupported_layout",
  );
}

function validateUdfTag(
  buffer: Buffer,
  expectedIdentifiers: readonly number[],
  expectedLocation: number,
): number {
  if (buffer.byteLength !== DVD_SECTOR_SIZE_BYTES) {
    geometryError("DVD UDF descriptor is truncated");
  }
  const identifier = buffer.readUInt16LE(0);
  if (!expectedIdentifiers.includes(identifier)) {
    geometryError("DVD UDF descriptor has an unexpected type");
  }
  if (
    ![2, 3].includes(buffer.readUInt16LE(2)) ||
    buffer[5] !== 0 ||
    buffer.readUInt32LE(12) !== expectedLocation
  ) {
    geometryError("DVD UDF descriptor tag is malformed");
  }
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) {
      checksum = (checksum + buffer[index]!) & 0xff;
    }
  }
  if (checksum !== buffer[4]) {
    geometryError("DVD UDF descriptor tag checksum is malformed");
  }
  const crcLength = buffer.readUInt16LE(10);
  const expectedCrcLength = udfDescriptorCrcLength(buffer, identifier);
  if (
    crcLength !== expectedCrcLength ||
    expectedCrcLength < 0 ||
    expectedCrcLength > buffer.byteLength - 16
  ) {
    geometryError("DVD UDF descriptor CRC length is malformed");
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
    geometryError("DVD UDF descriptor CRC is malformed");
  }
  return identifier;
}

function readUdfExtent(
  buffer: Buffer,
  offset: number,
  totalSectorCount: number,
  description: string,
  allowEmpty = false,
): UdfExtent | undefined {
  const byteCount = buffer.readUInt32LE(offset);
  const startLba = buffer.readUInt32LE(offset + 4);
  if (byteCount === 0) {
    if (!allowEmpty || startLba !== 0) {
      geometryError(`DVD ${description} is malformed`);
    }
    return undefined;
  }
  const extent = {
    sectorCount: sectorCountForBytes(byteCount, description),
    startLba,
  };
  requireExtentInsideImage(extent, totalSectorCount, description);
  return extent;
}

function readUdfLongAllocationDescriptor(
  buffer: Buffer,
  offset: number,
): UdfLongAllocationDescriptor {
  const rawLength = buffer.readUInt32LE(offset);
  return {
    extentLength: rawLength & UDF_EXTENT_LENGTH_MASK,
    extentType: rawLength & UDF_EXTENT_TYPE_MASK,
    logicalBlockNumber: buffer.readUInt32LE(offset + 4),
    partitionReferenceNumber: buffer.readUInt16LE(offset + 8),
  };
}

function canonicalUdfGeometry(geometry: UdfSequenceGeometry): string {
  return JSON.stringify({
    logicalVolume: geometry.logicalVolume,
    partitions: [...geometry.partitions].sort((left, right) =>
      left.number - right.number ||
      left.startLba - right.startLba ||
      left.sectorCount - right.sectorCount
    ),
    primaryVolumeExtents: [...geometry.primaryVolumeExtents].sort((left, right) =>
      left.startLba - right.startLba || left.sectorCount - right.sectorCount
    ),
    unallocatedExtents: [...geometry.unallocatedExtents].sort((left, right) =>
      left.startLba - right.startLba || left.sectorCount - right.sectorCount
    ),
  });
}

function validateUdfPartitionReferences(
  geometry: UdfSequenceGeometry,
  totalSectorCount: number,
): void {
  const partitions = new Map(
    geometry.partitions.map((partition) => [partition.number, partition]),
  );
  const partitionsByReference =
    geometry.logicalVolume.partitionNumbersByReference.map((number) => {
      const partition = partitions.get(number);
      if (partition === undefined) {
        geometryError("DVD UDF partition map has no declaration");
      }
      return partition;
    });
  const fileSet = geometry.logicalVolume.fileSetDescriptor;
  const partition = partitionsByReference[fileSet.partitionReferenceNumber];
  const fileSetSectorCount = sectorCountForBytes(
    fileSet.extentLength,
    "UDF file-set descriptor extent",
  );
  const relativeEndLba = fileSet.logicalBlockNumber + fileSetSectorCount;
  if (
    fileSet.extentType !== 0 ||
    partition === undefined ||
    !Number.isSafeInteger(relativeEndLba) ||
    relativeEndLba > partition.sectorCount
  ) {
    geometryError("DVD UDF file-set descriptor extent exceeds its partition");
  }
  requireExtentInsideImage({
    sectorCount: fileSetSectorCount,
    startLba: partition.startLba + fileSet.logicalBlockNumber,
  }, totalSectorCount, "UDF file-set descriptor extent");
}

async function parseUdfDescriptorSequence(
  reader: DvdGeometryReader,
  sequence: UdfExtent,
): Promise<UdfSequenceGeometry> {
  if (sequence.sectorCount > MAX_UDF_DESCRIPTOR_SECTORS) {
    geometryError("DVD UDF volume descriptor sequence exceeds its read bound");
  }
  let logicalVolume: UdfLogicalVolumeGeometry | undefined;
  const partitions = new Map<number, UdfPartition>();
  const primaryVolumeExtents: UdfExtent[] = [];
  const unallocatedExtents: UdfExtent[] = [];
  let sawPrimaryVolume = false;
  let sawTerminator = false;

  for (let index = 0; index < sequence.sectorCount; index += 1) {
    const lba = sequence.startLba + index;
    const descriptor = await reader.readSector(lba);
    const identifier = validateUdfTag(
      descriptor,
      [1, 3, 4, 5, 6, 7, 8],
      lba,
    );
    if (identifier === 8) {
      sawTerminator = true;
      break;
    }
    if (identifier === 3) {
      geometryError(
        "DVD UDF volume descriptor continuation is unsupported",
        "unsupported_layout",
      );
    }
    if (identifier === 1) {
      if (sawPrimaryVolume) {
        geometryError("DVD UDF primary volume geometry is duplicated");
      }
      sawPrimaryVolume = true;
      for (const offset of [328, 336]) {
        const extent = readUdfExtent(
          descriptor,
          offset,
          reader.totalSectorCount,
          "UDF primary-volume extent",
          true,
        );
        if (extent !== undefined) {
          primaryVolumeExtents.push(extent);
        }
      }
      continue;
    }
    if (identifier === 5) {
      const partition: UdfPartition = {
        number: descriptor.readUInt16LE(22),
        sectorCount: descriptor.readUInt32LE(192),
        startLba: descriptor.readUInt32LE(188),
      };
      requireExtentInsideImage(
        partition,
        reader.totalSectorCount,
        "UDF partition declaration",
      );
      if (partitions.has(partition.number)) {
        geometryError("DVD UDF partition geometry is duplicated");
      }
      partitions.set(partition.number, partition);
      for (const offset of [56, 64, 72, 80, 88]) {
        const rawLength = descriptor.readUInt32LE(offset);
        const relativeLba = descriptor.readUInt32LE(offset + 4);
        const extentLength = rawLength & UDF_EXTENT_LENGTH_MASK;
        if (extentLength === 0) {
          if (relativeLba !== 0) {
            geometryError("DVD UDF partition metadata extent is malformed");
          }
          continue;
        }
        const relativeSectorCount = sectorCountForBytes(
          extentLength,
          "UDF partition metadata extent",
        );
        const relativeEndLba = relativeLba + relativeSectorCount;
        if (
          (rawLength & UDF_EXTENT_TYPE_MASK) !== 0 ||
          !Number.isSafeInteger(relativeEndLba) ||
          relativeEndLba > partition.sectorCount
        ) {
          geometryError("DVD UDF partition metadata extent exceeds its partition");
        }
      }
      continue;
    }
    if (identifier === 6) {
      if (logicalVolume !== undefined) {
        geometryError("DVD UDF logical-volume geometry is duplicated");
      }
      const logicalBlockSize = descriptor.readUInt32LE(212);
      const mapTableLength = descriptor.readUInt32LE(264);
      const partitionMapCount = descriptor.readUInt32LE(268);
      const mapEnd = 440 + mapTableLength;
      if (
        logicalBlockSize !== DVD_SECTOR_SIZE_BYTES ||
        mapTableLength <= 0 ||
        partitionMapCount <= 0 ||
        partitionMapCount > 16 ||
        !Number.isSafeInteger(mapEnd) ||
        mapEnd > descriptor.byteLength
      ) {
        geometryError("DVD UDF logical-volume geometry is malformed");
      }
      const partitionNumbersByReference: number[] = [];
      let mapOffset = 440;
      while (mapOffset < mapEnd) {
        const mapType = descriptor[mapOffset]!;
        const mapLength = descriptor[mapOffset + 1]!;
        if (
          mapType !== 1 ||
          mapLength !== 6 ||
          mapOffset + mapLength > mapEnd
        ) {
          geometryError(
            "DVD UDF partition map is unsupported",
            "unsupported_layout",
          );
        }
        partitionNumbersByReference.push(
          descriptor.readUInt16LE(mapOffset + 4),
        );
        mapOffset += mapLength;
      }
      if (partitionNumbersByReference.length !== partitionMapCount) {
        geometryError("DVD UDF partition map count is malformed");
      }
      const integritySequence = readUdfExtent(
        descriptor,
        432,
        reader.totalSectorCount,
        "UDF integrity-sequence declaration",
      )!;
      logicalVolume = {
        fileSetDescriptor: readUdfLongAllocationDescriptor(descriptor, 248),
        integritySequence,
        logicalBlockSize,
        partitionNumbersByReference,
      };
      continue;
    }
    if (identifier === 7) {
      const allocationCount = descriptor.readUInt32LE(20);
      const allocationEnd = 24 + allocationCount * 8;
      if (
        allocationCount > 61 ||
        !Number.isSafeInteger(allocationEnd) ||
        allocationEnd > descriptor.byteLength
      ) {
        geometryError("DVD UDF unallocated-space geometry is malformed");
      }
      for (let allocation = 0; allocation < allocationCount; allocation += 1) {
        unallocatedExtents.push(readUdfExtent(
          descriptor,
          24 + allocation * 8,
          reader.totalSectorCount,
          "UDF unallocated-space declaration",
        )!);
      }
    }
  }
  if (
    !sawTerminator ||
    !sawPrimaryVolume ||
    logicalVolume === undefined ||
    partitions.size === 0
  ) {
    geometryError("DVD UDF volume geometry is incomplete");
  }
  const geometry = {
    logicalVolume,
    partitions: [...partitions.values()],
    primaryVolumeExtents,
    unallocatedExtents,
  };
  validateUdfPartitionReferences(geometry, reader.totalSectorCount);
  return geometry;
}

function hasUdfRecognitionSignature(descriptor: Buffer): boolean {
  const identifier = descriptor.toString("latin1", 1, 6);
  const sevenBitIdentifier = Buffer.from(
    descriptor.subarray(1, 6).map((byte) => byte & 0x7f),
  ).toString("latin1");
  return ["BEA01", "NSR02", "NSR03", "TEA01"].includes(identifier) ||
    ["BEA01", "NSR02", "NSR03", "TEA01"].includes(sevenBitIdentifier);
}

async function hasValidUdfAnchor(
  reader: DvdGeometryReader,
  lba: number,
): Promise<boolean> {
  if (lba < 0 || lba >= reader.totalSectorCount) {
    return false;
  }
  const descriptor = await reader.readSector(lba);
  if (descriptor.readUInt16LE(0) !== 2) {
    return false;
  }
  validateUdfTag(descriptor, [2], lba);
  return true;
}

async function validateUdfGeometry(
  reader: DvdGeometryReader,
): Promise<UdfGeometryView | undefined> {
  const recognitionDescriptors: Array<{
    descriptor: Buffer;
    identifier: string;
  }> = [];
  const recognitionEnd = Math.min(
    reader.totalSectorCount,
    16 + UDF_RECOGNITION_SECTORS,
  );
  for (let lba = 16; lba < recognitionEnd; lba += 1) {
    const descriptor = await reader.readSector(lba);
    recognitionDescriptors.push({
      descriptor,
      identifier: descriptor.toString("latin1", 1, 6),
    });
  }
  const beginningIndexes = recognitionDescriptors.flatMap(
    ({ identifier }, index) => identifier === "BEA01" ? [index] : [],
  );
  const nsrIndexes = recognitionDescriptors.flatMap(
    ({ identifier }, index) =>
      identifier === "NSR02" || identifier === "NSR03" ? [index] : [],
  );
  const terminatorIndexes = recognitionDescriptors.flatMap(
    ({ identifier }, index) => identifier === "TEA01" ? [index] : [],
  );
  if (nsrIndexes.length === 0) {
    const hasRecognitionFragment = recognitionDescriptors.some(
      ({ descriptor }) => hasUdfRecognitionSignature(descriptor),
    );
    let hasAnchorEvidence = false;
    for (const lba of [
      256,
      reader.totalSectorCount - 257,
      reader.totalSectorCount - 1,
    ]) {
      hasAnchorEvidence ||= await hasValidUdfAnchor(reader, lba);
    }
    if (hasRecognitionFragment || hasAnchorEvidence) {
      geometryError("DVD UDF recognition sequence is incomplete");
    }
    return undefined;
  }
  const beginningIndex = beginningIndexes[0] ?? -1;
  const nsrIndex = nsrIndexes[0] ?? -1;
  const terminatorIndex = terminatorIndexes[0] ?? -1;
  if (
    beginningIndexes.length !== 1 ||
    nsrIndexes.length !== 1 ||
    terminatorIndexes.length !== 1 ||
    beginningIndex >= nsrIndex ||
    nsrIndex >= terminatorIndex
  ) {
    geometryError("DVD UDF recognition sequence is incomplete");
  }
  for (const index of [beginningIndex, nsrIndex, terminatorIndex]) {
    const descriptor = recognitionDescriptors[index]!.descriptor;
    if (
      descriptor[0] !== 0 ||
      descriptor[6] !== 1 ||
      descriptor.subarray(7).some((byte) => byte !== 0)
    ) {
      geometryError("DVD UDF recognition descriptor is malformed");
    }
  }
  for (let index = beginningIndex + 1; index < terminatorIndex; index += 1) {
    if (index !== nsrIndex) {
      geometryError(
        "DVD UDF recognition sequence is unsupported",
        "unsupported_layout",
      );
    }
  }
  if (reader.totalSectorCount <= 256) {
    geometryError("DVD UDF volume geometry is truncated");
  }
  const anchor = await reader.readSector(256);
  validateUdfTag(anchor, [2], 256);
  const mainSequence = readUdfExtent(
    anchor,
    16,
    reader.totalSectorCount,
    "UDF main volume-descriptor sequence",
  )!;
  const reserveSequence = readUdfExtent(
    anchor,
    24,
    reader.totalSectorCount,
    "UDF reserve volume-descriptor sequence",
  )!;
  if (
    mainSequence.startLba < reserveSequence.startLba + reserveSequence.sectorCount &&
    reserveSequence.startLba < mainSequence.startLba + mainSequence.sectorCount
  ) {
    geometryError("DVD UDF volume-descriptor sequences overlap");
  }
  const mainGeometry = await parseUdfDescriptorSequence(reader, mainSequence);
  const reserveGeometry = await parseUdfDescriptorSequence(
    reader,
    reserveSequence,
  );
  if (
    canonicalUdfGeometry(mainGeometry) !==
      canonicalUdfGeometry(reserveGeometry)
  ) {
    geometryError("DVD UDF geometry views disagree");
  }
  const validAnchorLbas = [256];
  for (const alternateLba of [
    reader.totalSectorCount - 257,
    reader.totalSectorCount - 1,
  ]) {
    if (alternateLba === 256 || alternateLba < 0) {
      continue;
    }
    const alternate = await reader.readSector(alternateLba);
    if (alternate.every((byte) => byte === 0)) {
      continue;
    }
    if (alternate.readUInt16LE(0) !== 2) {
      continue;
    }
    validateUdfTag(alternate, [2], alternateLba);
    if (!alternate.subarray(16, 32).equals(anchor.subarray(16, 32))) {
      geometryError("DVD UDF anchor geometry views disagree");
    }
    validAnchorLbas.push(alternateLba);
  }
  const declaredExtents: UdfExtent[] = [
    mainSequence,
    reserveSequence,
    ...mainGeometry.partitions,
    ...mainGeometry.primaryVolumeExtents,
    ...mainGeometry.unallocatedExtents,
    mainGeometry.logicalVolume.integritySequence,
    ...validAnchorLbas.map((startLba) => ({ sectorCount: 1, startLba })),
  ];
  const fileSet = mainGeometry.logicalVolume.fileSetDescriptor;
  const fileSetPartition = mainGeometry.partitions.find((partition) =>
    partition.number ===
      mainGeometry.logicalVolume.partitionNumbersByReference[
        fileSet.partitionReferenceNumber
      ]
  )!;
  declaredExtents.push({
    sectorCount: sectorCountForBytes(
      fileSet.extentLength,
      "UDF file-set descriptor extent",
    ),
    startLba: fileSetPartition.startLba + fileSet.logicalBlockNumber,
  });
  return {
    maximumDeclaredSectorCount: Math.max(...declaredExtents.map((extent) =>
      extent.startLba + extent.sectorCount
    )),
  };
}

async function validateOpenedImage(
  handle: FileHandle,
  totalSectorCount: number,
  signal: AbortSignal,
): Promise<DvdImageGeometry> {
  let sectorReadCount = 0;
  const maximumSectorReads =
    MAX_ISO_DESCRIPTOR_SECTORS +
    UDF_RECOGNITION_SECTORS +
    MAX_UDF_DESCRIPTOR_SECTORS * 2 +
    8;
  const reader: DvdGeometryReader = {
    totalSectorCount,
    async readSector(lba) {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(lba) ||
        lba < 0 ||
        lba >= totalSectorCount ||
        sectorReadCount >= maximumSectorReads
      ) {
        geometryError("DVD volume geometry read exceeded its bound");
      }
      sectorReadCount += 1;
      const sector = Buffer.alloc(DVD_SECTOR_SIZE_BYTES);
      const { bytesRead } = await handle.read(
        sector,
        0,
        sector.byteLength,
        lba * DVD_SECTOR_SIZE_BYTES,
      );
      if (bytesRead !== sector.byteLength) {
        geometryError("DVD volume geometry read was incomplete");
      }
      return sector;
    },
  };
  const isoGeometry = await validateIsoGeometry(reader);
  let udfGeometry: UdfGeometryView | undefined;
  try {
    udfGeometry = await validateUdfGeometry(reader);
  } catch (error) {
    enrichGeometryError(error, {
      imageSectorCount: totalSectorCount,
      isoVolumeSectorCount: isoGeometry?.volumeSpaceSize ?? null,
      udfMaximumDeclaredSectorCount: null,
    });
  }
  if (isoGeometry === undefined && udfGeometry === undefined) {
    geometryError(
      "DVD image has no supported filesystem geometry view",
      "unsupported_layout",
      {
        imageSectorCount: totalSectorCount,
        isoVolumeSectorCount: null,
        udfMaximumDeclaredSectorCount: null,
      },
    );
  }
  if (
    isoGeometry !== undefined &&
    udfGeometry !== undefined &&
    udfGeometry.maximumDeclaredSectorCount > isoGeometry.volumeSpaceSize
  ) {
    geometryError(
      "DVD ISO and UDF geometry views disagree",
      "malformed_metadata",
      {
        imageSectorCount: totalSectorCount,
        isoVolumeSectorCount: isoGeometry.volumeSpaceSize,
        udfMaximumDeclaredSectorCount:
          udfGeometry.maximumDeclaredSectorCount,
      },
    );
  }
  return {
    imageSectorCount: totalSectorCount,
    isoVolumeSectorCount: isoGeometry?.volumeSpaceSize ?? null,
    udfMaximumDeclaredSectorCount:
      udfGeometry?.maximumDeclaredSectorCount ?? null,
  };
}

export async function inspectDvdImageGeometry({
  expectedByteCount,
  imagePath,
  signal,
}: DvdGeometryValidationRequest): Promise<DvdImageGeometry> {
  signal.throwIfAborted();
  let safeExpectedByteCount: number;
  try {
    safeExpectedByteCount = requireDvdContentSize(expectedByteCount);
  } catch (error) {
    throw new DvdGeometryValidationError(
      "DVD volume geometry image size is invalid",
      "malformed_metadata",
      null,
      { cause: error },
    );
  }
  if (safeExpectedByteCount % DVD_SECTOR_SIZE_BYTES !== 0) {
    geometryError("DVD volume geometry image size is not sector aligned");
  }
  const pathMetadata = await lstat(imagePath, { bigint: true });
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size !== BigInt(safeExpectedByteCount)
  ) {
    geometryError("DVD volume geometry image is not the expected regular file");
  }
  const handle = await open(
    imagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileMetadata(pathMetadata, before)) {
      geometryError("DVD volume geometry image changed before validation");
    }
    let geometry: DvdImageGeometry;
    try {
      geometry = await validateOpenedImage(
        handle,
        safeExpectedByteCount / DVD_SECTOR_SIZE_BYTES,
        signal,
      );
    } catch (error) {
      if (signal.aborted || error instanceof DvdGeometryValidationError) {
        throw error;
      }
      throw new DvdGeometryValidationError(
        "DVD volume geometry validation failed",
        "malformed_metadata",
        null,
        { cause: error },
      );
    }
    signal.throwIfAborted();
    if (!sameFileMetadata(before, await handle.stat({ bigint: true }))) {
      geometryError("DVD volume geometry image changed during validation");
    }
    return geometry;
  } finally {
    await handle.close();
  }
}

export async function validateDvdImageGeometry(
  request: DvdGeometryValidationRequest,
): Promise<void> {
  await inspectDvdImageGeometry(request);
}

export function createNodeDvdGeometryValidator(): DvdGeometryValidator {
  return { validate: validateDvdImageGeometry };
}
