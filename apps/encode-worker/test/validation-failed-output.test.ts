import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pollEncodeWorker, EncodeOutputValidationError } from "../src/encode-worker.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../operator-cli/src/operator-workflow.test-support.js";

const fault = vi.hoisted(() => ({ storage: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => {
    if (fault.storage) throw Object.assign(new Error("Synthetic storage sync failure"), { code: "EIO" });
    return fs.fsyncSync(fd);
  } };
});

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { fault.storage = false; fixtures.splice(0).forEach((fixture) => fixture.dispose()); });

it.each(["validation", "interrupted", "writer_failed", "changed_bytes", "changed_inode", "lost_claim", "storage", "probe_storage", "active_writer"])(
  "retains only a complete owned validation failure at the %s boundary", async (failure) => {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const { predecessor, archive } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic existing normal output" });
    const access = fixture.openAccess();
    const controller = new AbortController();
    let partial = "";
    try {
      const source = join(fixture.originalsLibraryPath, "synthetic-source.iso");
      writeFileSync(source, "synthetic source image");
      const db = new DatabaseSync(fixture.databasePath);
      try { db.prepare("UPDATE original_disc_archives SET archive_path = ? WHERE id = ?").run(source, archive.id); }
      finally { db.close(); }
      const job = access.catalog.completeCatalogReviewWithReplacements(archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections",
        [{ predecessorEncodeJobId: predecessor.id, encodingProfileId: predecessor.encodingProfileId, outputPath: predecessor.outputPath }]).replacementEncodeJobs[0]!;
      const work = pollEncodeWorker({ ...fixture, access, concurrency: 1, log: () => {}, signal: controller.signal,
        subtitleScanner: { scan: async () => [] },
        runner: { run: async ({ outputPath }) => {
          partial = outputPath;
          writeFileSync(outputPath, "synthetic fully written failed output");
          if (failure === "interrupted") { controller.abort(); throw new Error("Synthetic process interruption"); }
          if (failure === "writer_failed") throw new Error("Synthetic incomplete write");
        }, isActive: () => failure === "active_writer" },
        outputValidator: { prepareAndValidate: async (path) => {
          if (failure === "changed_bytes") writeFileSync(path, "synthetic changed validation bytes");
          if (failure === "changed_inode") { writeFileSync(`${path}.replacement`, "synthetic replaced output"); renameSync(`${path}.replacement`, path); }
          if (failure === "lost_claim") {
            const db = new DatabaseSync(fixture.databasePath);
            try { db.prepare("UPDATE encode_jobs SET claim_token = ? WHERE id = ?").run("synthetic-lost-claim", job.id); }
            finally { db.close(); }
          }
          fault.storage = failure === "storage";
          throw new EncodeOutputValidationError("Synthetic duration failure", { kind: "duration", expectedSeconds: 500, observedSeconds: 10 }, failure !== "probe_storage");
        } },
      });
      if (failure === "interrupted") await expect(work).rejects.toThrow(); else await work;
      expect(readFileSync(predecessor.outputPath, "utf8")).toBe("synthetic existing normal output");
      const outputs = access.encodeJobs.listValidationFailedOutputs(job.id, { limit: 10 });
      if (failure === "validation") {
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ failure: { reasonCode: "output_validation_failed", evidence: { kind: "duration" } }, sourceSnapshot: null });
        expect(readFileSync(outputs[0]!.outputPath, "utf8")).toBe("synthetic fully written failed output");
        expect(existsSync(partial)).toBe(false);
        expect(access.encodeJobs.find(job.id)).toMatchObject({ status: "failed", outputValidationResult: null });
      } else expect(outputs).toEqual([]);
      if (failure !== "lost_claim") expect(access.encodeJobs.find(job.id)?.status).toBe("failed");
    } finally { access.close(); }
  },
);
