import {
  ProfileReader,
  ProfileRecord,
  SECTOR,
  fileMappings,
  fileRecord,
  fileAddress,
  type FileClaim,
  type FilesystemView,
} from "./dvd-metadata-profile-reader.js";
export function reconcileFiles(reader: ProfileReader) {
  for (const left of reader.views)
    for (const right of reader.views) {
      if (left === right) continue;
      for (const [path, file] of left.files) {
        const other = right.files.get(path);
        if (!other) {
          reader.check(
            !right.complete,
            path,
            "Complete peer inventory proves this file absent",
          );
          continue;
        }
        for (const a of fileMappings(file))
          for (const b of fileMappings(other)) {
            const offset = Math.max(a.offset, b.offset),
              end = Math.min(a.offset + a.bytes, b.offset + b.bytes);
            if (offset < end)
              reader.compare(
                `${path}.physicalMapping@${offset}`,
                a.start + offset - a.offset,
                b.start + offset - b.offset,
                [...file.prerequisites, ...other.prerequisites],
              );
          }
        reader.compare(`${path}.fileLength`, file.bytes, other.bytes, [
          ...file.prerequisites,
          ...other.prerequisites,
        ]);
      }
    }
}
interface Domain {
  name: string;
  start?: number;
  sectors?: number;
  files: FileClaim[];
  mappings: { offset: number; start: number; bytes: number }[];
  prerequisites: string[];
}
interface MapClaim {
  name: string;
  count: number;
  entries: Map<number, number>;
}
function domain(
  reader: ProfileReader,
  view: FilesystemView,
  prefix: string,
  title: boolean,
): Domain {
  const files = [...view.files.values()]
    .filter((f) =>
      title
        ? new RegExp(`^${prefix}_[1-9]\\.VOB$`).test(f.path)
        : f.path === `${prefix}.VOB`,
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  let sectors = 0,
    end: number | undefined,
    complete = view.complete,
    offsetKnown = true;
  const mappings: Domain["mappings"] = [];
  let previousSuffix = 0;
  for (const [i, file] of files.entries()) {
    if (title && view.complete)
      reader.check(
        file.path === `${prefix}_${i + 1}.VOB`,
        file.path,
        "Nonconsecutive title VOB chunks",
      );
    const suffix = title ? Number(file.path.slice(-5, -4)) : 0;
    if (title && suffix !== previousSuffix + 1) offsetKnown = false;
    if (
      end !== undefined &&
      file.start !== undefined &&
      (!title || suffix === previousSuffix + 1)
    )
      reader.check(
        end === file.start,
        file.path,
        "Noncontiguous VOB chunks",
        "unsupported_layout",
      );
    if (offsetKnown)
      for (const m of fileMappings(file))
        mappings.push({
          offset: sectors * SECTOR + m.offset,
          start: m.start,
          bytes: m.bytes,
        });
    previousSuffix = suffix;
    end =
      file.start !== undefined && file.bytes !== undefined
        ? file.start + file.bytes
        : undefined;
    if (file.bytes === undefined) {
      complete = false;
      offsetKnown = false;
    } else sectors += file.bytes / SECTOR;
  }
  const first = files[0];
  // A known _1 prefix remains a seed when total inventory is unknown.
  const start =
    title && first?.path !== `${prefix}_1.VOB` ? undefined : first?.start;
  return {
    name: `${prefix}.${title ? "title" : "menu"}`,
    start,
    sectors: complete ? sectors : undefined,
    files,
    mappings,
    prerequisites: [
      ...view.prerequisites,
      ...files.flatMap((f) => f.prerequisites),
    ],
  };
}
async function map(
  reader: ProfileReader,
  file: FileClaim,
  pointer: number | undefined,
  d: Domain,
  suffix: string,
): Promise<MapClaim | undefined> {
  const name = `${file.path}.${suffix}`;
  if (pointer === undefined) {
    reader.dependent(name, [`${file.path}.${suffix}Pointer`]);
    return;
  }
  if (pointer === 0) {
    reader.check(d.files.length === 0, name, "Present VOB has no VOBU map");
    return;
  }
  if (file.bytes === undefined) {
    reader.dependent(name, file.prerequisites);
    return;
  }
  reader.check(
    pointer * SECTOR + 4 <= file.bytes,
    name,
    "Map pointer exceeds control file",
  );
  const header = await fileRecord(reader, file, pointer * SECTOR, 4, name);
  if (!header) return;
  const last = header.be32("last_byte", 0);
  if (last === undefined) {
    reader.dependent(`${name}.entries`, [`${name}.last_byte`]);
    return;
  }
  const length = last + 1,
    count = length / 4 - 1;
  reader.check(
    length >= 8 && length % 4 === 0 && pointer * SECTOR + length <= file.bytes,
    name,
    "Invalid VOBU map length",
  );
  reader.check(count < 100000, name, "Map entry limit reached", "work_bound");
  if (d.sectors !== undefined)
    reader.check(
      count <= d.sectors,
      name,
      "Map has more entries than domain sectors",
    );
  const entries = new Map<number, number>();
  let prior: [number, number] | undefined;
  for (let offset = 4; offset < length; ) {
    const bytes = Math.min(length - offset, SECTOR - (offset % SECTOR));
    const r = await fileRecord(
      reader,
      file,
      pointer * SECTOR + offset,
      bytes,
      name,
    );
    if (!r) {
      offset += bytes;
      continue;
    }
    for (let at = 0; at < bytes; at += 4) {
      const index = (offset + at) / 4 - 1,
        value = r.be32(`entry${index}`, at);
      if (value === undefined) continue;
      reader.check(
        value >= index && (index !== 0 || value === 0),
        `${name}.entry${index}`,
        "Map entry leaves no room for preceding entries",
      );
      if (d.sectors !== undefined)
        reader.check(
          value + count - index <= d.sectors,
          name,
          "Map entry exceeds domain or leaves no room for later entries",
        );
      if (prior)
        reader.check(
          value - prior[1] >= index - prior[0],
          name,
          "Map entries cannot be strictly increasing across source gap",
        );
      entries.set(index, value);
      prior = [index, value];
    }
    offset += bytes;
  }
  return { name, count, entries };
}
function compareMaps(
  reader: ProfileReader,
  a: MapClaim | undefined,
  b: MapClaim | undefined,
) {
  if (!a || !b) return;
  reader.compare(`${a.name}.BUP.count`, a.count, b.count, [
    `${a.name}.last_byte`,
    `${b.name}.last_byte`,
  ]);
  for (const [i, value] of a.entries)
    if (b.entries.has(i))
      reader.compare(`${a.name}.BUP.entry${i}`, value, b.entries.get(i), [
        `${a.name}.entry${i}`,
        `${b.name}.entry${i}`,
      ]);
}
function mergedMap(
  a: MapClaim | undefined,
  b: MapClaim | undefined,
): MapClaim | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    name: a.name,
    count: a.count,
    entries: new Map([...a.entries, ...b.entries]),
  };
}
async function nav(
  reader: ProfileReader,
  d: Domain,
  maps: (MapClaim | undefined)[],
  inspected: Map<number, { domain: string; offset: number }>,
) {
  const seeds = new Map<number, { next?: number; final?: boolean }[]>();
  if (d.start !== undefined && d.files.length) seeds.set(0, []);
  for (const m of maps)
    if (m)
      for (const [i, offset] of m.entries) {
        const claims = seeds.get(offset) ?? [];
        claims.push({ next: m.entries.get(i + 1), final: i === m.count - 1 });
        seeds.set(offset, claims);
      }
  if (d.start === undefined && d.files.length)
    reader.dependent(`${d.name}.NAV.start`, d.prerequisites);
  for (const [offset, claims] of seeds) {
    const name = `${d.name}.NAV@${offset}`;
    const address = fileAddress(
      { path: d.name, prerequisites: d.prerequisites, mappings: d.mappings },
      offset * SECTOR,
      SECTOR,
    );
    if (address === undefined) {
      reader.dependent(name, d.prerequisites);
      continue;
    }
    const lba = address / SECTOR;
    reader.extent(lba * SECTOR, SECTOR, name);
    const prior = inspected.get(lba);
    // Reuse bytes but apply domain-specific comparisons for each view/map.
    if (!prior) {
      reader.count("NAV sectors", 1, 250000);
      inspected.set(lba, { domain: d.name, offset });
    }
    let buffer = reader.navBuffers.get(lba);
    if (!buffer) {
      buffer = (await reader.record(lba * SECTOR, SECTOR, name)).buffer;
      reader.navBuffers.set(lba, buffer);
    }
    const r = new ProfileRecord(reader, buffer, lba * SECTOR, name);
    r.expect(r.be32("packStart", 0), 0x1ba, "packStart");
    r.expect(r.be32("PCI.start", 38), 0x1bf, "PCI.start");
    r.expect(r.be16("PCI.length", 42), 0x3d4, "PCI.length");
    r.expect(r.u8("PCI.substream", 44), 0, "PCI.substream");
    r.expect(r.be32("DSI.start", 1024), 0x1bf, "DSI.start");
    r.expect(r.be16("DSI.length", 1028), 0x3fa, "DSI.length");
    r.expect(r.u8("DSI.substream", 1030), 1, "DSI.substream");
    r.expect(r.be32("PCI.nv_pck_lbn", 45), offset, "PCI.nv_pck_lbn");
    r.expect(r.be32("DSI.nv_pck_lbn", 1035), offset, "DSI.nv_pck_lbn");
    const end = r.be32("vobu_ea", 1039);
    if (end !== undefined) {
      reader.extent(lba * SECTOR, (end + 1) * SECTOR, `${name}.vobu_ea`);
      if (d.sectors !== undefined)
        reader.check(
          offset + end < d.sectors,
          `${name}.vobu_ea`,
          "VOBU end exceeds domain",
        );
      else reader.dependent(`${name}.domainEnd`, d.prerequisites);
      for (const claim of claims) {
        if (claim.next !== undefined)
          reader.check(
            offset + end + 1 === claim.next,
            name,
            "VOBU end disagrees with next consecutive map slot",
          );
        if (claim.final && d.sectors !== undefined)
          reader.check(
            offset + end + 1 === d.sectors,
            name,
            "Final VOBU does not end at domain boundary",
          );
      }
    }
    for (const o of [1043, 1047, 1051]) {
      const ref = r.be32(`referenceEnd${o}`, o);
      if (ref !== undefined && ref !== 0 && end !== undefined)
        reader.check(ref <= end, name, "Reference-image end exceeds VOBU end");
    }
    const vob = r.be16("vobId", 1055),
      cell = r.u8("cellId", 1058);
    if (vob !== undefined) reader.check(vob !== 0, name, "Zero VOB ID");
    if (cell !== undefined) reader.check(cell !== 0, name, "Zero cell ID");
    r.expect(r.u8("reserved", 1057), 0, "reserved");
  }
}
export async function inspectDvdProfile(reader: ProfileReader) {
  const inspected = new Map<number, { domain: string; offset: number }>();
  for (const view of reader.views) {
    reader.currentView = view.name;
    const sets = new Set<string>(["VIDEO_TS/VIDEO_TS"]);
    for (const path of view.files.keys()) {
      const match = /^(VIDEO_TS\/VTS_\d\d)_/.exec(path);
      if (match) sets.add(match[1]!);
    }
    const titleNumbers = [...sets]
      .filter((s) => s !== "VIDEO_TS/VIDEO_TS")
      .map((s) => Number(s.slice(-2)))
      .sort((a, b) => a - b);
    for (const prefix of sets) {
      const manager = prefix === "VIDEO_TS/VIDEO_TS",
        control = manager ? prefix : `${prefix}_0`;
      const menu = domain(reader, view, control, false),
        title = manager ? undefined : domain(reader, view, prefix, true);
      const pair = [
        view.files.get(`${control}.IFO`),
        view.files.get(`${control}.BUP`),
      ];
      if (view.complete)
        reader.check(
          pair.every(Boolean),
          control,
          "Complete inventory is missing required IFO/BUP pair",
        );
      const headerValues: (
        | Record<string, number | string | undefined>
        | undefined
      )[] = [];
      const menuMaps: (MapClaim | undefined)[] = [],
        titleMaps: (MapClaim | undefined)[] = [];
      for (const file of pair) {
        if (!file || file.start === undefined) {
          headerValues.push(undefined);
          menuMaps.push(undefined);
          titleMaps.push(undefined);
          reader.dependent(
            `${control}.controlHeader`,
            file?.prerequisites ?? view.prerequisites,
          );
          continue;
        }
        if (file.bytes !== undefined) {
          reader.check(
            file.bytes < 16 * 1024 * 1024,
            file.path,
            "IFO/BUP file work limit reached",
            "work_bound",
          );
          reader.count("controlBytes", file.bytes, 128 * 1024 * 1024);
        }
        const r = await fileRecord(reader, file, 0, SECTOR, file.path);
        if (!r) {
          headerValues.push(undefined);
          menuMaps.push(undefined);
          titleMaps.push(undefined);
          continue;
        }
        const values = {
          identifier: r.text("identifier", 0, 12),
          domainLastSector: r.be32("domainLastSector", 0xc),
          informationLastSector: r.be32("informationLastSector", 0x1c),
          matLastByte: r.be32("matLastByte", 0x80),
          menuStart: r.be32("menuStart", 0xc0),
          titleStart: manager ? undefined : r.be32("titleStart", 0xc4),
          menuMapPointer: r.be32("menuMapPointer", 0xdc),
          titleMapPointer: manager
            ? undefined
            : r.be32("titleMapPointer", 0xe4),
          titleSetCount: manager ? r.be16("titleSetCount", 0x3e) : undefined,
        };
        r.expect(
          values.identifier,
          manager ? "DVDVIDEO-VMG" : "DVDVIDEO-VTS",
          "identifier",
        );
        if (
          values.informationLastSector !== undefined &&
          file.bytes !== undefined
        )
          reader.check(
            (values.informationLastSector + 1) * SECTOR === file.bytes,
            file.path,
            "Information end disagrees with file length",
          );
        if (values.matLastByte !== undefined) {
          reader.check(
            values.matLastByte >= (manager ? 0xdf : 0xe7),
            file.path,
            "MAT end does not cover required fields",
          );
          if (values.informationLastSector !== undefined)
            reader.check(
              values.matLastByte < (values.informationLastSector + 1) * SECTOR,
              file.path,
              "MAT exceeds information end",
            );
          if (file.bytes !== undefined)
            reader.check(
              values.matLastByte < file.bytes,
              file.path,
              "MAT exceeds control file",
            );
        }
        if (values.titleSetCount !== undefined) {
          reader.check(
            values.titleSetCount >= 1 &&
              values.titleSetCount <= 99 &&
              titleNumbers.every((n) => n <= values.titleSetCount!),
            file.path,
            "Invalid VMG title-set count",
          );
          if (view.complete)
            reader.check(
              titleNumbers.length === values.titleSetCount &&
                titleNumbers.every((n, i) => n === i + 1),
              file.path,
              "VMG count disagrees with complete title-set inventory",
            );
        }
        const base = pair[0]?.start;
        const related = manager
          ? pair.filter((f): f is FileClaim => !!f).concat(menu.files)
          : [
              ...pair.filter((f): f is FileClaim => !!f),
              ...menu.files,
              ...title!.files,
            ];
        if (values.domainLastSector !== undefined && base !== undefined) {
          const end = base + (values.domainLastSector + 1) * SECTOR;
          reader.extent(base, end - base, `${file.path}.domainEnd`);
          for (const f of related)
            if (f.start !== undefined && f.bytes !== undefined)
              reader.check(
                f.start >= base && f.start + f.bytes <= end,
                file.path,
                "Domain end does not contain related file",
              );
          if (
            view.complete &&
            related.every((f) => f.start !== undefined && f.bytes !== undefined)
          )
            reader.check(
              end === Math.max(...related.map((f) => f.start! + f.bytes!)),
              file.path,
              "Domain end disagrees with complete file inventory",
            );
        } else
          reader.dependent(`${file.path}.domainEnd`, [
            `${file.path}.domainLastSector`,
            `${control}.IFO.location`,
          ]);
        for (const [start, d, label] of [
          [values.menuStart, menu, "menuStart"],
          [values.titleStart, title, "titleStart"],
        ] as const)
          if (d && start !== undefined) {
            if (start === 0)
              reader.check(
                d.files.length === 0,
                `${file.path}.${label}`,
                "Zero VOB start contradicts known VOB",
              );
            else {
              if (base !== undefined) {
                reader.extent(
                  base + start * SECTOR,
                  SECTOR,
                  `${file.path}.${label}`,
                );
                if (d.start !== undefined)
                  reader.check(
                    base + start * SECTOR === d.start,
                    file.path,
                    "Control VOB start disagrees with filesystem location",
                  );
              }
              if (view.complete)
                reader.check(
                  d.files.length > 0,
                  file.path,
                  "VOB start contradicts proven absence",
                );
            }
          }
        menuMaps.push(
          await map(reader, file, values.menuMapPointer, menu, "menuMap"),
        );
        titleMaps.push(
          title
            ? await map(reader, file, values.titleMapPointer, title, "titleMap")
            : undefined,
        );
        headerValues.push(values);
      }
      if (headerValues[0] && headerValues[1])
        for (const key of Object.keys(headerValues[0]))
          if (
            headerValues[0][key] !== undefined ||
            headerValues[1][key] !== undefined
          )
            reader.compare(
              `${control}.IFO/BUP.${key}`,
              headerValues[0][key],
              headerValues[1][key],
              [`${control}.IFO.${key}`, `${control}.BUP.${key}`],
            );
      compareMaps(reader, menuMaps[0], menuMaps[1]);
      compareMaps(reader, titleMaps[0], titleMaps[1]);
      await nav(reader, menu, [mergedMap(menuMaps[0], menuMaps[1])], inspected);
      if (title)
        await nav(
          reader,
          title,
          [mergedMap(titleMaps[0], titleMaps[1])],
          inspected,
        );
    }
  }
}
