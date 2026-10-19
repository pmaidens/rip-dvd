const S = 2048;
export function both16(b: Buffer, o: number, n: number) {
  b.writeUInt16LE(n, o);
  b.writeUInt16BE(n, o + 2);
}
export function both32(b: Buffer, o: number, n: number) {
  b.writeUInt32LE(n, o);
  b.writeUInt32BE(n, o + 4);
}
export function isoRecord(
  lba: number,
  bytes: number,
  name: string | number,
  directory = false,
): Buffer {
  const id = typeof name === "number" ? Buffer.from([name]) : Buffer.from(name);
  const b = Buffer.alloc(33 + id.length + (id.length % 2 === 0 ? 1 : 0));
  b[0] = b.length;
  both32(b, 2, lba);
  both32(b, 10, bytes);
  b[25] = directory ? 2 : 0;
  both16(b, 28, 1);
  b[32] = id.length;
  id.copy(b, 33);
  return b;
}
export function navPack(end = 3): Buffer {
  const b = Buffer.alloc(S);
  b.writeUInt32BE(0x1ba, 0);
  b.writeUInt32BE(0x1bf, 38);
  b.writeUInt16BE(0x3d4, 42);
  b.writeUInt32BE(0x1bf, 1024);
  b.writeUInt16BE(0x3fa, 1028);
  b[1030] = 1;
  b.writeUInt32BE(end, 1039);
  b.writeUInt16BE(1, 1055);
  b[1058] = 1;
  return b;
}
export function isoProfileImage(): Buffer {
  const image = Buffer.alloc(64 * S);
  const pvd = image.subarray(16 * S, 17 * S);
  pvd[0] = 1;
  pvd.write("CD001", 1);
  pvd[6] = 1;
  both32(pvd, 80, 64);
  both16(pvd, 120, 1);
  both16(pvd, 124, 1);
  both16(pvd, 128, S);
  both32(pvd, 132, 10);
  pvd.writeUInt32LE(19, 140);
  pvd.writeUInt32BE(20, 148);
  isoRecord(21, S, 0, true).copy(pvd, 156);
  image[17 * S] = 255;
  image.write("CD001", 17 * S + 1);
  image[17 * S + 6] = 1;
  Buffer.concat([
    isoRecord(21, S, 0, true),
    isoRecord(21, S, 1, true),
    isoRecord(22, S, "VIDEO_TS", true),
  ]).copy(image, 21 * S);
  Buffer.concat([
    isoRecord(22, S, 0, true),
    isoRecord(21, S, 1, true),
    isoRecord(30, S, "VIDEO_TS.IFO;1"),
    isoRecord(31, S, "VIDEO_TS.BUP;1"),
    isoRecord(32, 2 * S, "VTS_01_0.IFO;1"),
    isoRecord(34, 2 * S, "VTS_01_0.BUP;1"),
    isoRecord(40, 4 * S, "VTS_01_1.VOB;1"),
  ]).copy(image, 22 * S);
  for (const lba of [30, 31, 32, 34]) {
    const b = image.subarray(lba * S, (lba + 1) * S);
    const manager = lba < 32;
    b.write(manager ? "DVDVIDEO-VMG" : "DVDVIDEO-VTS");
    b.writeUInt32BE(manager ? 1 : 11, 0xc);
    b.writeUInt32BE(manager ? 0 : 1, 0x1c);
    b.writeUInt32BE(0xff, 0x80);
    if (manager) b.writeUInt16BE(1, 0x3e);
    else {
      b.writeUInt32BE(8, 0xc4);
      b.writeUInt32BE(1, 0xe4);
      image.writeUInt32BE(7, (lba + 1) * S);
    }
  }
  navPack().copy(image, 40 * S);
  return image;
}
export function udfTag(b: Buffer, id: number, location: number, length = 496) {
  b.writeUInt16LE(id, 0);
  b.writeUInt16LE(2, 2);
  b.writeUInt16LE(length, 10);
  b.writeUInt32LE(location, 12);
  let crc = 0;
  for (const byte of b.subarray(16, 16 + length)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  b.writeUInt16LE(crc, 8);
  b[4] = b
    .subarray(0, 16)
    .reduce((sum, byte, i) => (i === 4 ? sum : (sum + byte) & 255), 0);
}
export function udfProfileImage(bridge = false): Buffer {
  const image = Buffer.alloc(640 * S),
    iso = isoProfileImage();
  const sector = (lba: number) => image.subarray(lba * S, (lba + 1) * S);
  // The UDF and optional ISO view identify the same five DVD files.
  for (const [from, to, count] of [
    [30, 400, 1],
    [31, 401, 1],
    [32, 402, 2],
    [34, 404, 2],
    [40, 410, 4],
  ])
    iso.copy(image, to! * S, from! * S, (from! + count!) * S);
  if (bridge) {
    iso.copy(image, 16 * S, 16 * S, 23 * S);
    both32(sector(16), 80, 640);
    const video = sector(22);
    let at = 0;
    while (video[at]) {
      const old = video.readUInt32LE(at + 2);
      const lba = new Map([
        [30, 400],
        [31, 401],
        [32, 402],
        [34, 404],
        [40, 410],
      ]).get(old);
      if (lba !== undefined) both32(video, at + 2, lba);
      at += video[at]!;
    }
  }
  for (const [i, name] of ["BEA01", "NSR02", "TEA01"].entries()) {
    const b = sector(24 + i);
    b.write(name, 1);
    b[6] = 1;
  }
  const anchor = sector(256);
  anchor.writeUInt32LE(4 * S, 16);
  anchor.writeUInt32LE(257, 20);
  anchor.writeUInt32LE(4 * S, 24);
  anchor.writeUInt32LE(273, 28);
  udfTag(anchor, 2, 256);
  for (const base of [257, 273]) {
    udfTag(sector(base), 1, base);
    const p = sector(base + 1);
    p.writeUInt16LE(1, 20);
    p.write("+NSR02", 25);
    p.writeUInt32LE(1, 184);
    p.writeUInt32LE(300, 188);
    p.writeUInt32LE(300, 192);
    udfTag(p, 5, base + 1);
    const l = sector(base + 2);
    l.writeUInt32LE(S, 212);
    l.write("*OSTA UDF Compliant", 217);
    l.writeUInt16LE(0x102, 240);
    l.writeUInt32LE(S, 248);
    l.writeUInt32LE(6, 264);
    l.writeUInt32LE(1, 268);
    l.writeUInt32LE(S, 432);
    l.writeUInt32LE(290, 436);
    l[440] = 1;
    l[441] = 6;
    l.writeUInt16LE(1, 442);
    udfTag(l, 6, base + 2, 430);
    udfTag(sector(base + 3), 8, base + 3);
  }
  const fsd = sector(300);
  fsd.writeUInt32LE(S, 400);
  fsd.writeUInt32LE(1, 404);
  fsd.write("*OSTA UDF Compliant", 417);
  fsd.writeUInt16LE(0x102, 440);
  udfTag(fsd, 256, 0);
  function fid(child: number, name?: string, dir = false) {
    const id =
      name === undefined
        ? Buffer.alloc(0)
        : Buffer.concat([Buffer.from([8]), Buffer.from(name)]);
    const b = Buffer.alloc(Math.ceil((38 + id.length) / 4) * 4);
    b.writeUInt16LE(1, 16);
    b[18] = name === undefined ? 10 : dir ? 2 : 0;
    b[19] = id.length;
    b.writeUInt32LE(S, 20);
    b.writeUInt32LE(child, 24);
    id.copy(b, 38);
    return b;
  }
  function directory(lba: number, items: Buffer[]) {
    let at = 0;
    for (const b of items) {
      udfTag(b, 257, lba - 300, b.length - 16);
      b.copy(sector(lba), at);
      at += b.length;
    }
    return at;
  }
  function fe(lba: number, data: number, bytes: number, directory: boolean) {
    const b = sector(lba);
    b[27] = directory ? 4 : 5;
    b.writeBigUInt64LE(BigInt(bytes), 56);
    b.writeBigUInt64LE(BigInt(Math.ceil(bytes / S)), 64);
    b.writeUInt32LE(8, 172);
    b.writeUInt32LE(bytes, 176);
    b.writeUInt32LE(data - 300, 180);
    udfTag(b, 261, lba - 300, 168);
  }
  const rootBytes = directory(302, [fid(1), fid(3, "VIDEO_TS", true)]);
  fe(301, 302, rootBytes, true);
  const fileNames = [
    "VIDEO_TS.IFO",
    "VIDEO_TS.BUP",
    "VTS_01_0.IFO",
    "VTS_01_0.BUP",
    "VTS_01_1.VOB",
  ];
  const videoBytes = directory(304, [
    fid(1),
    ...fileNames.map((n, i) => fid(10 + i, n)),
  ]);
  fe(303, 304, videoBytes, true);
  for (const [i, data] of [400, 401, 402, 404, 410].entries())
    fe(310 + i, data, (i < 2 ? 1 : i < 4 ? 2 : 4) * S, false);
  return image;
}
