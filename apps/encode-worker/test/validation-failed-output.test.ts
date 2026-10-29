import { afterEach, expect, it, vi } from "vitest";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pollEncodeWorker, EncodeOutputValidationError, createNodeEncodeOutputValidator } from "../src/encode-worker.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../operator-cli/src/operator-workflow.test-support.js";

const fault = vi.hoisted(() => ({ storage: false, rewrite: false, path: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => {
    if (fault.storage) throw Object.assign(new Error("Synthetic storage sync failure"), { code: "EIO" });
    if (fault.rewrite && fs.fstatSync(fd).isFile()) {
      fault.rewrite = false;
      writeFileSync(fault.path, "x".repeat(fs.fstatSync(fd).size));
      utimesSync(fault.path, 1_000_000_000, 1_000_000_000);
    }
    return fs.fsyncSync(fd);
  } };
});

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { fault.storage = false; fault.rewrite = false; fixtures.splice(0).forEach((fixture) => fixture.dispose()); });

it.each(["validation", "interrupted", "writer_failed", "changed_bytes", "changed_inode", "changed_during_sync", "normal_changed", "lost_claim", "storage", "probe_storage", "probe_storage_stderr", "active_writer"])(
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
          utimesSync(outputPath, 1_000_000_000, 1_000_000_000);
          if (failure === "interrupted") { controller.abort(); throw new Error("Synthetic process interruption"); }
          if (failure === "writer_failed") throw new Error("Synthetic incomplete write");
        }, isActive: () => failure === "active_writer" },
        outputValidator: failure === "probe_storage_stderr" ? createNodeEncodeOutputValidator({ runMediaTool: async () => ({
          stdout: JSON.stringify({ streams: [] }), stderr: "Input/output error",
        }) }) : { prepareAndValidate: async (path) => {
          if (failure === "changed_bytes") writeFileSync(path, "synthetic changed validation bytes");
          if (failure === "changed_inode") { writeFileSync(`${path}.replacement`, "synthetic replaced output"); renameSync(`${path}.replacement`, path); }
          if (failure === "normal_changed") writeFileSync(predecessor.outputPath, "synthetic changed normal output");
          if (failure === "lost_claim") {
            const db = new DatabaseSync(fixture.databasePath);
            try { db.prepare("UPDATE encode_jobs SET claim_token = ? WHERE id = ?").run("synthetic-lost-claim", job.id); }
            finally { db.close(); }
          }
          fault.storage = failure === "storage";
          fault.rewrite = failure === "changed_during_sync";
          fault.path = path;
          throw new EncodeOutputValidationError("Synthetic duration failure", { kind: "duration", expectedSeconds: 500, observedSeconds: 10 }, failure !== "probe_storage");
        } },
      });
      if (failure === "interrupted") await expect(work).rejects.toThrow(); else await work;
      expect(readFileSync(predecessor.outputPath, "utf8")).toBe(failure === "normal_changed" ? "synthetic changed normal output" : "synthetic existing normal output");
      const outputs = access.encodeJobs.listValidationFailedOutputs(job.id, { limit: 10 });
      if (failure === "validation" || failure === "normal_changed") {
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ failure: { reasonCode: "output_validation_failed", evidence: { kind: "duration" } }, sourceSnapshot: null });
        expect(readFileSync(outputs[0]!.outputPath, "utf8")).toBe("synthetic fully written failed output");
        expect(outputs[0]!.outputPath).toBe(partial);
        expect(existsSync(partial)).toBe(true);
        expect(access.encodeJobs.find(job.id)).toMatchObject({ status: "failed", outputValidationResult: null });
        expect(access.encodeJobs.find(job.id)?.replaceExistingOutput).toBe(failure !== "normal_changed");
        if (failure === "validation") {
          const stale = join(dirname(partial), `.${basename(job.outputPath)}.synthetic-old.rip-dvd-partial`);
          writeFileSync(stale, "synthetic unrecorded partial");
          access.encodeJobs.requeue(job.id);
          await pollEncodeWorker({ ...fixture, access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
            subtitleScanner: { scan: async () => [] }, runner: { run: async () => { throw new Error("Synthetic later interruption"); } },
            outputValidator: { prepareAndValidate: async () => {} } });
          expect(readFileSync(outputs[0]!.outputPath, "utf8")).toBe("synthetic fully written failed output");
          expect(access.encodeJobs.listValidationFailedOutputs(job.id, { limit: 10 })).toEqual(outputs);
          expect(existsSync(stale)).toBe(false);
          expect(readdirSync(dirname(stale)).some((name) => name.startsWith(`${basename(stale)}.failed.`))).toBe(true);
        }
      } else expect(outputs).toEqual([]);
      if (failure !== "lost_claim") expect(access.encodeJobs.find(job.id)?.status).toBe("failed");
    } finally { access.close(); }
  },
);


