import type { FileHandle } from "node:fs/promises";
import type { DvdUnrecoveredSourceRange } from "@rip-dvd/data-access";

export const SECTOR = 2048;
export interface PhysicalDependency {
  startLba: number;
  sectorCount: number;
}
export interface MetadataObservation {
  field: string;
  view?: string;
  status: "known" | "source_unavailable" | "dependent_unknown";
  dependencies: PhysicalDependency[];
  sourceRanges?: DvdUnrecoveredSourceRange[];
  prerequisites?: string[];
  value?: unknown;
}
export interface MetadataBlocker {
  field: string;
  reason:
    | "contradiction"
    | "unsupported_layout"
    | "work_bound"
    | "local_failure";
  message: string;
}
export class ProfileFailure extends Error {
  constructor(readonly blocker: MetadataBlocker) {
    super(blocker.message);
  }
}
export interface FileMapping {
  offset: number;
  start: number;
  bytes: number;
}
export interface FileClaim {
  path: string;
  start?: number;
  bytes?: number;
  mappings?: FileMapping[];
  prerequisites: string[];
}
export interface FilesystemView {
  name: string;
  files: Map<string, FileClaim>;
  complete: boolean;
  prerequisites: string[];
}
export interface ValueClaim {
  value: unknown;
  fields: string[];
}

