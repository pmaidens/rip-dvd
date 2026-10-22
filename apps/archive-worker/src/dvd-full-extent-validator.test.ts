import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createNodeDvdFullExtentMetadataValidator,
  structuralEvidenceObservations,
} from "./dvd-full-extent-validator.js";
import { isoProfileImage } from "./dvd-metadata-profile-fixtures.js";
import type { MetadataObservation } from "./dvd-metadata-profile-reader.js";
import type { DvdUnrecoveredSourceRange } from "@rip-dvd/data-access";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
export async function validate(
  image: Buffer,
  ranges: DvdUnrecoveredSourceRange[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), "dvd-profile-"));
  directories.push(directory);
  const imagePath = join(directory, "image.iso");
  await writeFile(imagePath, image);
  return createNodeDvdFullExtentMetadataValidator().validate({
    imagePath,
    expectedByteCount: image.length,
    signal: new AbortController().signal,
    unrecoveredSourceRanges: ranges,
  });
}
it("includes prerequisite phase evidence in later structural checks", () => {
  const observations: MetadataObservation[] = [
    {
      field: "filesystem",
      checkKind: "filesystem_structure",
      status: "known",
      dependencies: [{ startLba: 1, sectorCount: 1 }],
    },
    {
      field: "titles",
      checkKind: "title_enumeration",
      status: "known",
      dependencies: [{ startLba: 10, sectorCount: 1 }],
    },
    {
      field: "navigation",
      checkKind: "dvd_navigation",
      status: "known",
      dependencies: [{ startLba: 20, sectorCount: 1 }],
    },
  ];

  expect(
    structuralEvidenceObservations(observations, "title_enumeration").map(
      ({ field }) => field,
    ),
  ).toEqual(["filesystem", "titles"]);
  expect(
    structuralEvidenceObservations(observations, "dvd_navigation").map(
      ({ field }) => field,
    ),
  ).toEqual(["filesystem", "titles", "navigation"]);
});
it("publishes with a source-unavailable IFO and independently valid title NAV", async () => {
  const result = await validate(isoProfileImage(), [
    { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
  ]);
  expect(result.decision).toBe("publishable");
  expect(result.impact).toBe("unknown");
  expect(result.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: expect.stringContaining("VTS_01_0.IFO.identifier"),
        status: "source_unavailable",
        sourceRanges: [
          { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
        ],
      }),
    ]),
  );
});
it.each([0, 45, 1039])(
  "blocks a readable title NAV contradiction at byte %i after an IFO gap",
  async (offset) => {
    const image = isoProfileImage();
    image.writeUInt32BE(0xffffffff, 40 * 2048 + offset);
    const result = await validate(image, [
      { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
    ]);
    expect(result.decision).toBe("blocked");
    expect(result.blockers.some((item) => item.field.includes("NAV"))).toBe(
      true,
    );
  },
);
it.each([false, true])(
  "publishes supported physical UDF with bridge=%s",
  async (bridge) => {
    const { udfProfileImage } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const result = await validate(udfProfileImage(bridge));
    expect(result.blockers).toEqual([]);
    expect(result.decision).toBe("publishable");
    expect(
      result.observations.some(
        (o) => o.field.includes("UDF") && o.field.endsWith("blockSize"),
      ),
    ).toBe(true);
  },
);
it("publishes clean ISO without applying unlisted DVD semantics", async () => {
  const image = isoProfileImage();
  image.fill(0xff, 32 * 2048 + 0x100, 32 * 2048 + 0x200);
  const result = await validate(image);
  expect(result.blockers).toEqual([]);
  expect(result.impact).toBe("listed_checks_agree");
});
it.each([257, 273])(
  "keeps a later readable UDF contradiction after a gap in sequence %i",
  async (base) => {
    const { udfProfileImage, udfTag } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const image = udfProfileImage(true);
    const p = image.subarray((base + 1) * 2048, (base + 2) * 2048);
    p.writeUInt32LE(9999, 192);
    udfTag(p, 5, base + 1);
    const result = await validate(image, [
      { startLba: base, sectorCount: 1, classification: "individually_failed" },
    ]);
    expect(result.decision).toBe("blocked");
    expect(result.blockers[0]?.field).toContain(`sequence@${base}`);
  },
);
it("checks a readable ISO descriptor after an unavailable first slot with a healthy UDF peer", async () => {
  const { udfProfileImage, both32 } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = udfProfileImage(true);
  image.copy(image, 17 * 2048, 16 * 2048, 17 * 2048);
  both32(image.subarray(17 * 2048), 80, 9999);
  const result = await validate(image, [
    { startLba: 16, sectorCount: 1, classification: "skipped_untested" },
  ]);
  expect(result.decision).toBe("blocked");
  expect(result.blockers[0]?.field).toContain("ISO.slot17");
});
it.each([257, 273])(
  "retains exact dependencies for an unavailable UDF mirror PVD at %i",
  async (base) => {
    const { udfProfileImage } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const range = {
      startLba: base,
      sectorCount: 1,
      classification: "individually_failed" as const,
    };
    const result = await validate(udfProfileImage(), [range]);
    expect(result.blockers).toEqual([]);
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "source_unavailable",
          sourceRanges: [range],
        }),
        expect.objectContaining({
          status: "dependent_unknown",
          prerequisites: expect.arrayContaining([
            `UDF.sequence@${base}.slot0.tag.identifier`,
          ]),
        }),
      ]),
    );
  },
);
it.each([false, true])(
  "does not let a partial inventory erase a complete peer's file mapping, partial ISO=%s",
  async (isoPartial) => {
    const { udfProfileImage, udfTag, both32 } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const image = udfProfileImage(true);
    // Keep a complete inventory in one view and a partial inventory in another.
    if (isoPartial) {
      image.writeUInt32LE(411 - 300, 314 * 2048 + 180);
      udfTag(image.subarray(314 * 2048, 315 * 2048), 261, 14, 168);
    } else {
      const v = image.subarray(22 * 2048);
      let p = 0;
      while (v[p]) {
        if (v.readUInt32LE(p + 2) === 410) both32(v, p + 2, 411);
        p += v[p]!;
      }
    }
    // The partial branch still knows the title VOB record in the following block.
    if (isoPartial) {
      const { isoRecord } = await import("./dvd-metadata-profile-fixtures.js");
      // Root records have lengths 34,34,42. VIDEO_TS is at offset 68.
      both32(image.subarray(21 * 2048), 68 + 10, 4096);
      isoRecord(410, 4 * 2048, "VTS_01_1.VOB;1").copy(image, 23 * 2048);
    }
    const ranges = [
      {
        startLba: isoPartial ? 22 : 310,
        sectorCount: 1,
        classification: "skipped_untested" as const,
      },
    ];
    const result = await validate(image, ranges);
    expect(result.decision).toBe("blocked");
    expect(result.blockers[0]?.field).toContain("physicalMapping");
  },
);
it("continues a known later directory block after a source gap", async () => {
  const { both32, isoRecord } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = isoProfileImage();
  both32(image.subarray(21 * 2048), 68 + 10, 4096);
  Buffer.concat([
    isoRecord(32, 4096, "VTS_01_0.IFO;1"),
    isoRecord(34, 4096, "VTS_01_0.BUP;1"),
    isoRecord(40, 8192, "VTS_01_1.VOB;1"),
  ]).copy(image, 23 * 2048);
  image.writeUInt32BE(99, 40 * 2048 + 45);
  const result = await validate(image, [
    { startLba: 22, sectorCount: 1, classification: "skipped_untested" },
  ]);
  expect(result.decision).toBe("blocked");
  expect(result.blockers[0]?.field).toContain("NAV");
});
it.each([
  [
    "overlap",
    [
      { startLba: 32, sectorCount: 2, classification: "skipped_untested" },
      { startLba: 33, sectorCount: 1, classification: "individually_failed" },
    ],
  ],
  [
    "adjacent equal classes",
    [
      { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
      { startLba: 33, sectorCount: 1, classification: "skipped_untested" },
    ],
  ],
  [
    "outside image",
    [{ startLba: 64, sectorCount: 1, classification: "individually_failed" }],
  ],
] as const)(
  "rejects noncanonical source intervals: %s",
  async (_name, ranges) => {
    expect(
      (await validate(isoProfileImage(), [...ranges])).blockers[0]?.field,
    ).toBe("sourceRanges");
  },
);
it("preserves mixed adjacent source classifications", async () => {
  const ranges = [
    {
      startLba: 32,
      sectorCount: 1,
      classification: "skipped_untested" as const,
    },
    {
      startLba: 33,
      sectorCount: 1,
      classification: "individually_failed" as const,
    },
  ];
  const result = await validate(isoProfileImage(), ranges);
  expect(result.blockers).toEqual([]);
  expect(result.observations.flatMap((o) => o.sourceRanges ?? [])).toEqual(
    expect.arrayContaining(ranges),
  );
});
it("blocks complete loss of bootstrap declarations even when source-explained", async () => {
  const result = await validate(isoProfileImage(), [
    { startLba: 16, sectorCount: 32, classification: "skipped_untested" },
  ]);
  expect(result.decision).toBe("blocked");
});
it("blocks an unexplained zero-filled IFO outside the map", async () => {
  const image = isoProfileImage();
  image.fill(0, 32 * 2048, 33 * 2048);
  expect((await validate(image)).blockers[0]?.field).toContain("identifier");
});
it("blocks an invalid readable UDF checksum", async () => {
  const { udfProfileImage } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = udfProfileImage();
  image[257 * 2048 + 4] ^= 1;
  expect((await validate(image)).blockers[0]?.field).toContain("checksum");
});
it("blocks unsupported UDF allocation", async () => {
  const { udfProfileImage, udfTag } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = udfProfileImage();
  image.writeUInt16LE(3, 310 * 2048 + 34);
  udfTag(image.subarray(310 * 2048, 311 * 2048), 261, 10, 168);
  expect((await validate(image)).blockers[0]?.reason).toBe(
    "unsupported_layout",
  );
});
it("stops at the ISO descriptor work bound without scanning for a terminator", async () => {
  const image = Buffer.alloc(300 * 2048);
  for (let lba = 16; lba < 272; lba++) {
    image.write("CD001", lba * 2048 + 1);
    image[lba * 2048 + 6] = 1;
  }
  expect((await validate(image)).blockers[0]?.reason).toBe("work_bound");
});
it.each([
  ["endian disagreement", 16, 84, 63],
  ["volume set", 16, 120, 2],
  ["volume sequence", 16, 124, 2],
  ["block size", 16, 128, 1024],
  ["empty path table", 16, 132, 0],
  ["required L table", 16, 140, 0],
  ["table exceeds volume", 16, 140, 64],
] as const)("blocks ISO %s", async (_name, lba, offset, value) => {
  const { both16, both32 } = await import("./dvd-metadata-profile-fixtures.js");
  const image = isoProfileImage();
  const r = image.subarray(lba * 2048);
  if ([120, 124, 128].includes(offset)) both16(r, offset, value);
  else if (offset === 132) both32(r, offset, value);
  else if (offset === 84) r.writeUInt32BE(value, offset);
  else r.writeUInt32LE(value, offset);
  expect((await validate(image)).decision).toBe("blocked");
});
it("blocks a readable missing root even with a supported peer view", async () => {
  const { udfProfileImage } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = udfProfileImage(true);
  image[16 * 2048 + 156] = 0;
  expect((await validate(image)).blockers[0]?.field).toContain("root");
});
it.each([0xc, 0x1c, 0x80, 0xc4, 0xe4])(
  "blocks a readable IFO address/header contradiction at %i",
  async (offset) => {
    const image = isoProfileImage();
    image.writeUInt32BE(99999, 32 * 2048 + offset);
    expect((await validate(image)).decision).toBe("blocked");
  },
);
it.each([
  38, 42, 44, 1024, 1028, 1030, 1035, 1043, 1047, 1051, 1055, 1057, 1058,
])("checks the listed NAV field at %i independently", async (offset) => {
  const image = isoProfileImage();
  if ([1055, 1058].includes(offset)) {
    image[40 * 2048 + offset] = 0;
    image[40 * 2048 + offset + 1] = 0;
  } else image[40 * 2048 + offset] = 0xff;
  expect(
    (
      await validate(image, [
        { startLba: 32, sectorCount: 1, classification: "skipped_untested" },
      ])
    ).blockers[0]?.field,
  ).toContain("NAV");
});
it.each([
  ["tag version", 257, 2, 3, 2, 1, 496],
  ["tag location", 257, 12, 0, 4, 1, 496],
  ["abstract extent", 257, 328, 9999999, 4, 1, 496],
  ["partition flags", 258, 20, 0, 2, 5, 496],
  ["partition access", 258, 184, 2, 4, 5, 496],
  ["partition header", 258, 56, 0x40000001, 4, 5, 496],
  ["logical block size", 259, 212, 1024, 4, 6, 430],
  ["domain revision", 259, 240, 0x200, 2, 6, 430],
  ["map count", 259, 268, 17, 4, 6, 430],
  ["map type", 259, 440, 2, 1, 6, 430],
  ["FSD next ICB", 300, 448, 1, 4, 256, 496],
  ["FE type", 310, 27, 4, 1, 261, 168],
  ["FE recorded blocks", 310, 64, 2, 4, 261, 168],
  ["FE external attribute", 310, 112, 1, 4, 261, 168],
  ["FE inline attribute", 310, 168, 4, 4, 261, 168],
] as const)(
  "checks UDF %s",
  async (_name, lba, offset, value, width, id, crcLength) => {
    const { udfProfileImage, udfTag } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const image = udfProfileImage();
    const b = image.subarray(lba * 2048, (lba + 1) * 2048);
    if (width === 1) b[offset] = value;
    else if (width === 2) b.writeUInt16LE(value, offset);
    else b.writeUInt32LE(value, offset);
    udfTag(b, id, lba >= 300 ? lba - 300 : lba, crcLength);
    // Refreshing a tag sets its version/location. Those two cases change the expected field afterward.
    if (offset === 2 || offset === 12) {
      if (width === 2) b.writeUInt16LE(value, offset);
      else b.writeUInt32LE(value, offset);
      b[4] = b
        .subarray(0, 16)
        .reduce((sum, v, i) => (i === 4 ? sum : (sum + v) & 255), 0);
    }
    expect((await validate(image)).decision).toBe("blocked");
  },
);
it("checks readable VOBU map entries across a source gap without guessing NAV seeds", async () => {
  const { both32, isoRecord, navPack } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const original = isoProfileImage();
  const image = Buffer.alloc(1280 * 2048);
  original.copy(image);
  both32(image.subarray(16 * 2048), 80, 1280);
  const v = image.subarray(22 * 2048, 23 * 2048);
  v.fill(0);
  Buffer.concat([
    isoRecord(22, 2048, 0, true),
    isoRecord(21, 2048, 1, true),
    isoRecord(30, 2048, "VIDEO_TS.IFO;1"),
    isoRecord(31, 2048, "VIDEO_TS.BUP;1"),
    isoRecord(32, 8192, "VTS_01_0.IFO;1"),
    isoRecord(36, 8192, "VTS_01_0.BUP;1"),
    isoRecord(100, 1100 * 2048, "VTS_01_1.VOB;1"),
  ]).copy(v);
  original.copy(image, 36 * 2048, 34 * 2048, 35 * 2048);
  for (const lba of [32, 36]) {
    image.writeUInt32BE(1167, lba * 2048 + 0xc);
    image.writeUInt32BE(3, lba * 2048 + 0x1c);
    image.writeUInt32BE(68, lba * 2048 + 0xc4);
    image.writeUInt32BE(4103, (lba + 1) * 2048);
    for (let i = 0; i < 1025; i++)
      image.writeUInt32BE(i, (lba + 1) * 2048 + 4 + i * 4);
  }
  for (let i = 0; i < 1025; i++) {
    const nav = navPack(i === 1024 ? 75 : 0);
    nav.writeUInt32BE(i, 45);
    nav.writeUInt32BE(i, 1035);
    nav.copy(image, (100 + i) * 2048);
  }
  const ranges = [
    {
      startLba: 34,
      sectorCount: 1,
      classification: "skipped_untested" as const,
    },
    {
      startLba: 38,
      sectorCount: 1,
      classification: "individually_failed" as const,
    },
  ];
  const valid = await validate(image, ranges);
  expect(valid.blockers).toEqual([]);
  expect(valid.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "VIDEO_TS/VTS_01_0.IFO.titleMap.entry511",
        status: "source_unavailable",
        sourceRanges: [ranges[0]],
      }),
    ]),
  );
  image.writeUInt32BE(510, 35 * 2048);
  expect((await validate(image, ranges)).decision).toBe("blocked");
});
it("accepts a compact source interval longer than the legacy sector cap without scanning it", async () => {
  const { open } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "dvd-profile-sparse-"));
  directories.push(dir);
  const imagePath = join(dir, "image.iso");
  await writeFile(imagePath, isoProfileImage());
  const file = await open(imagePath, "r+");
  try {
    await file.truncate(300065 * 2048);
  } finally {
    await file.close();
  }
  const result = await createNodeDvdFullExtentMetadataValidator().validate({
    expectedByteCount: 300065 * 2048,
    imagePath,
    signal: new AbortController().signal,
    unrecoveredSourceRanges: [
      { startLba: 64, sectorCount: 300001, classification: "skipped_untested" },
    ],
  });
  expect(result.blockers).toEqual([]);
  expect(result.observations.length).toBeLessThan(2000);
});
it("blocks exact-size and copy-identity mismatches as local failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dvd-profile-identity-"));
  directories.push(directory);
  const imagePath = join(directory, "image.iso");
  const image = isoProfileImage();
  await writeFile(imagePath, image);
  const request = {
    imagePath,
    expectedByteCount: image.length,
    signal: new AbortController().signal,
    unrecoveredSourceRanges: [],
  };
  expect(
    (
      await createNodeDvdFullExtentMetadataValidator().validate({
        ...request,
        imageFilesystemIdentity: "0:1",
      })
    ).blockers[0]?.reason,
  ).toBe("local_failure");
  expect(
    (
      await createNodeDvdFullExtentMetadataValidator().validate({
        ...request,
        expectedByteCount: image.length + 2048,
      })
    ).blockers[0]?.reason,
  ).toBe("local_failure");
});
it("checks a clean Joliet peer and reconciles its DVD paths with ISO", async () => {
  const { both16, both32, isoRecord } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = isoProfileImage();
  image.copy(image, 18 * 2048, 17 * 2048, 18 * 2048);
  image.copy(image, 17 * 2048, 16 * 2048, 17 * 2048);
  image[17 * 2048] = 2;
  image.write("%/E", 17 * 2048 + 88);
  isoRecord(50, 2048, 0, true).copy(image, 17 * 2048 + 156);
  function jolietRecord(lba: number, bytes: number, name: string) {
    const id = Buffer.from(name, "utf16le").swap16();
    const r = Buffer.alloc(33 + id.length + 1);
    r[0] = r.length;
    both32(r, 2, lba);
    both32(r, 10, bytes);
    both16(r, 28, 1);
    r[32] = id.length;
    id.copy(r, 33);
    return r;
  }
  const video = jolietRecord(51, 2048, "VIDEO_TS");
  video[25] = 2;
  Buffer.concat([
    isoRecord(50, 2048, 0, true),
    isoRecord(50, 2048, 1, true),
    video,
  ]).copy(image, 50 * 2048);
  Buffer.concat([
    isoRecord(51, 2048, 0, true),
    isoRecord(50, 2048, 1, true),
    jolietRecord(30, 2048, "VIDEO_TS.IFO"),
    jolietRecord(31, 2048, "VIDEO_TS.BUP"),
    jolietRecord(32, 4096, "VTS_01_0.IFO"),
    jolietRecord(34, 4096, "VTS_01_0.BUP"),
    jolietRecord(40, 8192, "VTS_01_1.VOB"),
  ]).copy(image, 51 * 2048);
  expect((await validate(image)).blockers).toEqual([]);
  // A readable primary/Joliet disagreement is still blocking after a source gap.
  both32(image.subarray(17 * 2048), 80, 63);
  expect((await validate(image)).decision).toBe("blocked");
});
it.each([
  [8192, 2],
  [4096, 4],
])(
  "checks known allocation lengths and recorded blocks with an unresolved partition: info=%i blocks=%i",
  async (informationBytes, recordedBlocks) => {
    const { udfProfileImage, udfTag } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const image = udfProfileImage();
    for (const lba of [259, 275]) {
      const b = image.subarray(lba * 2048, (lba + 1) * 2048);
      b.writeUInt32LE(12, 264);
      b.writeUInt32LE(2, 268);
      b[446] = 1;
      b[447] = 6;
      b.writeUInt16LE(1, 448);
      b.writeUInt16LE(1, 450);
      udfTag(b, 6, lba, 436);
    }
    const fe = image.subarray(314 * 2048, 315 * 2048);
    fe.fill(0, 176);
    fe.writeUInt16LE(1, 34);
    fe.writeBigUInt64LE(BigInt(informationBytes), 56);
    fe.writeBigUInt64LE(BigInt(recordedBlocks), 64);
    fe.writeUInt32LE(32, 172);
    fe.writeUInt32LE(2048, 176);
    fe.writeUInt32LE(110, 180);
    fe.writeUInt32LE(2048, 192);
    fe.writeUInt16LE(1, 200);
    udfTag(fe, 261, 14, 192);
    for (const lba of [402, 404])
      image.writeUInt32BE(8 + informationBytes / 2048 - 1, lba * 2048 + 0xc);
    const result = await validate(
      image,
      [257, 273, 410].map((startLba) => ({
        startLba,
        sectorCount: 1,
        classification: "skipped_untested",
      })),
    );
    expect(result.decision).toBe("blocked");
    expect(result.blockers[0]?.message).toMatch(
      /Allocation lengths|Recorded blocks/,
    );
  },
);
it("keeps a known menu VOB boundary when another directory block and control headers are unavailable", async () => {
  const { isoRecord, both32, navPack } = await import(
    "./dvd-metadata-profile-fixtures.js"
  );
  const image = isoProfileImage();
  both32(image.subarray(21 * 2048), 68 + 10, 4096);
  Buffer.concat([
    isoRecord(32, 4096, "VTS_01_0.IFO;1"),
    isoRecord(34, 4096, "VTS_01_0.BUP;1"),
    isoRecord(40, 8192, "VTS_01_1.VOB;1"),
    isoRecord(48, 2048, "VTS_01_0.VOB;1"),
  ]).copy(image, 23 * 2048);
  navPack(1).copy(image, 48 * 2048);
  const result = await validate(
    image,
    [22, 32, 34].map((startLba) => ({
      startLba,
      sectorCount: 1,
      classification: "skipped_untested",
    })),
  );
  expect(result.decision).toBe("blocked");
  expect(result.blockers[0]?.field).toContain("menu.NAV");
});
it.each(["ISO", "UDF"])(
  "does not let a %s root gap hide required-file absence in a complete VIDEO_TS directory",
  async (filesystem) => {
    const { isoProfileImage, udfProfileImage, isoRecord, udfTag } =
      await import("./dvd-metadata-profile-fixtures.js");
    const image = filesystem === "ISO" ? isoProfileImage() : udfProfileImage();
    let gap: number;
    if (filesystem === "ISO") {
      isoRecord(50, 4096, 0, true).copy(image, 16 * 2048 + 156);
      Buffer.concat([
        isoRecord(50, 4096, 0, true),
        isoRecord(50, 4096, 1, true),
        isoRecord(22, 2048, "VIDEO_TS", true),
      ]).copy(image, 50 * 2048);
      image.fill(0, 22 * 2048, 23 * 2048);
      Buffer.concat([
        isoRecord(22, 2048, 0, true),
        isoRecord(50, 4096, 1, true),
        isoRecord(30, 2048, "VIDEO_TS.IFO;1"),
        isoRecord(32, 4096, "VTS_01_0.IFO;1"),
        isoRecord(34, 4096, "VTS_01_0.BUP;1"),
        isoRecord(40, 8192, "VTS_01_1.VOB;1"),
      ]).copy(image, 22 * 2048);
      gap = 51;
    } else {
      const root = image.subarray(301 * 2048, 302 * 2048);
      root.writeBigUInt64LE(4096n, 56);
      root.writeBigUInt64LE(2n, 64);
      root.writeUInt32LE(4096, 176);
      root.writeUInt32LE(20, 180);
      udfTag(root, 261, 1, 168);
      const originalRoot = image.subarray(302 * 2048, 303 * 2048);
      let at = 0;
      while (originalRoot.readUInt16LE(at) === 257) {
        const length = Math.ceil((38 + originalRoot[at + 19]!) / 4) * 4;
        const fid = Buffer.from(originalRoot.subarray(at, at + length));
        udfTag(fid, 257, 20, length - 16);
        fid.copy(image, 320 * 2048 + at);
        at += length;
      }
      const originalVideo = Buffer.from(image.subarray(304 * 2048, 305 * 2048));
      const records: Buffer[] = [];
      at = 0;
      while (originalVideo.readUInt16LE(at) === 257) {
        const length = Math.ceil((38 + originalVideo[at + 19]!) / 4) * 4;
        const fid = originalVideo.subarray(at, at + length);
        const name = fid.toString("latin1", 39, 38 + fid[19]!);
        if (name !== "VIDEO_TS.BUP") records.push(fid);
        at += length;
      }
      const video = Buffer.concat(records);
      image.fill(0, 304 * 2048, 305 * 2048);
      video.copy(image, 304 * 2048);
      const fe = image.subarray(303 * 2048, 304 * 2048);
      fe.writeBigUInt64LE(BigInt(video.length), 56);
      udfTag(fe, 261, 3, 168);
      gap = 321;
    }
    const result = await validate(image, [
      { startLba: gap, sectorCount: 1, classification: "skipped_untested" },
    ]);
    expect(result.decision).toBe("blocked");
    expect(result.blockers[0]?.message).toContain("required IFO/BUP");
  },
);
it.each([false, true])(
  "compares IFO/BUP fields from complementary partial views, contradictory BUP=%s",
  async (contradiction) => {
    const { udfProfileImage, isoRecord, both32, udfTag } = await import(
      "./dvd-metadata-profile-fixtures.js"
    );
    const image = udfProfileImage(true);
    both32(image.subarray(21 * 2048), 68 + 10, 4096);
    image.fill(0, 22 * 2048, 24 * 2048);
    Buffer.concat([
      isoRecord(22, 4096, 0, true),
      isoRecord(21, 2048, 1, true),
      isoRecord(400, 2048, "VIDEO_TS.IFO;1"),
      isoRecord(402, 4096, "VTS_01_0.IFO;1"),
      isoRecord(404, 4096, "VTS_01_0.BUP;1"),
      isoRecord(410, 8192, "VTS_01_1.VOB;1"),
    ]).copy(image, 22 * 2048);
    const original = Buffer.from(image.subarray(304 * 2048, 305 * 2048));
    const records: Buffer[] = [];
    let at = 0;
    while (original.readUInt16LE(at) === 257) {
      const length = Math.ceil((38 + original[at + 19]!) / 4) * 4;
      const fid = original.subarray(at, at + length);
      if (fid.toString("latin1", 39, 38 + fid[19]!) !== "VIDEO_TS.IFO")
        records.push(fid);
      at += length;
    }
    image.fill(0, 304 * 2048, 305 * 2048);
    Buffer.concat(records).copy(image, 304 * 2048);
    const fe = image.subarray(303 * 2048, 304 * 2048);
    fe.writeBigUInt64LE(4096n, 56);
    fe.writeBigUInt64LE(2n, 64);
    fe.writeUInt32LE(4096, 176);
    udfTag(fe, 261, 3, 168);
    if (contradiction) image.writeUInt16BE(2, 401 * 2048 + 0x3e);
    const result = await validate(
      image,
      [23, 305].map((startLba) => ({
        startLba,
        sectorCount: 1,
        classification: "skipped_untested",
      })),
    );
    expect(result.decision).toBe(contradiction ? "blocked" : "publishable");
    if (contradiction)
      expect(result.blockers[0]?.field).toContain("titleSetCount");
  },
);
