import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createApplicationOperations, encodeOutputArtifactIdentity, type EncodeOutputInspection, type EncodingReadiness } from "@rip-dvd/application";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { createNodeEncodeOutputValidator, pollEncodeWorker } from "../src/encode-worker.js";
import { seedEncodeClaim } from "../../operator-cli/src/encode-claim.test-support.js";
import { assessmentMappings } from "../../operator-cli/src/encoding-readiness.test-support.js";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

// The supported worker host supplies ffmpeg and the Linux ownership backend.
// macOS focused suites cover the same persisted handoff with synthetic runners.
const linux = it.skipIf(process.platform !== "linux");

function media(path: string, seconds: number, options: { audio?: boolean; video?: boolean; delay?: boolean } = {}) {
  const inputs = ["-y", "-v", "error"];
  if (options.video !== false) inputs.push("-f", "lavfi", "-i", `color=c=black:s=64x64:r=1:d=${seconds}`);
  if (options.audio !== false) inputs.push("-f", "lavfi", "-i", `anullsrc=r=8000:cl=mono:d=${seconds}`);
  if (options.delay) inputs.push("-vf", "setpts=PTS+10/TB");
  execFileSync("ffmpeg", [...inputs, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path], { timeout: 30_000 });
}

linux.each(["duration", "audio", "video", "subtitle", "timing", "decode", "storage", "ownership"])(
  "keeps accepted-source %s output failures failed and unpublished", async (fault) => {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const seeded = await seedEncodeClaim(fixture, { continuityRisk: true });
    const sample = join(fixture.operatorHostPath, "synthetic-validator-input.mkv");
    media(sample, fault === "duration" ? 2 : 500, { audio: fault !== "audio", video: fault !== "video", delay: fault === "timing" });
    const validator = createNodeEncodeOutputValidator(fault === "decode" ? {
      runMediaTool: async (request) => {
        if (request.executable === "ffmpeg") throw new Error("Synthetic bounded decoder fault");
        return { stdout: execFileSync(request.executable, [...request.arguments_], { encoding: "utf8" }), stderr: "" };
      },
    } : {});
    try {
      await pollEncodeWorker({ ...fixture, access: seeded.access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
        subtitleScanner: { scan: async () => fault === "subtitle" ? [{ languageCode: "eng" }] : [] },
        outputValidator: validator,
        runner: { run: async ({ outputPath }) => {
          if (fault === "storage") throw Object.assign(new Error("Synthetic storage fault"), { code: "ENOSPC" });
          copyFileSync(sample, outputPath);
          if (fault === "ownership") {
            const db = new DatabaseSync(fixture.databasePath);
            try { db.prepare("UPDATE encode_jobs SET claim_token = ? WHERE id = ?").run("synthetic-lost-claim", seeded.job.id); }
            finally { db.close(); }
          }
        } },
      });
      expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).not.toBe("completed");
      expect(existsSync(seeded.job.outputPath)).toBe(false);
      const snapshots = seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.source.acceptance?.decision).toBe("accepted");
      if (fault !== "ownership") {
        expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
        expect(seeded.access.encodeJobs.listFailureReports([seeded.job.id])).not.toHaveLength(0);
      }
    } finally { seeded.access.close(); }
  },
);

linux.each(["full_title", "chapters"])("publishes a valid %s with recorded validation and exact source evidence", async (selection) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { clean: true });
  const access = seeded.access;
  let job = seeded.job;
  try {
    if (selection === "chapters") {
      const archive = access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!;
      access.catalog.correctDiscSelection(seeded.selection.id, { originalDiscArchiveId: archive.id, catalogRevision: archive.updatedAt,
        mediaItemId: seeded.selection.mediaItemId, sourceIdentity: { kind: "dvd_chapters", titleNumber: 1, chapterStart: 2, chapterEnd: 3 },
        reason: "Synthetic bounded selection." });
      await access.assessDvdTitleDamage(archive.id, createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }),
        async () => assessmentMappings(seeded.assessment!.items));
      access.catalog.completeCatalogReview(archive.id, access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections");
      const current = (await fixture.run(["encode-readiness", archive.id])).result as EncodingReadiness;
      job = await createApplicationOperations(access).enqueueEncodeJob({ discSelectionId: current.selections[0]!.discSelectionId,
        encodingProfileId: seeded.profile.id, outputPath: join(fixture.mediaLibraryPath, "synthetic-chapter-output.mkv"),
        mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath,
        expectedSourceDecision: current.selections[0]!.expectedSourceDecision, mutationKey: "synthetic-chapter-output" });
    }
    const sample = join(fixture.operatorHostPath, "synthetic-valid-output.mkv");
    media(sample, selection === "chapters" ? 2 : 490);
    await pollEncodeWorker({ ...fixture, access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
      subtitleScanner: { scan: async () => [] }, outputValidator: createNodeEncodeOutputValidator(),
      runner: { run: async ({ outputPath }) => { copyFileSync(sample, outputPath); } },
    });
    expect(access.encodeJobs.find(job.id)?.status).toBe("completed");
    const result = await fixture.run(["encode-output", "inspect", encodeOutputArtifactIdentity(job.id)]);
    expect(result.exitCode).toBe(0);
    const inspected = result.result as EncodeOutputInspection;
    expect(inspected.artifact.validation).toMatchObject({ result: "passed", recordIdentity: expect.any(String), checks: {
      duration: { expectedSeconds: selection === "chapters" ? null : 500, minimumRatio: selection === "chapters" ? null : 0.98 },
      decode: { completed: true },
    } });
    expect(inspected.artifact.provenance.sourceSnapshot?.source.selection.sourceIdentity.kind)
      .toBe(selection === "chapters" ? "dvd_chapters" : "dvd_title");
    expect(inspected.artifact.media.playability).toBe("not_assessed");
  } finally { access.close(); }
});
