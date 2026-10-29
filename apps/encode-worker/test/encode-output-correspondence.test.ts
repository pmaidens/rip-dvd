import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { encodeOutputArtifactIdentity, measureEncodeSourceCell, measureEncodeOutputCell, type EncodeOutputIntervalInspection } from "@rip-dvd/application";
import { pollEncodeWorker } from "../src/encode-worker.js";
import { seedCorrespondenceClaim, seedCorrespondenceSource } from "../../operator-cli/src/encode-output-correspondence.test-support.js";
import { publishSyntheticClaim, syntheticOutputValidation } from "../../operator-cli/src/encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputIntervalsRoute } from "../../web/app/api/encode-outputs/[artifactIdentity]/intervals/route.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const linux = it.skipIf(process.platform !== "linux");
function tool(executable: string, arguments_: string[], cwd?: string) {
  return execFileSync(executable, arguments_, { cwd, env: { ...process.env, VIDEO_FORMAT: "PAL" }, timeout: 60_000, encoding: "utf8", stdio: "pipe" });
}
function sourceMedia(directory: string) {
  tool("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=720x576:r=25:d=4",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=4", "-target", "pal-dvd", "source.mpg"], directory);
  writeFileSync(join(directory, "dvd.xml"), '<dvdauthor dest="dvd"><vmgm /><titleset><titles><video format="pal" aspect="4:3" />'
    + '<audio lang="en" /><pgc><vob file="source.mpg" /></pgc></titles></titleset></dvdauthor>');
  tool("dvdauthor", ["-x", "dvd.xml"], directory);
  const image = join(directory, "source.iso");
  tool("genisoimage", ["-quiet", "-udf", "-dvd-video", "-V", "SYNTHETIC_CELL", "-o", image, "dvd"], directory);
  const path = join(directory, "dvd", "VIDEO_TS", "VTS_01_1.VOB");
  const content = readFileSync(path), imageContents = readFileSync(image);
  const offset = imageContents.indexOf(content);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(offset % 2048).toBe(0);
  expect(content.byteLength % 2048).toBe(0);
  expect(imageContents.indexOf(content, offset + 1)).toBe(-1);
  const native = JSON.parse(tool("rip-dvd-preview-title", [image, "1", "1", "1", "1", join(directory, "synthetic-path-marker")]));
  expect(native).toMatchObject({ navigation: { videoTitleSetNumber: 1, titleSetTitleNumber: 1, programChainNumber: 1 },
    selectedPath: [{ programNumber: 1, cellNumber: 1, vobId: 1, cellId: 1 }], audio: [{ sourceId: 128, physicalId: 128 }] });
  expect(native.selectedPath).toHaveLength(1);
  return { path, singleCell: { imageContents, sourceRange: { startLba: offset / 2048, sectorCount: content.byteLength / 2048 } } };
}

linux("reaches measured correspondence with the real supported HandBrake preset through worker publication and public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const media = sourceMedia(fixture.operatorHostPath);
  const seeded = await seedCorrespondenceSource(fixture, { sharedSource: true, singleCell: media.singleCell });
  try {
    await pollEncodeWorker({ ...fixture, access: seeded.access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
      subtitleScanner: { scan: async () => [] } });
    const job = seeded.access.encodeJobs.find(seeded.job.id)!;
    expect(job.status, JSON.stringify({ error: job.errorMessage,
      failures: seeded.access.encodeJobs.listFailureReports([job.id]) })).toBe("completed");
    const identity = encodeOutputArtifactIdentity(job.id);
    const inspection = await fixture.run(["encode-output", "inspect", identity]);
    const query = { assessmentIdentity: seeded.assessment.id, titleIdentityObservationId: seeded.access.encodeJobs.listClaimSnapshots(job.id)[0]!.source.titleIdentity.id, intervalIndexes: [0] };
    const cli = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify(query)]);
    const web = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${identity}/intervals?query=${encodeURIComponent(JSON.stringify(query))}`), identity, () => seeded.access);
    expect(inspection).toMatchObject({ exitCode: 0, result: { artifact: { validation: { result: "passed" }, provenance: { sourceSnapshot: { source: { output: { preset: "Fast 1080p30" } } } } } } });
    expect(cli.result).toEqual(await web.json());
    expect(cli.exitCode).toBe(0);
    expect((cli.result as EncodeOutputIntervalInspection).intervals.map(({ status, reasonCode, outputInterval }) => ({ status, reasonCode, outputInterval })))
      .toMatchObject([{ status: "verified", reasonCode: "OUTPUT_CELL_CONTENT_VERIFIED" }]);
    expect((cli.result as EncodeOutputIntervalInspection).targetedLocation).toMatchObject({ eligible: true });
  } finally { seeded.access.close(); }
}, 120_000);

linux.each(["shifted", "shifted_pts", "repeated", "omitted", "truncated"] as const)("measures actual synthetic %s media through the producer and both operator adapters", async (kind) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const media = sourceMedia(fixture.operatorHostPath);
  const seeded = await seedCorrespondenceClaim(fixture, { sharedSource: true, singleCell: media.singleCell });
  try {
    // Lossless encoding here isolates measured content and timestamp behavior.
    // The separate real worker test proves the production preset can reach it.
    // Author deterministic output timestamps even when the DVD's decoded
    // source frames have no PTS. These are fixture construction instructions.
    // FFmpeg 7 setpts clears frame rate and duration. Restore them before
    // padding and at the encoder boundary; retain the fine offset in packets.
    const normalized = "[0:v]setpts=N/(25*TB),fps=25";
    const content = kind === "shifted" || kind === "shifted_pts" ? `${normalized},tpad=start=25:color=red[authored]`
      : kind === "repeated" ? `${normalized},split[a][b];[a][b]concat=n=2:v=1:a=0[authored]`
      : kind === "omitted" ? `${normalized},select='lt(t,1)+gte(t,2)',setpts=N/(25*TB)[authored]`
      : `${normalized},trim=end_frame=50,setpts=N/(25*TB)[authored]`;
    // tpad preserves the normalized frame timing, but its EOF timestamp does
    // not include start padding. A second fps would discard its final frame.
    const filter = `${content};[authored]${kind.startsWith("shifted") ? "null" : "fps=25"}[v]`;
    tool("ffmpeg", ["-v", "error", "-y", "-i", media.path, "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono:d=6",
      "-filter_complex", filter, "-map", "[v]", "-map", "1:a:0", "-c:a", "pcm_s16le", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0",
      "-fps_mode:v", "passthrough", "-enc_time_base:v", "1:1000",
      ...(kind === "shifted_pts" ? ["-bsf:v", "setts=pts=PTS+0.021/TB:dts=DTS+0.021/TB"] : []), seeded.claim.outputPath]);
    const authored = JSON.parse(tool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries",
      "stream=time_base:frame=pts,duration,pkt_duration", "-of", "json", seeded.claim.outputPath])) as {
        streams: { time_base: string }[]; frames: { pts: number; duration?: number; pkt_duration?: number }[];
      };
    const expectedFrames = kind.startsWith("shifted") ? 125 : kind === "repeated" ? 200 : kind === "omitted" ? 75 : 50;
    expect(authored.streams).toEqual([{ time_base: "1/1000" }]);
    expect(authored.frames.map((frame) => [frame.pts, frame.duration ?? frame.pkt_duration]))
      .toEqual(Array.from({ length: expectedFrames }, (_, index) => [(kind === "shifted_pts" ? 21 : 0) + index * 40, 40]));
    const snapshot = seeded.access.encodeJobs.findClaimSnapshot(seeded.claim.claimToken)!;
    const source = await createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }).withConsistentRead({
      archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath, originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal, task: (ownership) => measureEncodeSourceCell(snapshot, seeded.archive.archivePath, ownership),
    });
    const correspondence = await measureEncodeOutputCell(source, seeded.claim.outputPath, new AbortController().signal);
    publishSyntheticClaim(seeded.access, seeded.claim, false, { preserveOutput: true, evidence: { ...syntheticOutputValidation, correspondence } });
    const identity = encodeOutputArtifactIdentity(seeded.claim.id);
    const query = { assessmentIdentity: seeded.assessment.id, titleIdentityObservationId: snapshot.source.titleIdentity.id, intervalIndexes: [0] };
    const cli = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify(query)]);
    const web = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${identity}/intervals?query=${encodeURIComponent(JSON.stringify(query))}`), identity, () => seeded.access);
    expect(cli.result).toEqual(await web.json());
    expect(cli.exitCode).toBe(0);
    const observed = (cli.result as EncodeOutputIntervalInspection).intervals.map(({ status, reasonCode, outputInterval }) => ({ status, reasonCode, outputInterval }));
    expect(observed).toMatchObject([{ status: kind.startsWith("shifted") ? "verified" : "unknown",
      reasonCode: kind.startsWith("shifted") ? "OUTPUT_CELL_CONTENT_VERIFIED"
        : kind === "repeated" ? "OUTPUT_CONTENT_AMBIGUOUS" : "OUTPUT_CONTENT_UNRESOLVED" }]);
    if (kind.startsWith("shifted")) expect(cli.result).toMatchObject({ intervals: [{ outputInterval: {
      startMilliseconds: kind === "shifted_pts" ? 1021 : 1000, endMilliseconds: kind === "shifted_pts" ? 5021 : 5000,
    } }] });
    else expect(cli.result).toMatchObject({ intervals: [{ outputInterval: null }], targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" } });
  } finally { seeded.access.close(); }
}, 120_000);
