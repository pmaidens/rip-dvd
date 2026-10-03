// Generated media only. Run in the handbrake-dvd-scan-test Docker target.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "dvd-label-test-"));
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: directory, encoding: "utf8", timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options,
  });
}

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
    }
  }
  return crc;
}

function withLabel(original, label) {
  const iso = Buffer.from(original);
  let descriptors = 0;
  for (let offset = 0; offset < iso.length; offset += 2048) {
    const sector = iso.subarray(offset, offset + 2048);
    if (sector.readUInt16LE(0) !== 1 || sector.readUInt32LE(12) !== offset / 2048
        || sector[24] !== 8 || sector.toString("ascii", 25, 33) !== "TEST_DVD") continue;
    const bytes = Buffer.from(label, "latin1");
    assert.ok(bytes.length <= 30);
    sector.fill(0, 24, 56);
    sector[24] = 8; // UDF compressed Unicode, eight-bit code points.
    bytes.copy(sector, 25);
    sector[55] = bytes.length + 1;
    sector.writeUInt16LE(crc16(sector.subarray(16, 16 + sector.readUInt16LE(10))), 8);
    sector[4] = 0;
    sector[4] = sector.subarray(0, 16).reduce((sum, byte) => sum + byte, 0) & 0xff;
    descriptors++;
  }
  assert.equal(descriptors, 2, "patch only the generated main and reserve UDF descriptors");
  return iso;
}

function scan(command, path) {
  const stdout = run(command, ["--no-dvdnav", "--scan", "--json", "--title", "1",
    "--min-duration", "0", "--previews", "1:0", "-i", path]);
  const markers = [...stdout.matchAll(/^JSON Title Set: /gm)];
  assert.equal(markers.length, 1);
  return JSON.parse(stdout.slice(markers[0].index + markers[0][0].length));
}

try {
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=720x480:r=30000/1001",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3",
    "-target", "ntsc-dvd", "-threads", "1", "video.mpg"]);
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "color=black:s=160x32,drawbox=x=4:y=4:w=152:h=24:color=white:t=fill",
    "-frames:v", "1", "-threads", "1", "subtitle.png"]);
  writeFileSync(join(directory, "subtitles.xml"),
    '<subpictures><stream><spu start="00:00:00.500" end="00:00:01.500" image="subtitle.png" xoffset="280" yoffset="400" /></stream></subpictures>');
  writeFileSync(join(directory, "subtitled.mpg"), run("spumux", ["subtitles.xml"], {
    input: readFileSync(join(directory, "video.mpg")), encoding: "buffer",
  }));
  writeFileSync(join(directory, "dvd.xml"),
    '<dvdauthor dest="dvd"><vmgm /><titleset><titles><video format="ntsc" aspect="4:3" />'
    + '<audio lang="en" /><subpicture lang="fr" /><pgc><vob file="subtitled.mpg" /></pgc>'
    + '</titles></titleset></dvdauthor>');
  run("dvdauthor", ["-x", "dvd.xml"], { env: { ...process.env, VIDEO_FORMAT: "NTSC" } });
  run("genisoimage", ["-quiet", "-udf", "-dvd-video", "-V", "TEST_DVD", "-o", "base.iso", "dvd"]);
  const original = readFileSync(join(directory, "base.iso"));
  for (const label of ["TEST_DVD", "Café des étoiles", "Ã©", "ÿ".repeat(30)]) {
    const path = join(directory, "label.iso");
    const fixture = withLabel(original, label);
    writeFileSync(path, fixture);
    if (label === "Café des étoiles") {
      assert.deepEqual(scan("/usr/bin/HandBrakeCLI", path).TitleList, [],
        "negative control must reproduce HandBrake's non-UTF-8 title serialization failure");
    }
    const result = scan("/usr/local/bin/rip-dvd-handbrake", path);
    assert.equal(result.TitleList.length, 1, `complete title scan for ${label}`);
    const title = result.TitleList[0];
    assert.equal(title.Index, 1);
    assert.equal(title.Name, label);
    assert.equal(title.AudioList.length, 1);
    assert.equal(title.SubtitleList.length, 1);
    assert.equal(title.SubtitleList[0].TrackNumber, 1);
    assert.equal(title.SubtitleList[0].LanguageCode, "fra");
    assert.equal(title.SubtitleList[0].SourceName, "VOBSUB");
    assert.equal(title.SubtitleList[0].Format, "bitmap");
    const { nodeDvdSubtitleScanner } = await import(
      "/app/apps/encode-worker/dist/dvd-subtitle-scanner.js"
    );
    const expectedVobSubStreams = await nodeDvdSubtitleScanner.scan(path, 1, new AbortController().signal);
    assert.deepEqual(expectedVobSubStreams, [{ languageCode: "fra", title: null }],
      "worker must receive the complete subtitle expectation");
    if (label === "Café des étoiles") {
      const output = join(directory, "encoded.mkv");
      run("/usr/local/bin/rip-dvd-handbrake", ["--no-dvdnav", "-i", path, "-t", "1",
        "-o", output, "-f", "av_mkv", "-e", "x264", "--encoder-preset", "ultrafast",
        "-q", "30", "-a", "1", "-E", "av_aac", "-s", "1", "--subtitle-burned=none"]);
      const { nodeEncodeOutputValidator } = await import(
        "/app/apps/encode-worker/dist/encode-output-validator.js"
      );
      await nodeEncodeOutputValidator.prepareAndValidate(output, new AbortController().signal, {
        expectedDurationSeconds: 3, expectedVobSubStreams,
      });
      console.log("Accented-label DVD encode passed the worker's output and subtitle validation");
    }
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"),
      createHash("sha256").update(fixture).digest("hex"), "scan must not mutate the ISO");
    console.log(`DVD JSON scan and subtitle metadata passed: ${label}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