// Source evidence stays as sorted intervals. Neither lookup nor validation enumerates sectors.
export function validateSourceRanges(
  ranges: readonly DvdUnrecoveredSourceRange[],
  sectors: number,
) {
  if (ranges.length >= 250000)
    throw new ProfileFailure({
      field: "sourceRanges",
      reason: "work_bound",
      message: "Source interval limit reached",
    });
  let previous: DvdUnrecoveredSourceRange | undefined;
  for (const range of ranges) {
    const end = range.startLba + range.sectorCount;
    if (
      !Number.isSafeInteger(range.startLba) ||
      range.startLba < 0 ||
      !Number.isSafeInteger(range.sectorCount) ||
      range.sectorCount <= 0 ||
      !Number.isSafeInteger(end) ||
      end > sectors ||
      !["skipped_untested", "individually_failed"].includes(
        range.classification,
      ) ||
      (previous &&
        (range.startLba < previous.startLba + previous.sectorCount ||
          (range.startLba === previous.startLba + previous.sectorCount &&
            range.classification === previous.classification)))
    ) {
      throw new ProfileFailure({
        field: "sourceRanges",
        reason: "local_failure",
        message: "Source intervals are not canonical for the accepted image",
      });
    }
    previous = range;
  }
}
export class ProfileReader {
  readonly observations: MetadataObservation[] = [];
  readonly navBuffers = new Map<number, Buffer>();
  currentView?: string;
  readonly views: FilesystemView[] = [];
  readonly isoVolumes: number[] = [];
  readonly udfExtents: { start: number; bytes: number; field: string }[] = [];
  readonly mirrors = new Map<string, ValueClaim>();
  readonly counters = new Map<string, number>();
  bootstrap = false;
  geometry = false;
  unknown = false;
  constructor(
    readonly file: FileHandle,
    readonly sectors: number,
    readonly ranges: readonly DvdUnrecoveredSourceRange[],
    readonly signal: AbortSignal,
  ) {}
  fail(
    field: string,
    message: string,
    reason: MetadataBlocker["reason"] = "contradiction",
  ): never {
    throw new ProfileFailure({ field, message, reason });
  }
  check(
    condition: boolean,
    field: string,
    message: string,
    reason?: MetadataBlocker["reason"],
  ) {
    this.signal.throwIfAborted();
    if (!condition) this.fail(field, message, reason);
  }
  count(key: string, amount: number, limit: number) {
    const value = (this.counters.get(key) ?? 0) + amount;
    this.check(
      Number.isSafeInteger(value) && value < limit,
      key,
      `${key} work limit reached`,
      "work_bound",
    );
    this.counters.set(key, value);
  }
  intersections(start: number, bytes: number): DvdUnrecoveredSourceRange[] {
    const first = Math.floor(start / SECTOR),
      end = Math.ceil((start + bytes) / SECTOR);
    let lo = 0,
      hi = this.ranges.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = this.ranges[mid]!;
      if (r.startLba + r.sectorCount <= first) lo = mid + 1;
      else hi = mid;
    }
    const result: DvdUnrecoveredSourceRange[] = [];
    for (let i = lo; i < this.ranges.length; i++) {
      const r = this.ranges[i]!;
      if (r.startLba >= end) break;
      const a = Math.max(first, r.startLba),
        b = Math.min(end, r.startLba + r.sectorCount);
      result.push({
        startLba: a,
        sectorCount: b - a,
        classification: r.classification,
      });
    }
    return result;
  }
  dependent(field: string, prerequisites: string[]): undefined {
    this.unknown = true;
    this.observations.push({
      field,
      status: "dependent_unknown",
      dependencies: [],
      prerequisites: [...new Set(prerequisites)],
    });
    return undefined;
  }
  derived(field: string, value: unknown, prerequisites: string[]) {
    if (value === undefined) return this.dependent(field, prerequisites);
    this.observations.push({
      field,
      view: this.currentView,
      status: "known",
      value,
      prerequisites,
      dependencies: [],
    });
  }
  compare(
    field: string,
    left: unknown,
    right: unknown,
    prerequisites: string[],
  ) {
    if (left === undefined || right === undefined) {
      this.dependent(field, prerequisites);
      return;
    }
    const agrees = JSON.stringify(left) === JSON.stringify(right);
    this.observations.push({
      field,
      view: this.currentView,
      status: "known",
      dependencies: [],
      prerequisites,
      value: { left, right, agrees },
    });
    this.check(agrees, field, "Readable claims disagree");
  }
  mirror(key: string, value: unknown, fields: string[]) {
    if (value === undefined) return;
    const prior = this.mirrors.get(key);
    if (prior)
      this.compare(key, prior.value, value, [...prior.fields, ...fields]);
    else this.mirrors.set(key, { value, fields });
  }
  extent(
    start: number | undefined,
    bytes: number | undefined,
    field: string,
    container = this.sectors * SECTOR,
  ) {
    if (start === undefined || bytes === undefined)
      return this.dependent(field, [`${field}.location`, `${field}.length`]);
    this.count("extents", 1, 250000);
    this.check(
      Number.isSafeInteger(start) &&
        start >= 0 &&
        Number.isSafeInteger(bytes) &&
        bytes >= 0 &&
        Number.isSafeInteger(start + bytes) &&
        start + bytes <= this.sectors * SECTOR &&
        start + bytes <= container,
      field,
      "Declared extent exceeds its container or image",
    );
  }
  async record(
    start: number,
    bytes: number,
    name: string,
  ): Promise<ProfileRecord> {
    this.signal.throwIfAborted();
    this.extent(start, bytes, name);
    const buffer = Buffer.alloc(bytes);
    // Read available runs only. A local short read outside source evidence is never waived.
    let at = 0;
    while (at < bytes) {
      this.signal.throwIfAborted();
      const length = Math.min(bytes - at, SECTOR - ((start + at) % SECTOR));
      if (this.intersections(start + at, length).length === 0) {
        const { bytesRead } = await this.file.read(
          buffer,
          at,
          length,
          start + at,
        );
        this.check(
          bytesRead === length,
          name,
          "Short local metadata read",
          "local_failure",
        );
      }
      at += length;
    }
    return new ProfileRecord(this, buffer, start, name);
  }
}
export class ProfileRecord {
  constructor(
    readonly reader: ProfileReader,
    readonly buffer: Buffer,
    readonly start: number,
    readonly name: string,
  ) {}
  field<T>(
    suffix: string,
    offset: number,
    bytes: number,
    decode: (b: Buffer, o: number) => T,
  ): T | undefined {
    const field = `${this.name}.${suffix}`;
    this.reader.check(
      offset >= 0 && bytes >= 0 && offset + bytes <= this.buffer.length,
      field,
      "Field exceeds record",
    );
    const start = this.start + offset,
      end = start + bytes;
    const dependencies = [
      {
        startLba: Math.floor(start / SECTOR),
        sectorCount: Math.ceil(end / SECTOR) - Math.floor(start / SECTOR),
      },
    ];
    const sourceRanges = this.reader.intersections(start, bytes);
    if (sourceRanges.length) {
      this.reader.unknown = true;
      this.reader.observations.push({
        field,
        view: this.reader.currentView,
        status: "source_unavailable",
        dependencies,
        sourceRanges,
      });
      return undefined;
    }
    const value = decode(this.buffer, offset);
    this.reader.observations.push({
      field,
      view: this.reader.currentView,
      status: "known",
      dependencies,
      value,
    });
    return value;
  }
  u8(n: string, o: number) {
    return this.field(n, o, 1, (b, p) => b.readUInt8(p));
  }
  u16(n: string, o: number) {
    return this.field(n, o, 2, (b, p) => b.readUInt16LE(p));
  }
  u32(n: string, o: number) {
    return this.field(n, o, 4, (b, p) => b.readUInt32LE(p));
  }
  u64(n: string, o: number) {
    return this.field(n, o, 8, (b, p) => {
      const v = b.readBigUInt64LE(p);
      this.reader.check(
        v <= BigInt(Number.MAX_SAFE_INTEGER),
        `${this.name}.${n}`,
        "Unsafe integer",
      );
      return Number(v);
    });
  }
  be16(n: string, o: number) {
    return this.field(n, o, 2, (b, p) => b.readUInt16BE(p));
  }
  be32(n: string, o: number) {
    return this.field(n, o, 4, (b, p) => b.readUInt32BE(p));
  }
  text(n: string, o: number, length: number) {
    return this.field(n, o, length, (b, p) =>
      b.toString("latin1", p, p + length),
    );
  }
  zero(n: string, o: number, length: number) {
    const v = this.field(n, o, length, (b, p) =>
      b.subarray(p, p + length).every((x) => x === 0),
    );
    if (v !== undefined)
      this.reader.check(v, `${this.name}.${n}`, "Reserved bytes are nonzero");
  }
  both(n: string, o: number, width: 2 | 4) {
    return this.field(n, o, width * 2, (b, p) => {
      const a = width === 2 ? b.readUInt16LE(p) : b.readUInt32LE(p);
      const z =
        width === 2 ? b.readUInt16BE(p + width) : b.readUInt32BE(p + width);
      this.reader.check(
        a === z,
        `${this.name}.${n}`,
        "Paired endian values disagree",
      );
      return a;
    });
  }
  expect(
    value: unknown,
    expected: unknown,
    suffix: string,
    reason?: MetadataBlocker["reason"],
  ) {
    if (value !== undefined)
      this.reader.check(
        value === expected,
        `${this.name}.${suffix}`,
        `Expected ${String(expected)}`,
        reason,
      );
  }
}
export function canonicalDvdPath(
  reader: ProfileReader,
  name: string,
): string | undefined {
  const upper = name.toUpperCase();
  const base = upper.replace(/;[0-9]+$/, "");
  if (
    !/^(VIDEO_TS\.(IFO|BUP|VOB)|VTS_(0[1-9]|[1-9][0-9])_0\.(IFO|BUP|VOB)|VTS_(0[1-9]|[1-9][0-9])_[1-9]\.VOB)$/.test(
      base,
    )
  )
    return undefined;
  reader.check(
    upper === base || upper === `${base};1`,
    name,
    "Unsupported DVD file version",
    "unsupported_layout",
  );
  reader.count("pathBytes", Buffer.byteLength(base), 16 * 1024 * 1024);
  return `VIDEO_TS/${base}`;
}
export function addFile(
  reader: ProfileReader,
  view: FilesystemView,
  file: FileClaim,
) {
  reader.check(
    !view.files.has(file.path),
    `${view.name}/${file.path}`,
    "Duplicate canonical path",
  );
  if (file.bytes !== undefined)
    reader.check(
      file.bytes > 0 && file.bytes % SECTOR === 0,
      file.path,
      "DVD file length must be positive and sector-aligned",
    );
  view.files.set(file.path, file);
}

export function fileMappings(file: FileClaim): FileMapping[] {
  return (
    file.mappings ??
    (file.start !== undefined && file.bytes !== undefined
      ? [{ offset: 0, start: file.start, bytes: file.bytes }]
      : [])
  );
}
export function fileAddress(
  file: FileClaim,
  offset: number,
  bytes: number,
): number | undefined {
  const mappings = fileMappings(file);
  const match = mappings.find(
    (m) => m.offset <= offset && m.offset + m.bytes >= offset + bytes,
  );
  return match === undefined ? undefined : match.start + offset - match.offset;
}
export async function fileRecord(
  reader: ProfileReader,
  file: FileClaim,
  offset: number,
  bytes: number,
  name: string,
): Promise<ProfileRecord | undefined> {
  const address = fileAddress(file, offset, bytes);
  if (address === undefined) {
    reader.dependent(name, file.prerequisites);
    return;
  }
  return reader.record(address, bytes, name);
}
