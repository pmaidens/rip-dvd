import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { createDamagePreviewGenerator, DamagePreviewUnrepresentableError } from "./damage-preview-generator.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const available = process.platform === "linux" && ["ffmpeg", "dvdauthor", "genisoimage", "spumux", "rip-dvd-handbrake", "rip-dvd-preview-title"].every((command) => spawnSync("which", [command]).status === 0);
it.skipIf(!available)("scans a synthetic DVD and generates a playable canonical MKV with the selected source interval and intended preset", async () => {
  const root = mkdtempSync(join(tmpdir(), "preview-media-")); roots.push(root);
  const originals = join(root, "originals"); mkdirSync(originals);
  const source = join(originals, "synthetic.iso");
  const video = join(root, "video.mpg");
  const dvd = join(root, "dvd");
  const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "pipe", env: { ...process.env, VIDEO_FORMAT: "NTSC" } });
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=720x480:r=30000/1001", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-target", "ntsc-dvd", "-ac", "2", "-threads", "1", video]);
  const subtitle = join(root, "subtitle.png");
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x32,drawbox=x=4:y=4:w=152:h=24:color=white:t=fill", "-frames:v", "1", "-threads", "1", subtitle]);
  const subtitles = join(root, "subtitles.xml"), subtitled = join(root, "subtitled.mpg"), authoring = join(root, "dvd.xml");
  writeFileSync(subtitles, `<subpictures><stream><spu start="00:00:00.500" end="00:00:02.500" image="${subtitle}" xoffset="280" yoffset="400" /></stream></subpictures>`);
  const videoInput = openSync(video, "r"), subtitleOutput = openSync(subtitled, "wx");
  try { execFileSync("spumux", [subtitles], { stdio: [videoInput, subtitleOutput, "pipe"] }); }
  finally { closeSync(videoInput); closeSync(subtitleOutput); }
  writeFileSync(authoring, `<dvdauthor dest="${dvd}"><vmgm /><titleset><titles><video format="ntsc" aspect="4:3" /><audio lang="en" /><subpicture lang="fr" /><pgc><vob file="${subtitled}" /></pgc></titles></titleset></dvdauthor>`);
  run("dvdauthor", ["-x", authoring]);
  run("genisoimage", ["-quiet", "-dvd-video", "-udf", "-o", source, dvd]);
  const ownership = createArchiveImageOwnership({ authorityRootPath: root });
  const base = { archiveId: "synthetic-preview-media", imagePath: source, originalsLibraryPath: originals, signal: new AbortController().signal };
  await ownership.withInitialPublicationWriter({ ...base, async task() {} });
  const generator = createDamagePreviewGenerator();
  await ownership.withConsistentRead({ ...base, previewRead: { onContention() {} }, async task(handle) {
    const scanPath = join(root, "scan.mkv");
    const title = await generator.scan({ source, titleNumber: 1, angleNumber: 1, chapterStart: 1, chapterEnd: 1, outputPath: scanPath, descriptor: handle.descriptor, signal: handle.signal });
    await generator.whenInactive(scanPath); generator.requireInactive(scanPath);
    expect(title.navigation).toEqual({ videoTitleSetNumber: 1, titleSetTitleNumber: 1, programChainNumber: 1 });
    expect(title.selectedPath).toEqual([{ programNumber: 1, cellNumber: 1, vobId: 1, cellId: 1 }]);
    await expect(generator.scan({ source, titleNumber: 1, angleNumber: 2, chapterStart: 1, chapterEnd: 1, outputPath: scanPath, descriptor: handle.descriptor, signal: handle.signal })).rejects.toBeInstanceOf(DamagePreviewUnrepresentableError);
    const structuredScan = createDamagePreviewGenerator({ async run(request) {
      const json = 'JSON Title Set: ' + JSON.stringify({ TitleList: [{ Index: 1, AngleCount: 1, Duration: { Ticks: 360000 }, ChapterList: [{ Duration: { Ticks: 360000 } }], AudioList: [{ TrackNumber: 1, CodecName: "ac3", ChannelCount: 2 }], SubtitleList: [{ TrackNumber: 1, SourceName: "VOBSUB", Attributes: { "4By3": true } }] }] });
      request.onStdout?.(json); request.onOutput(json);
      request.onStderr?.("trailing diagnostic"); request.onOutput("trailing diagnostic");
    } });
    expect(await structuredScan.scan({ source, titleNumber: 1, angleNumber: 1, chapterStart: 1, chapterEnd: 1, outputPath: scanPath, descriptor: handle.descriptor, signal: handle.signal })).toMatchObject({ audio: [{ sourceId: 128, physicalId: 128, trackNumber: 1 }], subtitles: [{ sourceId: 32, physicalId: 32, trackNumber: 1, style: "4By3" }], durationMilliseconds: 4000 });
    expect(title.audio).toEqual([{ sourceId: 128, physicalId: 128, trackNumber: 1, codec: "ac3", channels: 2 }]);
    expect(title.subtitles).toEqual([{ sourceId: 32, physicalId: 32, trackNumber: 1, style: "4By3" }]); expect(title.durationMilliseconds).toBeGreaterThan(3_500);
    const outputPath = join(root, "preview.mkv");
    await generator.generate({ outputPath, sourceOwnershipDescriptor: handle.descriptor, signal: handle.signal, onOutput() {}, arguments_: ["--no-dvdnav", "--title", "1", "--angle", "1", "-i", source, "-o", outputPath, "--format", "av_mkv", "--preset", "Fast 1080p30", "--audio", String(title.audio[0]!.trackNumber), "--subtitle", String(title.subtitles[0]!.trackNumber), "--subtitle-burned=none", "--start-at", "seconds:1", "--stop-at", "seconds:2"] });
    await generator.whenInactive(outputPath); generator.requireInactive(outputPath);
    const inspected = await generator.inspect(outputPath);
    expect(inspected).toMatchObject({ videoCount: 1, audioCount: 1, subtitleCount: 1 });
    expect(inspected.durationMilliseconds).toBeGreaterThanOrEqual(1_900);
    expect(inspected.durationMilliseconds).toBeLessThanOrEqual(2_100);
    expect((await generator.versions()).handbrake).toMatch(/1\.9\.2/);
  } });
});

it.skipIf(!available)("measures video packet coverage when a longer audio tail inflates container duration", async () => {
  const root = mkdtempSync(join(tmpdir(), "preview-video-coverage-")); roots.push(root);
  const path = join(root, "audio-tail.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-t", "1", "-i", "testsrc2=s=64x64:r=10", "-f", "lavfi", "-t", "4", "-i", "sine=frequency=440:sample_rate=48000", "-c:v", "ffv1", "-c:a", "pcm_s16le", path], { stdio: "pipe" });
  const media = await createDamagePreviewGenerator().inspect(path);
  expect(media).toMatchObject({ videoCount: 1, audioCount: 1 });
  expect(media.durationMilliseconds).toBeGreaterThanOrEqual(900);
  expect(media.durationMilliseconds).toBeLessThanOrEqual(1_100);
});