it.each(["complete", "changed_source", "changed_replacement", "media_failure", "storage_failure"])("retains only authenticated subtitle-remux completion with %s evidence", async (boundary) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor, archive } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic normal final" });
  const access = fixture.openAccess();
  const source = join(fixture.originalsLibraryPath, "synthetic-remux-source.iso");
  writeFileSync(source, "synthetic source image");
  const db = new DatabaseSync(fixture.databasePath);
  try { db.prepare("UPDATE original_disc_archives SET archive_path = ? WHERE id = ?").run(source, archive.id); }
  finally { db.close(); }
  const job = access.catalog.completeCatalogReviewWithReplacements(archive.id,
    access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections",
    [{ predecessorEncodeJobId: predecessor.id, encodingProfileId: predecessor.encodingProfileId, outputPath: predecessor.outputPath }]).replacementEncodeJobs[0]!;
  let remuxed = false;
  let partial = "";
  const tools: import("../src/encode-output-validator.js").MediaToolRunner = async (request) => {
    if (request.executable === "ffmpeg") {
      if (boundary === "media_failure") throw new Error("Synthetic invalid media stream");
      if (boundary === "storage_failure") throw Object.assign(new Error("Synthetic remux storage fault"), { code: "EIO" });
      writeFileSync(request.arguments_.at(-1)!, "synthetic completed remux");
      utimesSync(request.arguments_.at(-1)!, 1_000_000_000, 1_000_000_000);
      if (boundary === "changed_source") {
        writeFileSync(partial, "x".repeat(lstatSync(partial).size));
        utimesSync(partial, 1_000_000_000, 1_000_000_000);
      }
      remuxed = true;
      return { stdout: "", stderr: "" };
    }
    const selector = request.arguments_[request.arguments_.indexOf("-select_streams") + 1];
    return { stderr: "", stdout: JSON.stringify(selector === "s" ? { streams: remuxed ? [] : [{
      index: 2, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "eng" }, nb_read_packets: "0",
    }] } : { streams: [{ codec_name: "h264", profile: "High", pix_fmt: "yuv420p" }], packets: [{ pts_time: "0" }], format: { duration: "10" } }) };
  };
  const { createNodeEncodeOutputRepairer } = await import("../src/encode-output-repairer.js");
  try {
    await pollEncodeWorker({ ...fixture, access, concurrency: 1, log: () => {}, signal: new AbortController().signal,
      subtitleScanner: { scan: async () => [{ languageCode: "eng" }] },
      runner: { run: async ({ outputPath }) => {
        partial = outputPath; writeFileSync(outputPath, "synthetic complete original output");
        utimesSync(outputPath, 1_000_000_000, 1_000_000_000);
      } },
      outputValidator: createNodeEncodeOutputValidator({ runMediaTool: tools,
        ...(boundary === "changed_replacement" ? { repairer: createNodeEncodeOutputRepairer({ runMediaTool: tools,
          replaceOutput: async (replacement, path) => {
            const size = lstatSync(replacement).size;
            renameSync(replacement, path);
            writeFileSync(path, "x".repeat(size));
            utimesSync(path, 1_000_000_000, 1_000_000_000);
          },
        }) } : {}),
      }),
    });
    expect(access.encodeJobs.find(job.id)?.status).toBe("failed");
    expect(readFileSync(predecessor.outputPath, "utf8")).toBe("synthetic normal final");
    const outputs = access.encodeJobs.listValidationFailedOutputs(job.id, { limit: 10 });
    if (boundary === "complete" || boundary === "media_failure") {
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.failure.evidence).toMatchObject(boundary === "complete" ? { kind: "duration", observedSeconds: 10 } : { kind: "validation_check", check: "subtitle_cleanup" });
      expect(readFileSync(outputs[0]!.outputPath, "utf8")).toBe(boundary === "complete" ? "synthetic completed remux" : "synthetic complete original output");
    } else {
      expect(outputs).toEqual([]);
      expect(access.encodeJobs.listFailureReports([job.id])).toContainEqual(expect.objectContaining({
        evidence: boundary === "changed_replacement" ? expect.objectContaining({ kind: "duration" }) : { kind: "validation_check", check: "subtitle_cleanup" },
      }));
    }
  } finally { access.close(); }
});
