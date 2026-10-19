import {
  addFile,
  canonicalDvdPath,
  ProfileReader,
  ProfileRecord,
  SECTOR,
  type FileClaim,
  type FileMapping,
  type FilesystemView,
} from "./dvd-metadata-profile-reader.js";
interface Extent {
  bytes?: number;
  block?: number;
  reference?: number;
  fields: string[];
}
interface Partition {
  number: number;
  start?: number;
  sectors?: number;
  field: string;
}
interface LogicalVolume {
  maps?: number[];
  fileSet: Extent;
  field: string;
}
interface Sequence {
  partitions: Map<number, Partition>;
  logical?: LogicalVolume;
  gaps: string[];
  name: string;
}
function crc16(buffer: Buffer) {
  let crc = 0;
  for (const byte of buffer) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
function tag(
  r: ProfileRecord,
  expected: number | undefined,
  location: number,
  bodyLength: number | undefined,
) {
  const id = r.u16("tag.identifier", 0);
  if (expected !== undefined) r.expect(id, expected, "tag.identifier");
  r.expect(r.u16("tag.version", 2), 2, "tag.version", "unsupported_layout");
  r.expect(r.u8("tag.reserved", 5), 0, "tag.reserved");
  r.expect(r.u32("tag.location", 12), location, "tag.location");
  const checksum = r.u8("tag.checksum", 4),
    computed = r.field("tag.checksumBytes", 0, 16, (b, p) =>
      b
        .subarray(p, p + 16)
        .reduce((sum, v, i) => (i === 4 ? sum : (sum + v) & 255), 0),
    );
  if (checksum !== undefined && computed !== undefined)
    r.expect(checksum, computed, "tag.checksum");
  const length = r.u16("tag.crcLength", 10),
    crc = r.u16("tag.crc", 8);
  if (length !== undefined) {
    r.reader.check(
      16 + length <= r.buffer.length,
      r.name,
      "CRC length exceeds record",
    );
    if (bodyLength !== undefined) r.expect(length, bodyLength, "tag.crcLength");
    else
      r.reader.dependent(`${r.name}.tag.expectedCrcLength`, [
        `${r.name}.recordLength`,
      ]);
    const actual = r.field("tag.crcBytes", 16, length, (b, p) =>
      crc16(b.subarray(p, p + length)),
    );
    if (actual !== undefined && crc !== undefined)
      r.expect(crc, actual, "tag.crc");
  }
  return id;
}
function domain(r: ProfileRecord, offset: number, revision: number) {
  r.expect(
    r.text(`domain${offset}`, offset + 1, 23),
    "*OSTA UDF Compliant".padEnd(23, "\0"),
    `domain${offset}`,
    "unsupported_layout",
  );
  r.expect(
    r.u16(`revision${revision}`, revision),
    0x102,
    `revision${revision}`,
    "unsupported_layout",
  );
}
function extent(
  r: ProfileRecord,
  offset: number,
  name: string,
  long = false,
  recorded = long,
): Extent {
  const encoded = r.u32(`${name}.length`, offset),
    block = r.u32(`${name}.location`, offset + 4),
    reference = long
      ? r.u16(`${name}.partitionReference`, offset + 8)
      : undefined;
  if (recorded && encoded !== undefined)
    r.reader.check(
      encoded >>> 30 === 0,
      `${r.name}.${name}`,
      "Non-recorded allocation is unsupported",
      "unsupported_layout",
    );
  const bytes =
    encoded === undefined
      ? undefined
      : recorded
        ? encoded & 0x3fffffff
        : encoded;
  if (bytes === 0 && block !== undefined)
    r.expect(block, 0, `${name}.location`);
  return {
    bytes,
    block,
    reference,
    fields: [
      `${r.name}.${name}.length`,
      `${r.name}.${name}.location`,
      ...(long ? [`${r.name}.${name}.partitionReference`] : []),
    ],
  };
}
function physical(reader: ProfileReader, e: Extent, name: string) {
  if (e.bytes !== undefined && e.block !== undefined) {
    reader.extent(e.block * SECTOR, e.bytes, name);
    reader.udfExtents.push({
      start: e.block * SECTOR,
      bytes: e.bytes,
      field: name,
    });
  } else reader.dependent(name, e.fields);
}
function resolve(
  reader: ProfileReader,
  sequence: Sequence,
  maps: number[] | undefined,
  e: Extent,
  name: string,
): {
  start?: number;
  bytes?: number;
  partition?: Partition;
  prerequisites: string[];
} {
  const prerequisites = [
    ...e.fields,
    `${sequence.logical?.field ?? sequence.name}.partitionMaps`,
  ];
  if (maps === undefined || e.reference === undefined) {
    reader.dependent(name, [
      ...prerequisites,
      `${sequence.logical?.field ?? sequence.name}.partitionMaps`,
    ]);
    return { bytes: e.bytes, prerequisites };
  }
  reader.check(
    e.reference < maps.length,
    name,
    "Partition reference exceeds map list",
  );
  const partition = sequence.partitions.get(maps[e.reference]!);
  if (!partition) {
    reader.check(
      sequence.gaps.length > 0,
      name,
      "Referenced partition is missing",
    );
    reader.dependent(name, [...prerequisites, ...sequence.gaps]);
    return {
      bytes: e.bytes,
      prerequisites: [...prerequisites, ...sequence.gaps],
    };
  }
  const start =
    partition.start !== undefined && e.block !== undefined
      ? (partition.start + e.block) * SECTOR
      : undefined;
  if (
    e.block !== undefined &&
    e.bytes !== undefined &&
    partition.sectors !== undefined
  )
    reader.extent(e.block * SECTOR, e.bytes, name, partition.sectors * SECTOR);
  if (start !== undefined) {
    reader.extent(start, e.bytes, name);
    if (e.bytes !== undefined)
      reader.udfExtents.push({ start, bytes: e.bytes, field: name });
  } else reader.dependent(name, [...prerequisites, partition.field]);
  return {
    start,
    bytes: e.bytes,
    partition,
    prerequisites: [
      ...prerequisites,
      `${partition.field}.partitionStart`,
      `${partition.field}.partitionLength`,
    ],
  };
}
function mirrorExtent(reader: ProfileReader, key: string, e: Extent) {
  reader.mirror(`${key}.length`, e.bytes, e.fields);
  reader.mirror(`${key}.location`, e.block, e.fields);
  reader.mirror(`${key}.reference`, e.reference, e.fields);
}
async function sequence(
  reader: ProfileReader,
  start: number,
  bytes: number,
): Promise<Sequence> {
  const name = `UDF.sequence@${start}`;
  const result: Sequence = { name, partitions: new Map(), gaps: [] };
  let primary = 0,
    logical = 0,
    terminated = false;
  reader.check(
    bytes > 0 && bytes % SECTOR === 0 && bytes / SECTOR < 256,
    name,
    "Invalid or excessive descriptor sequence",
    "unsupported_layout",
  );
  reader.extent(start * SECTOR, bytes, name);
  for (let i = 0; i < bytes / SECTOR; i++) {
    const r = await reader.record(
        (start + i) * SECTOR,
        SECTOR,
        `${name}.slot${i}`,
      ),
      id = r.u16("tag.identifier", 0);
    if (id === undefined) {
      result.gaps.push(`${r.name}.tag.identifier`);
      continue;
    }
    reader.check(
      [1, 4, 5, 6, 7, 8].includes(id),
      r.name,
      "Unsupported volume descriptor",
      "unsupported_layout",
    );
    let crcLength: number | undefined = 496;
    if (id === 6) {
      const n = r.u32("mapByteCount", 264);
      crcLength = n === undefined ? undefined : 424 + n;
    }
    if (id === 7) {
      const n = r.u32("allocationCount", 20);
      if (n !== undefined)
        reader.check(
          n <= 61,
          r.name,
          "Unallocated-space list exceeds descriptor",
        );
      crcLength = n === undefined ? undefined : 8 + n * 8;
    }
    tag(r, id, start + i, crcLength);
    if (id === 8) {
      terminated = true;
      break;
    }
    if (id === 1) {
      primary++;
      reader.check(primary === 1, r.name, "Duplicate UDF primary descriptor");
      for (const o of [328, 336]) {
        const e = extent(r, o, `primaryExtent${o}`);
        physical(reader, e, `${r.name}.primaryExtent${o}`);
        mirrorExtent(reader, `UDF.PVD.extent${o}`, e);
      }
    }
    if (id === 5) {
      r.expect(
        r.u16("partitionFlags", 20),
        1,
        "partitionFlags",
        "unsupported_layout",
      );
      r.expect(
        r.text("contents", 25, 6),
        "+NSR02",
        "contents",
        "unsupported_layout",
      );
      r.expect(r.u32("accessType", 184), 1, "accessType", "unsupported_layout");
      const number = r.u16("partitionNumber", 22),
        at = r.u32("partitionStart", 188),
        sectors = r.u32("partitionLength", 192);
      if (sectors !== undefined)
        reader.check(sectors > 0, r.name, "Empty UDF partition");
      if (at !== undefined && sectors !== undefined) {
        reader.extent(at * SECTOR, sectors * SECTOR, r.name);
        reader.udfExtents.push({
          start: at * SECTOR,
          bytes: sectors * SECTOR,
          field: r.name,
        });
        reader.geometry = true;
      }
      if (number !== undefined) {
        reader.check(
          !result.partitions.has(number),
          r.name,
          "Duplicate partition number",
        );
        result.partitions.set(number, {
          number,
          start: at,
          sectors,
          field: r.name,
        });
        reader.mirror(`UDF.partition${number}.start`, at, [
          `${r.name}.partitionStart`,
        ]);
        reader.mirror(`UDF.partition${number}.length`, sectors, [
          `${r.name}.partitionLength`,
        ]);
      }
      for (const o of [56, 64, 72, 80, 88]) {
        const e = extent(r, o, `partitionHeader${o}`, false, true);
        if (e.block !== undefined && e.bytes !== undefined) {
          if (sectors !== undefined)
            reader.extent(
              e.block * SECTOR,
              e.bytes,
              `${r.name}.partitionHeader${o}`,
              sectors * SECTOR,
            );
          if (at !== undefined) {
            reader.extent(
              (at + e.block) * SECTOR,
              e.bytes,
              `${r.name}.partitionHeader${o}`,
            );
            if (e.bytes)
              reader.udfExtents.push({
                start: (at + e.block) * SECTOR,
                bytes: e.bytes,
                field: r.name,
              });
          }
        }
        if (number !== undefined)
          mirrorExtent(reader, `UDF.partition${number}.header${o}`, e);
      }
    }
    if (id === 6) {
      logical++;
      reader.check(logical === 1, r.name, "Duplicate UDF logical volume");
      r.expect(r.u32("blockSize", 212), SECTOR, "blockSize");
      domain(r, 216, 240);
      const fileSet = extent(r, 248, "fileSet", true),
        integrity = extent(r, 432, "integrity");
      physical(reader, integrity, `${r.name}.integrity`);
      mirrorExtent(reader, "UDF.LVD.fileSet", fileSet);
      mirrorExtent(reader, "UDF.LVD.integrity", integrity);
      const mapBytes = r.u32("mapByteCount", 264),
        count = r.u32("mapCount", 268);
      let maps: number[] | undefined;
      if (count !== undefined)
        reader.check(
          count > 0 && count <= 16,
          r.name,
          "Unsupported partition map count",
          "unsupported_layout",
        );
      if (mapBytes !== undefined)
        reader.check(
          mapBytes > 0 && 440 + mapBytes <= SECTOR,
          r.name,
          "Partition maps exceed descriptor",
        );
      if (count !== undefined && mapBytes !== undefined) {
        reader.check(
          count * 6 === mapBytes,
          r.name,
          "Partition map lengths do not cover count",
          "unsupported_layout",
        );
        maps = [];
        for (let j = 0; j < count; j++) {
          const o = 440 + j * 6;
          r.expect(
            r.u8(`map${j}.type`, o),
            1,
            `map${j}.type`,
            "unsupported_layout",
          );
          r.expect(
            r.u8(`map${j}.length`, o + 1),
            6,
            `map${j}.length`,
            "unsupported_layout",
          );
          r.expect(
            r.u16(`map${j}.volumeSequence`, o + 2),
            1,
            `map${j}.volumeSequence`,
          );
          const n = r.u16(`map${j}.partitionNumber`, o + 4);
          if (n === undefined) maps = undefined;
          else maps?.push(n);
        }
        reader.derived(`${r.name}.partitionMaps`, maps, [
          `${r.name}.mapCount`,
          `${r.name}.mapByteCount`,
          ...Array.from(
            { length: count },
            (_, j) => `${r.name}.map${j}.partitionNumber`,
          ),
        ]);
        reader.mirror("UDF.LVD.partitionMaps", maps, [
          `${r.name}.mapCount`,
          `${r.name}.mapByteCount`,
          `${r.name}.partitionMaps`,
        ]);
      }
      result.logical = { maps, fileSet, field: r.name };
    }
    if (id === 7) {
      const count = r.u32("allocationCount", 20);
      if (count !== undefined) {
        reader.mirror("UDF.unallocated.count", count, [
          `${r.name}.allocationCount`,
        ]);
        for (let j = 0; j < count; j++) {
          const e = extent(r, 24 + j * 8, `unallocated${j}`);
          physical(reader, e, `${r.name}.unallocated${j}`);
          mirrorExtent(reader, `UDF.unallocated${j}`, e);
        }
      }
    }
  }
  if (!result.gaps.length)
    reader.check(
      terminated && primary === 1 && logical === 1,
      name,
      "Complete UDF sequence lacks required descriptors",
    );
  else reader.dependent(`${name}.requiredDescriptors`, result.gaps);
  if (result.logical) {
    for (const number of result.logical.maps ?? [])
      if (!result.partitions.has(number)) {
        reader.check(
          result.gaps.length > 0,
          name,
          "LVD partition map has no partition descriptor",
        );
        reader.dependent(`${name}.partition${number}`, result.gaps);
      }
    reader.bootstrap = true;
  }
  return result;
}
interface Entry {
  bytes?: number;
  start?: number;
  mappings: FileMapping[];
  allocations: {
    start?: number;
    bytes?: number;
    partition?: Partition;
    prerequisites: string[];
  }[];
  prerequisites: string[];
  icb: number;
}
async function fileEntry(
  reader: ProfileReader,
  seq: Sequence,
  maps: number[] | undefined,
  allocation: Extent,
  directory: boolean,
  name: string,
  visited: Map<number, boolean>,
): Promise<Entry | undefined> {
  const resolved = resolve(reader, seq, maps, allocation, `${name}.ICB`);
  if (resolved.start === undefined) {
    reader.dependent(`${name}.entry`, resolved.prerequisites);
    return;
  }
  reader.check(
    !visited.has(resolved.start) ||
      (!directory && visited.get(resolved.start) === false),
    name,
    "Visited ICB cycle or conflicting type",
    "unsupported_layout",
  );
  visited.set(resolved.start, directory);
  if (resolved.bytes !== undefined)
    reader.check(
      resolved.bytes >= 176 && resolved.bytes < 1024 * 1024,
      name,
      "Invalid or excessive file entry length",
      "unsupported_layout",
    );
  const first = await reader.record(
    resolved.start,
    Math.min(resolved.bytes ?? SECTOR, SECTOR),
    `${name}.FE`,
  );
  const id = first.u16("tag.identifier", 0);
  if (id !== undefined)
    first.expect(id, 261, "tag.identifier", "unsupported_layout");
  first.expect(
    first.u8("fileType", 27),
    directory ? 4 : 5,
    "fileType",
    "unsupported_layout",
  );
  const flags = first.u16("icbFlags", 34),
    info = first.u64("informationLength", 56),
    blocks = first.u64("recordedBlocks", 64),
    xa = first.u32("extendedAttributeLength", 168),
    length = first.u32("allocationDescriptorLength", 172);
  first.zero("externalAttributeICB", 112, 16);
  first.expect(xa, 0, "extendedAttributeLength", "unsupported_layout");
  if (flags !== undefined)
    reader.check(
      (flags & 0xe000) === 0 && (flags & 7) <= 1,
      name,
      "Unsupported file allocation form",
      "unsupported_layout",
    );
  let record = first;
  if (length !== undefined && xa !== undefined) {
    const bytes = 176 + xa + length;
    reader.check(
      bytes < 1024 * 1024 && bytes <= (resolved.bytes ?? SECTOR),
      name,
      "Allocation list exceeds file entry",
      "unsupported_layout",
    );
    if (bytes > first.buffer.length)
      record = await reader.record(resolved.start, bytes, `${name}.FE`);
  }
  tag(
    record,
    261,
    allocation.block!,
    length === undefined || xa === undefined ? undefined : 160 + xa + length,
  );
  const allocationFields: string[] = [
    `${first.name}.icbFlags`,
    `${first.name}.extendedAttributeLength`,
    `${first.name}.allocationDescriptorLength`,
  ];
  const allocations: Entry["allocations"] = [],
    mappings: FileMapping[] = [];
  let offsetKnown = true;
  let known = true,
    total = 0,
    recorded = 0,
    firstStart: number | undefined,
    end: number | undefined;
  if (flags !== undefined && length !== undefined && xa !== undefined) {
    const width = (flags & 7) === 0 ? 8 : 16;
    reader.check(
      length % width === 0,
      name,
      "Allocation descriptor list is misaligned",
    );
    for (let at = 0; at < length; at += width) {
      reader.count("allocationRecords", 1, 50000);
      const e = extent(
        record,
        176 + xa + at,
        `allocation${at / width}`,
        width === 16,
        true,
      );
      allocationFields.push(...e.fields);
      if (width === 8) e.reference = allocation.reference;
      const a = resolve(
        reader,
        seq,
        maps,
        e,
        `${name}.allocation${at / width}`,
      );
      allocations.push(a);
      if (
        !directory &&
        a.start !== undefined &&
        firstStart !== undefined &&
        offsetKnown
      )
        reader.check(
          a.start === firstStart + total,
          name,
          "Fragmented relevant DVD file",
          "unsupported_layout",
        );
      if (a.bytes !== undefined && a.start !== undefined && offsetKnown) {
        const prior = mappings.at(-1);
        if (
          prior &&
          prior.offset + prior.bytes === total &&
          prior.start + prior.bytes === a.start
        )
          prior.bytes += a.bytes;
        else mappings.push({ offset: total, start: a.start, bytes: a.bytes });
      }
      if (a.bytes !== undefined) {
        reader.check(a.bytes > 0, name, "Empty allocation descriptor");
        if (at + width < length)
          reader.check(
            a.bytes % SECTOR === 0,
            name,
            "Padding before final allocation",
            "unsupported_layout",
          );
        total += a.bytes;
        recorded += Math.ceil(a.bytes / SECTOR);
      } else {
        known = false;
        offsetKnown = false;
      }
      if (a.start === undefined) known = false;
      if (at === 0) firstStart = a.start;
      if (!directory && end !== undefined && a.start !== undefined)
        reader.check(
          end === a.start,
          name,
          "Fragmented relevant DVD file",
          "unsupported_layout",
        );
      end =
        a.start !== undefined && a.bytes !== undefined
          ? a.start + a.bytes
          : undefined;
    }
    if (known) {
      if (info !== undefined)
        reader.check(
          total >= info &&
            total - info < SECTOR &&
            (!allocations.length ? info === 0 : true),
          name,
          "Allocation lengths do not cover information length",
        );
      if (blocks !== undefined)
        reader.check(
          recorded === blocks,
          name,
          "Recorded blocks disagree with allocations",
        );
    } else
      reader.dependent(
        `${name}.allocationCoverage`,
        allocations.flatMap((a) => a.prerequisites),
      );
  } else {
    known = false;
    reader.dependent(`${name}.allocations`, [
      `${first.name}.icbFlags`,
      `${first.name}.allocationDescriptorLength`,
    ]);
  }
  reader.derived(`${first.name}.allocations`, firstStart, allocationFields);
  return {
    start: firstStart,
    bytes: info,
    allocations,
    mappings,
    prerequisites: resolved.prerequisites.concat(
      `${first.name}.informationLength`,
      `${first.name}.allocations`,
    ),
    icb: resolved.start,
  };
}
async function directory(
  reader: ProfileReader,
  seq: Sequence,
  maps: number[] | undefined,
  location: Extent,
  parentIcb: number | undefined,
  view: FilesystemView,
  video: boolean,
  visited: Map<number, boolean>,
) {
  const name = `${view.name}/${video ? "VIDEO_TS" : "root"}`,
    entry = await fileEntry(reader, seq, maps, location, true, name, visited);
  if (!entry) {
    view.complete = false;
    view.prerequisites.push(`${name}.entry`);
    return;
  }
  if (entry.bytes !== undefined) {
    reader.check(
      entry.bytes > 0 && entry.bytes < 16 * 1024 * 1024,
      name,
      "Invalid directory length or work limit",
      "work_bound",
    );
    reader.count("directoryBytes", entry.bytes, 128 * 1024 * 1024);
  }
  let complete = entry.bytes !== undefined;
  let remaining = entry.bytes;
  let videoIcb: Extent | undefined;
  for (const a of entry.allocations) {
    if (
      a.start === undefined ||
      a.bytes === undefined ||
      remaining === undefined
    ) {
      complete = false;
      view.prerequisites.push(...a.prerequisites);
      continue;
    }
    const bytes = Math.min(a.bytes, remaining);
    remaining -= bytes;
    for (let at = 0; at < bytes; at += SECTOR) {
      const block = await reader.record(
        a.start + at,
        Math.min(SECTOR, bytes - at),
        `${name}.block@${a.start + at}`,
      );
      if (block.u16("tag.identifier", 0) === undefined) {
        complete = false;
        view.prerequisites.push(`${block.name}.tag.identifier`);
        continue;
      }
      let offset = 0;
      while (offset < block.buffer.length) {
        const r = new ProfileRecord(
          reader,
          block.buffer.subarray(offset),
          block.start + offset,
          `${block.name}.FID@${offset}`,
        );
        const id = r.u16("tag.identifier", 0);
        if (id === 0) {
          r.zero("padding", 0, r.buffer.length);
          break;
        }
        r.expect(id, 257, "tag.identifier");
        reader.count("directoryRecords", 1, 100000);
        reader.check(r.buffer.length >= 38, r.name, "Truncated FID");
        r.expect(r.u16("version", 16), 1, "version");
        const flags = r.u8("characteristics", 18),
          nameLength = r.u8("nameLength", 19),
          useLength = r.u16("implementationUseLength", 36);
        if (flags !== undefined)
          reader.check(
            [0, 2, 10].includes(flags),
            r.name,
            "Unsupported FID characteristics",
            "unsupported_layout",
          );
        r.expect(useLength, 0, "implementationUseLength", "unsupported_layout");
        if (nameLength === undefined || useLength === undefined) {
          complete = false;
          view.prerequisites.push(`${r.name}.nameLength`);
          break;
        }
        const length = Math.ceil((38 + useLength + nameLength) / 4) * 4;
        reader.check(
          length <= r.buffer.length,
          r.name,
          "Cross-block FID is unsupported",
          "unsupported_layout",
        );
        tag(
          new ProfileRecord(
            reader,
            r.buffer.subarray(0, length),
            r.start,
            r.name,
          ),
          257,
          Math.floor(
            (block.start - (a.partition?.start ?? 0) * SECTOR) / SECTOR,
          ),
          length - 16,
        );
        const icb = extent(r, 20, "ICB", true);
        resolve(reader, seq, maps, icb, `${r.name}.ICB`);
        if (flags === 10) {
          r.expect(nameLength, 0, "nameLength");
          const resolved = resolve(reader, seq, maps, icb, `${r.name}.parent`);
          if (
            resolved.start !== undefined &&
            (parentIcb ?? entry.icb) !== undefined
          )
            reader.check(
              resolved.start === (parentIcb ?? entry.icb),
              r.name,
              "Parent ICB disagrees",
            );
        } else {
          reader.check(nameLength > 1, r.name, "Missing FID identifier");
          const text = r.field(
            "identifier",
            38 + useLength,
            nameLength,
            (b, p) => {
              const compression = b[p];
              reader.check(
                compression === 8 || compression === 16,
                r.name,
                "Unsupported compressed Unicode",
                "unsupported_layout",
              );
              reader.count("pathBytes", nameLength, 16 * 1024 * 1024);
              if (compression === 8)
                return b
                  .toString("latin1", p + 1, p + nameLength)
                  .toUpperCase();
              reader.check(
                (nameLength - 1) % 2 === 0,
                r.name,
                "Odd compressed Unicode identifier",
              );
              let name = "";
              for (let j = 1; j < nameLength; j += 2)
                name += String.fromCharCode(b.readUInt16BE(p + j));
              return name.toUpperCase();
            },
          );
          if (!video && text === "VIDEO_TS") {
            reader.check(videoIcb === undefined, r.name, "Duplicate VIDEO_TS");
            r.expect(flags, 2, "characteristics");
            videoIcb = icb;
          } else if (video && text !== undefined) {
            const path = canonicalDvdPath(reader, text);
            if (path) {
              r.expect(flags, 0, "characteristics");
              const f = await fileEntry(
                reader,
                seq,
                maps,
                icb,
                false,
                `${view.name}/${path}`,
                visited,
              );
              const claim: FileClaim = {
                path,
                start: f?.start,
                bytes: f?.bytes,
                mappings: f?.mappings ?? [],
                prerequisites: f?.prerequisites ?? icb.fields,
              };
              addFile(reader, view, claim);
            }
          }
        }
        offset += length;
      }
    }
  }
  if (remaining !== 0) complete = false;
  if (!complete) {
    view.complete = false;
    view.prerequisites.push(...entry.prerequisites);
  }
  if (!video) {
    if (videoIcb)
      await directory(
        reader,
        seq,
        maps,
        videoIcb,
        entry.icb,
        view,
        true,
        visited,
      );
    else if (complete) reader.fail(name, "Complete UDF root has no VIDEO_TS");
    else reader.dependent(`${name}.VIDEO_TS`, view.prerequisites);
  }
}
async function files(reader: ProfileReader, seq: Sequence) {
  const logical = seq.logical;
  if (!logical) {
    reader.dependent(`${seq.name}.filesystem`, seq.gaps);
    return;
  }
  const fsd = resolve(
    reader,
    seq,
    logical.maps,
    logical.fileSet,
    `${logical.field}.fileSet`,
  );
  const view: FilesystemView = {
    name: seq.name,
    files: new Map(),
    complete: true,
    prerequisites: [],
  };
  reader.views.push(view);
  if (fsd.start === undefined) {
    view.complete = false;
    view.prerequisites.push(...fsd.prerequisites);
    reader.dependent(`${seq.name}.FSD`, fsd.prerequisites);
    return;
  }
  if (fsd.bytes !== undefined)
    reader.check(fsd.bytes >= 512, seq.name, "FSD extent too short");
  const r = await reader.record(fsd.start, SECTOR, `${seq.name}.FSD`);
  tag(r, 256, logical.fileSet.block!, 496);
  domain(r, 416, 440);
  r.zero("nextAndSystemStreamICB", 448, 32);
  const root = extent(r, 400, "rootICB", true);
  if (root.bytes !== undefined)
    reader.check(root.bytes > 0, r.name, "Empty root ICB");
  await directory(
    reader,
    seq,
    logical.maps,
    root,
    undefined,
    view,
    false,
    new Map(),
  );
}
export async function inspectUdfProfile(reader: ProfileReader) {
  const found: { id: string; field: string }[] = [],
    recognitionGaps: string[] = [];
  for (let lba = 16; lba < Math.min(48, reader.sectors); lba++) {
    const r = await reader.record(
        lba * SECTOR,
        SECTOR,
        `UDF.recognition${lba}`,
      ),
      id = r.text("identifier", 1, 5);
    if (id === undefined) {
      recognitionGaps.push(`${r.name}.identifier`);
      continue;
    }
    if (!["BEA01", "NSR02", "NSR03", "TEA01"].includes(id)) continue;
    reader.check(
      id !== "NSR03",
      r.name,
      "UDF revision NSR03 is unsupported",
      "unsupported_layout",
    );
    r.expect(r.u8("structureType", 0), 0, "structureType");
    r.expect(r.u8("version", 6), 1, "version");
    r.zero("reserved", 7, SECTOR - 7);
    found.push({ id, field: `${r.name}.identifier` });
  }
  let last = -1;
  for (const record of found) {
    const position = ["BEA01", "NSR02", "TEA01"].indexOf(record.id);
    reader.check(
      position > last,
      record.field,
      "Conflicting recognition order or duplicate",
    );
    last = position;
  }
  const anchors: { main: Extent; reserve: Extent; name: string }[] = [],
    anchorGaps: string[] = [];
  for (const lba of new Set(
    [256, reader.sectors - 257, reader.sectors - 1].filter(
      (v) => v >= 0 && v < reader.sectors,
    ),
  )) {
    const r = await reader.record(lba * SECTOR, SECTOR, `UDF.anchor${lba}`),
      id = r.u16("tag.identifier", 0);
    if (id === undefined) {
      anchorGaps.push(`${r.name}.tag.identifier`);
      continue;
    }
    if (id !== 2) continue;
    tag(r, 2, lba, 496);
    const main = extent(r, 16, "main"),
      reserve = extent(r, 24, "reserve");
    for (const [which, e] of [
      ["main", main],
      ["reserve", reserve],
    ] as const) {
      if (e.bytes !== undefined)
        reader.check(
          e.bytes > 0 && e.bytes % SECTOR === 0 && e.bytes / SECTOR < 256,
          r.name,
          "Invalid anchor sequence extent",
          "unsupported_layout",
        );
      physical(reader, e, `${r.name}.${which}`);
      mirrorExtent(reader, `UDF.anchor.${which}`, e);
    }
    if (
      main.block !== undefined &&
      main.bytes !== undefined &&
      reserve.block !== undefined &&
      reserve.bytes !== undefined
    )
      reader.check(
        main.block * SECTOR + main.bytes <= reserve.block * SECTOR ||
          reserve.block * SECTOR + reserve.bytes <= main.block * SECTOR,
        r.name,
        "Anchor main/reserve sequences overlap",
      );
    anchors.push({ main, reserve, name: r.name });
  }
  if (!found.length && !anchors.length) {
    if (recognitionGaps.length || anchorGaps.length)
      reader.dependent("UDF.presence", [...recognitionGaps, ...anchorGaps]);
    return;
  }
  if (found.length < 3) {
    reader.check(
      recognitionGaps.length > 0,
      "UDF.recognition",
      "Incomplete readable UDF recognition sequence",
    );
    reader.dependent("UDF.recognitionSequence", recognitionGaps);
  }
  if (!anchors.length) {
    reader.check(
      anchorGaps.length > 0,
      "UDF.anchors",
      "No supported UDF anchor",
      "unsupported_layout",
    );
    reader.dependent("UDF.sequences", anchorGaps);
  }
  const sequences = new Map<string, Sequence>();
  for (const anchor of anchors)
    for (const e of [anchor.main, anchor.reserve]) {
      if (e.block === undefined || e.bytes === undefined) {
        reader.dependent(`${anchor.name}.sequence`, e.fields);
        continue;
      }
      const key = `${e.block}:${e.bytes}`;
      if (!sequences.has(key))
        sequences.set(key, await sequence(reader, e.block, e.bytes));
    }
  // Every known mirror claim was compared while parsing. Directory presence is retained per sequence.
  for (const seq of sequences.values()) await files(reader, seq);
}
