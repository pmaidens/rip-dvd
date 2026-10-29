import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { encodeOutputArtifactIdentity, measureEncodeSourceCell, measureEncodeOutputCell } from "@rip-dvd/application";
import { pollEncodeWorker } from "../src/encode-worker.js";
import { seedCorrespondenceClaim, seedCorrespondenceSource } from "../../operator-cli/src/encode-output-correspondence.test-support.js";
import { publishSyntheticClaim, syntheticOutputValidation } from "../../operator-cli/src/encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputIntervalsRoute } from "../../web/app/api/encode-outputs/[artifactIdentity]/intervals/route.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const linux = it.skipIf(process.platform !== "linux");
function tool(executable: string, arguments_: string[]) {
  return execFileSync(executable, arguments_, { timeout: 60_000, encoding: "utf8", stdio: "pipe" });
}
function sourceMedia(path: string) {
  tool("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=720x480:r=25:d=4",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=4", "-c:v", "mpeg2video", "-c:a", "ac3", "-f", "vob", path]);
}

linux("reaches measured correspondence with the real supported HandBrake preset through worker publication and public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const input = join(fixture.operatorHostPath, "synthetic-cell.mpg"); sourceMedia(input);
  const seeded = await seedCorrespondenceSource(fixture, { sharedSource: true, singleCell: { imageContents: readFileSync(input) } });
  try {
    await pollEncodeWorker({ ...fixture, access: seeded.access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
      subtitleScanner: { scan: async () => [] } });
    const job = seeded.access.encodeJobs.find(seeded.job.id)!;
    expect(job.status).toBe("completed");
    const identity = encodeOutputArtifactIdentity(job.id);
    const inspection = await fixture.run(["encode-output", "inspect", identity]);
    const query = { assessmentIdentity: seeded.assessment.id, titleIdentityObservationId: seeded.access.encodeJobs.listClaimSnapshots(job.id)[0]!.source.titleIdentity.id, intervalIndexes: [0] };
    const cli = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify(query)]);
    const web = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${identity}/intervals?query=${encodeURIComponent(JSON.stringify(query))}`), identity, () => seeded.access);
    expect(inspection).toMatchObject({ exitCode: 0, result: { artifact: { validation: { result: "passed" }, provenance: { sourceSnapshot: { source: { output: { preset: "Fast 1080p30" } } } } } } });
    expect(cli.result).toEqual(await web.json());
    expect(cli).toMatchObject({ exitCode: 0, result: { intervals: [{ status: "verified", reasonCode: "OUTPUT_CELL_CONTENT_VERIFIED" }], targetedLocation: { eligible: true } } });
  } finally { seeded.access.close(); }
}, 120_000);

linux.each(["shifted", "shifted_pts", "repeated", "omitted", "truncated"] as const)("measures actual synthetic %s media through the producer and both operator adapters", async (kind) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const input = join(fixture.operatorHostPath, "synthetic-cell.mpg"); sourceMedia(input);
  const seeded = await seedCorrespondenceClaim(fixture, { sharedSource: true, singleCell: { imageContents: readFileSync(input) } });
  try {
    // Lossless encoding here isolates measured content and timestamp behavior.
    // The separate real worker test proves the production preset can reach it.
    const filter = kind === "shifted" || kind === "shifted_pts" ? `[0:v]setpts=PTS-STARTPTS,tpad=start_duration=1:color=red${kind === "shifted_pts" ? ",settb=1/1000,setpts=PTS+21" : ""}[v]`
      : kind === "repeated" ? "[0:v]setpts=PTS-STARTPTS,split[a][b];[a][b]concat=n=2:v=1:a=0[v]"
      : kind === "omitted" ? "[0:v]select='lt(t,1)+gte(t,2)',setpts=N/(25*TB)[v]"
      : "[0:v]trim=duration=2,setpts=PTS-STARTPTS[v]";
    tool("ffmpeg", ["-v", "error", "-y", "-i", input, "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono:d=6",
      "-filter_complex", filter, "-map", "[v]", "-map", "1:a:0", "-c:a", "pcm_s16le", "-c:v", "ffv1", "-enc_time_base", "1:1000", seeded.claim.outputPath]);
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
    expect(cli).toMatchObject({ exitCode: 0, result: { intervals: [{ status: kind.startsWith("shifted") ? "verified" : "unknown" }] } });
    if (kind.startsWith("shifted")) expect(cli.result).toMatchObject({ intervals: [{ outputInterval: {
      startMilliseconds: kind === "shifted_pts" ? 1021 : 1000, endMilliseconds: kind === "shifted_pts" ? 5021 : 5000,
    } }] });
    else expect(cli.result).toMatchObject({ intervals: [{ outputInterval: null }], targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" } });
  } finally { seeded.access.close(); }
}, 120_000);
