import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createHandBrakeSubtitleProvenanceParser } from "../src/handbrake-subtitle-provenance.js";
import { createNodeEncodeOutputValidator } from "../src/encode-output-validator.js";
import { syntheticBitmapSubtitle } from "./browser-rendition-media.test-support.js";

function run(executable: string, args: string[]) {
  return execFileSync(executable, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, stdio: "pipe" });
}

// Generate VobSub with FFmpeg, then change its SPU display-start command to
// forced-start for selected cues. The same DVD packet control commands are
// decoded by HandBrake, rather than simulating its scan or mux results.
function bitmapTrack(directory: string, name: string, cues: number, forcedCues: number) {
  const sup = join(directory, `${name}.sup`);
  const mkv = join(directory, `${name}.mkv`);
  const raw = join(directory, `${name}.bin`);
  writeFileSync(sup, syntheticBitmapSubtitle(cues, cues > 2 ? 18_000 : 90_000, 4_500));
  run("ffmpeg", ["-v", "error", "-copyts", "-fix_sub_duration", "-i", sup, "-c:s", "dvdsub", mkv]);
  run("ffmpeg", ["-v", "error", "-i", mkv, "-map", "0:s:0", "-c", "copy", "-f", "data", raw]);
  const packets = readFileSync(raw);
  const media = readFileSync(mkv);
  let offset = 0;
  let searchOffset = 0;
  let count = 0;
  while (offset < packets.length) {
    const size = packets.readUInt16BE(offset);
    expect(size).toBeGreaterThan(8);
    const packet = packets.subarray(offset, offset + size);
    const position = media.indexOf(packet, searchOffset);
    expect(position).toBeGreaterThanOrEqual(searchOffset);
    let command = packet.readUInt16BE(2) + 4;
    const operandBytes: Record<number, number> = { 3: 2, 4: 2, 5: 6, 6: 4 };
    while (packet[command] !== 1) {
      const bytes = operandBytes[packet[command]!];
      expect(bytes).toBeDefined();
      command += 1 + bytes!;
    }
    if (count < forcedCues) media[position + command] = 0;
    searchOffset = position + size;
    offset += size;
    count++;
  }
  expect(count).toBe(cues);
  writeFileSync(mkv, media);
  return mkv;
}

it.runIf(process.env.RIP_DVD_TEST_HANDBRAKE_SUBTITLE_MEDIA === "true")(
  "validates real HandBrake 1.9.2 search sanitization and Matroska dispositions",
  async () => {
    expect(run("HandBrakeCLI", ["--version"])).toMatch(/HandBrake 1\.9\.2\b/);
    const directory = mkdtempSync(join(tmpdir(), "synthetic-subtitle-gate-"));
    try {
      for (const scenario of [
        { name: "no-forced-hits", cues: 1, forced: 0, defaultTrack: true, kind: "source", forcedOnly: false, outputs: 2 },
        { name: "all-forced", cues: 1, forced: 1, defaultTrack: true, kind: "source", forcedOnly: true, outputs: 2 },
        { name: "partial-without-default", cues: 2, forced: 1, defaultTrack: false, kind: "foreign_audio_search", forcedOnly: true, outputs: 3 },
      ] as const) {
        const dense = bitmapTrack(directory, `${scenario.name}-dense`, 40, 0);
        const rare = bitmapTrack(directory, `${scenario.name}-rare`, scenario.cues, scenario.forced);
        const source = join(directory, `${scenario.name}-source.mkv`);
        const output = join(directory, `${scenario.name}-output.mkv`);
        run("ffmpeg", ["-v", "error", "-copyts", "-f", "lavfi", "-i", "color=size=160x90:rate=24",
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-i", dense, "-i", rare,
          "-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0", "-map", "3:s:0", "-t", "9",
          "-c:v", "mpeg2video", "-threads:v", "1", "-c:a", "ac3", "-c:s", "copy",
          "-metadata:s:a:0", "language=eng", "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=eng",
          source]);
        const encoded = spawnSync("HandBrakeCLI", ["-i", source, "-o", output, "-f", "av_mkv", "-e", "x264",
          "--encoder-preset", "ultrafast", "--subtitle", "scan,1,2", "--subtitle-forced=1", "--subtitle-burned=none",
          ...(scenario.defaultTrack ? ["--subtitle-default=1"] : [])],
        { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        expect(encoded.status, encoded.stderr).toBe(0);
        expect(encoded.stderr).toContain("Starting Task: Subtitle Scan");
        expect(encoded.stderr).toContain(`${scenario.cues} hits (${scenario.forced} forced)`);
        expect(encoded.stderr).toContain("Found a subtitle candidate");
        const parser = createHandBrakeSubtitleProvenanceParser();
        parser.push(encoded.stderr);
        const expectedVobSubStreams = [
          { sourceTrackNumber: 1, languageCode: "eng", title: null },
          { sourceTrackNumber: 2, languageCode: "eng", title: null },
        ];
        const provenance = parser.finish(expectedVobSubStreams);
        expect(provenance).toHaveLength(scenario.outputs);
        expect(provenance[0]).toEqual({ sourceTrackNumber: 2, kind: scenario.kind, forcedOnly: scenario.forcedOnly, default: scenario.defaultTrack });
        const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "s", "-count_packets",
          "-show_entries", "stream=nb_read_packets:stream_disposition=default,forced", "-of", "json", output]));
        expect(probe.streams).toHaveLength(scenario.outputs);
        expect(probe.streams[0]).toEqual({ nb_read_packets: "1", disposition: {
          default: Number(scenario.defaultTrack), forced: Number(scenario.defaultTrack),
        } });
        // The complete dense source remains after the selected rare source.
        expect(Number(probe.streams[1].nb_read_packets)).toBe(40);
        if (scenario.kind === "foreign_audio_search") expect(probe.streams[2].nb_read_packets).toBe("2");
        await expect(createNodeEncodeOutputValidator().prepareAndValidate(output, new AbortController().signal,
          { expectedVobSubStreams, vobSubProvenance: provenance, expectedDurationSeconds: 9 }))
          .resolves.toMatchObject({ decode: { completed: true } });
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 120_000,
);
