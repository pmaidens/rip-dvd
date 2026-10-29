import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EncodeOutputValidationError, pollEncodeWorker } from "../src/encode-worker.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { unavailableKeepProbe } from "../../operator-cli/src/encode-output-keep-preflight.test-support.js";
import type { EncodeOutputKeepPreflight } from "@rip-dvd/application";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

// This uses the actual native publication/cleanup protocol, synthetic writes
// and validator results. It never starts HandBrake or processes native media.
describe.skipIf(process.platform !== "linux")("Keep and the real worker publication lifecycle", () => {
  it("rejects stale Keep while a requeued worker completes, preserving the old failed artifact through reconciliation", async () => {
    expect(process.getuid?.()).not.toBe(0);
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const { predecessor, archive } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic existing normal output" });
    const access = fixture.openAccess();
    try {
      const source = join(fixture.originalsLibraryPath, "synthetic-keep-source.iso");
      writeFileSync(source, "synthetic source image");
      const database = new DatabaseSync(fixture.databasePath);
      try { database.prepare("UPDATE original_disc_archives SET archive_path = ? WHERE id = ?").run(source, archive.id); }
      finally { database.close(); }
      const job = access.catalog.completeCatalogReviewWithReplacements(archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections",
        [{ predecessorEncodeJobId: predecessor.id, encodingProfileId: predecessor.encodingProfileId, outputPath: predecessor.outputPath }]).replacementEncodeJobs[0]!;
      const common = { ...fixture, access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
        subtitleScanner: { scan: async () => [] } };
      await pollEncodeWorker({ ...common, runner: { run: async ({ outputPath }) => { writeFileSync(outputPath, "synthetic completed failed write"); } },
        outputValidator: { prepareAndValidate: async () => { throw new EncodeOutputValidationError("Synthetic duration failure", { kind: "duration", expectedSeconds: 500, observedSeconds: 10 }); } } });
      const failed = access.encodeJobs.listValidationFailedOutputs(job.id, { limit: 1 })[0]!;
      const identity = `encode-output-v1.failed.${failed.id}`;
      const bytes = readFileSync(failed.outputPath);
      const previewResult = await fixture.run(["encode-output", "keep-preflight", identity], undefined, undefined,
        { encodeOutputMediaProbe: unavailableKeepProbe });
      const preview = previewResult.result as EncodeOutputKeepPreflight;
      expect(preview.eligible).toBe(true);
      access.encodeJobs.requeue(job.id);
      let workerRan = false;
      const result = await fixture.run(["encode-output", "keep", identity, "--key", "synthetic-worker-race-keep", "--json",
        JSON.stringify({ acknowledged: true, validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken })],
      undefined, undefined, { encodeOutputMediaProbe: async () => {
        await pollEncodeWorker({ ...common, runner: { run: async ({ outputPath }) => {
          workerRan = true; writeFileSync(outputPath, "synthetic new validated output");
        } }, outputValidator: { prepareAndValidate: async () => undefined } });
        throw new Error("Synthetic probe unavailable");
      } });
      expect(result.exitCode).not.toBe(0);
      expect(workerRan).toBe(true);
      expect(access.encodeJobs.find(job.id)).toMatchObject({ status: "completed", outputValidationResult: "passed" });
      expect(readFileSync(job.outputPath, "utf8")).toBe("synthetic new validated output");
      expect(readFileSync(failed.outputPath)).toEqual(bytes);
      expect(access.encodeJobs.findValidationFailedOutput(failed.id)).toEqual(failed);
      expect(access.encodeOutputKeeps.latest(identity)).toBeNull();
    } finally { access.close(); }
  });
});
