import {
  addFile,
  canonicalDvdPath,
  ProfileReader,
  ProfileRecord,
  SECTOR,
  type FilesystemView,
} from "./dvd-metadata-profile-reader.js";
interface IsoEntry {
  start?: number;
  bytes?: number;
  directory?: boolean;
  name?: string;
  fields: string[];
}
function entry(
  reader: ProfileReader,
  record: ProfileRecord,
  offset: number,
  joliet: boolean,
  volume: number | undefined,
): IsoEntry | undefined {
  const field = `${record.name}@${offset}`;
  const length = record.u8(`record@${offset}.length`, offset);
  if (length === undefined || length === 0) return undefined;
  reader.count("directoryRecords", 1, 100000);
  reader.check(
    length >= 34 &&
      offset + length <= record.buffer.length &&
      Math.floor((record.start + offset) / SECTOR) ===
        Math.floor((record.start + offset + length - 1) / SECTOR),
    field,
    "ISO record crosses block or is too short",
  );
  const r = new ProfileRecord(
    reader,
    record.buffer.subarray(offset, offset + length),
    record.start + offset,
    field,
  );
  const xa = r.u8("extendedAttributes", 1),
    lba = r.both("extentLba", 2, 4),
    bytes = r.both("dataLength", 10, 4),
    flags = r.u8("flags", 25);
  r.expect(r.u8("fileUnitSize", 26), 0, "fileUnitSize", "unsupported_layout");
  r.expect(r.u8("interleaveGap", 27), 0, "interleaveGap", "unsupported_layout");
  r.expect(r.both("volumeSequence", 28, 2), 1, "volumeSequence");
  if (flags !== undefined)
    reader.check(
      (flags & ~3) === 0,
      `${field}.flags`,
      "Unsupported ISO flags or multi-extent file",
      "unsupported_layout",
    );
  const nameLength = r.u8("identifierLength", 32);
  let name: string | undefined;
  if (nameLength !== undefined) {
    reader.check(
      nameLength > 0 && 33 + nameLength <= length,
      field,
      "ISO identifier exceeds record",
    );
    name = r.field("identifier", 33, nameLength, (b, p) => {
      if (nameLength === 1 && b[p]! <= 1) return b[p] === 0 ? "." : "..";
      reader.count("pathBytes", nameLength, 16 * 1024 * 1024);
      if (!joliet) {
        reader.check(
          b.subarray(p, p + nameLength).every((v) => v < 128),
          field,
          "Invalid ASCII ISO name",
        );
        return b.toString("ascii", p, p + nameLength).toUpperCase();
      }
      reader.check(nameLength % 2 === 0, field, "Odd Joliet identifier");
      let text = "";
      for (let i = 0; i < nameLength; i += 2)
        text += String.fromCharCode(b.readUInt16BE(p + i));
      return text.toUpperCase();
    });
  }
  const start =
    lba !== undefined && xa !== undefined ? (lba + xa) * SECTOR : undefined;
  if (lba !== undefined && xa !== undefined && bytes !== undefined) {
    reader.extent(
      lba * SECTOR,
      xa * SECTOR + bytes,
      field,
      volume === undefined ? undefined : volume * SECTOR,
    );
  } else
    reader.dependent(`${field}.range`, [
      `${field}.extentLba`,
      `${field}.extendedAttributes`,
      `${field}.dataLength`,
    ]);
  if (flags !== undefined && (flags & 2) !== 0 && bytes !== undefined)
    reader.check(bytes > 0, field, "Empty directory");
  return {
    start,
    bytes,
    directory: flags === undefined ? undefined : (flags & 2) !== 0,
    name,
    fields: [
      `${field}.extentLba`,
      `${field}.extendedAttributes`,
      `${field}.dataLength`,
    ],
  };
}
async function directory(
  reader: ProfileReader,
  view: FilesystemView,
  location: IsoEntry,
  parent: IsoEntry,
  joliet: boolean,
  volume: number | undefined,
  video: boolean,
): Promise<void> {
  const name = `${view.name}/${video ? "VIDEO_TS" : "root"}`;
  if (location.start === undefined || location.bytes === undefined) {
    view.complete = false;
    view.prerequisites.push(...location.fields);
    reader.dependent(name, location.fields);
    return;
  }
  reader.check(location.directory === true, name, "Expected ISO directory");
  reader.check(
    location.bytes < 16 * 1024 * 1024,
    name,
    "Directory work limit reached",
    "work_bound",
  );
  reader.count("directoryBytes", location.bytes, 128 * 1024 * 1024);
  let videoEntry: IsoEntry | undefined;
  let complete = true;
  for (let at = 0; at < location.bytes; at += SECTOR) {
    const record = await reader.record(
      location.start + at,
      Math.min(SECTOR, location.bytes - at),
      `${name}.block${at / SECTOR}`,
    );
    if (record.u8("recordLength", 0) === undefined) {
      complete = false;
      view.prerequisites.push(`${record.name}.recordLength`);
      continue;
    }
    let offset = 0;
    while (offset < record.buffer.length) {
      const item = entry(reader, record, offset, joliet, volume);
      if (!item) break;
      if (item.name === "." || item.name === "..") {
        const expected = item.name === "." ? location : parent;
        reader.compare(
          `${record.name}.${item.name}.start`,
          item.start,
          expected.start,
          item.fields.concat(expected.fields),
        );
        reader.compare(
          `${record.name}.${item.name}.length`,
          item.bytes,
          expected.bytes,
          item.fields.concat(expected.fields),
        );
        reader.check(
          item.directory === true,
          record.name,
          "Special ISO record is not a directory",
        );
      } else if (!video && item.name?.replace(/;1$/, "") === "VIDEO_TS") {
        reader.check(
          videoEntry === undefined,
          name,
          "Duplicate VIDEO_TS directory",
        );
        videoEntry = item;
      } else if (video && item.name) {
        const path = canonicalDvdPath(reader, item.name);
        if (path) {
          reader.check(
            item.directory === false,
            path,
            "DVD path is a directory",
          );
          addFile(reader, view, {
            path,
            start: item.start,
            bytes: item.bytes,
            prerequisites: item.fields,
          });
        }
      }
      offset += record.buffer[offset]!;
    }
  }
  if (!complete) view.complete = false;
  if (!video) {
    if (videoEntry) {
      // Root gaps do not weaken the independently located VIDEO_TS inventory.
      view.complete = true;
      view.prerequisites = [];
      await directory(reader, view, videoEntry, location, joliet, volume, true);
    } else if (complete)
      reader.fail(name, "Complete root directory has no VIDEO_TS");
    else reader.dependent(`${name}.VIDEO_TS`, view.prerequisites);
  }
}
export async function inspectIsoProfile(reader: ProfileReader) {
  if (reader.sectors <= 16) return;
  const first = await reader.record(16 * SECTOR, SECTOR, "ISO.slot16");
  const firstId = first.text("identifier", 1, 5);
  if (firstId !== undefined && firstId !== "CD001") return;
  let established = firstId === "CD001",
    gap = false,
    primary = 0,
    terminated = false;
  const descriptors: {
    record: ProfileRecord;
    joliet: boolean;
    volume?: number;
  }[] = [];
  for (let i = 0; i < 256 && 16 + i < reader.sectors; i++) {
    const r =
      i === 0
        ? first
        : await reader.record((16 + i) * SECTOR, SECTOR, `ISO.slot${16 + i}`);
    const id = i === 0 ? firstId : r.text("identifier", 1, 5);
    if (id === undefined) {
      gap = true;
      continue;
    }
    if (!established && id !== "CD001") continue;
    established = true;
    r.expect(id, "CD001", "identifier");
    r.expect(r.u8("version", 6), 1, "version");
    const type = r.u8("type", 0)!;
    reader.check(
      [0, 1, 2, 255].includes(type),
      r.name,
      "Unsupported ISO descriptor type",
      "unsupported_layout",
    );
    if (type === 255) {
      terminated = true;
      break;
    }
    if (type === 0) continue;
    if (type === 1) {
      primary++;
      reader.check(primary === 1, r.name, "Duplicate primary descriptor");
    }
    if (type === 2) {
      const escape = r.text("JolietEscape", 88, 3);
      if (escape !== undefined)
        reader.check(
          ["%/@", "%/C", "%/E"].includes(escape),
          r.name,
          "Unsupported supplementary descriptor",
          "unsupported_layout",
        );
    }
    const volume = r.both("volumeSpaceSize", 80, 4);
    r.expect(r.both("volumeSetSize", 120, 2), 1, "volumeSetSize");
    r.expect(r.both("volumeSequence", 124, 2), 1, "volumeSequence");
    r.expect(r.both("blockSize", 128, 2), SECTOR, "blockSize");
    if (volume !== undefined) {
      reader.check(
        volume > 0 && volume <= reader.sectors,
        `${r.name}.volumeSpaceSize`,
        "Invalid ISO volume size",
      );
      reader.mirror("ISO.volumeSpaceSize", volume, [
        `${r.name}.volumeSpaceSize`,
      ]);
      reader.isoVolumes.push(volume);
      reader.geometry = true;
    }
    const tableLength = r.both("pathTableLength", 132, 4);
    if (tableLength !== undefined)
      reader.check(tableLength > 0, r.name, "Empty path table");
    for (const [o, little, optional] of [
      [140, true, false],
      [144, true, true],
      [148, false, false],
      [152, false, true],
    ] as const) {
      const start = little
        ? r.u32(`pathTable${o}`, o)
        : r.be32(`pathTable${o}`, o);
      if (start !== undefined) {
        reader.check(
          optional || start > 0,
          r.name,
          "Missing required path table",
        );
        if (start !== 0)
          reader.extent(
            start * SECTOR,
            tableLength === undefined
              ? undefined
              : Math.ceil(tableLength / SECTOR) * SECTOR,
            `${r.name}.pathTable${o}`,
            volume === undefined ? undefined : volume * SECTOR,
          );
      }
    }
    descriptors.push({ record: r, joliet: type === 2, volume });
  }
  if (!established) {
    if (gap) reader.dependent("ISO.presence", ["ISO.discovery"]);
    return;
  }
  reader.check(
    terminated,
    "ISO.sequence",
    "ISO terminator is not identifiable within descriptor bound",
    reader.sectors >= 272 ? "work_bound" : "unsupported_layout",
  );
  reader.check(
    primary === 1 || gap,
    "ISO.sequence",
    "Complete ISO sequence has no primary descriptor",
  );
  if (primary === 1) reader.bootstrap = true;
  for (const { record, joliet, volume } of descriptors) {
    const view: FilesystemView = {
      name: record.name,
      complete: true,
      files: new Map(),
      prerequisites: [],
    };
    reader.views.push(view);
    const root = entry(reader, record, 156, joliet, volume);
    if (root) {
      reader.check(root.name === ".", record.name, "Invalid root identifier");
      await directory(reader, view, root, root, joliet, volume, false);
    } else {
      reader.check(
        record.buffer[156] !== 0 ||
          reader.intersections(record.start + 156, 1).length > 0,
        `${record.name}.root`,
        "Missing readable ISO root record",
      );
      view.complete = false;
      view.prerequisites.push(`${record.name}.root`);
      reader.dependent(`${record.name}.root`, [
        `${record.name}.record@156.length`,
      ]);
    }
  }
}
