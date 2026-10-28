import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EncodingReadiness } from "@rip-dvd/application";
import type { EncodeJobId } from "@rip-dvd/data-access";
import { seedEncodingReadiness } from "./encoding-readiness.test-support.js";
import { openEncodeSourceTestAccess } from "./encode-source-decision.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
type Result = { outcome: string; code?: string; reasons?: string[] };

function contender(data: Record<string, unknown>) {
  const worker = new Worker(new URL("../test/encode-source-concurrency-worker.mjs", import.meta.url), { workerData: data });
  const events = new Map<string, () => void>();
  const received = new Set<string>();
  const result = new Promise<Result>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message: { type: string; value: Result }) => {
      received.add(message.type); events.get(message.type)?.();
      if (message.type === "result") resolve(message.value);
    });
    worker.on("exit", (code) => { if (code !== 0) reject(new Error(`Contender exited ${code}`)); });
  });
  const event = (name: string) => received.has(name) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    events.set(name, resolve); result.then(() => reject(new Error(`Contender ended before ${name}`)), reject);
  });
  return { result, event, terminate: () => worker.terminate() };
}

it.each(["enqueue", "requeue"] as const)("serializes current-source %s with Recovery Resume in both exact orderings", async (operation) => {
  for (const order of ["encode-first", "resume-first"] as const) {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const seeded = await seedEncodingReadiness(fixture, { clean: true });
    const access = fixture.openAccess();
    access.catalog.completeCatalogReview(seeded.archive.id, access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
    access.dvdRecoveryStorage.record({ contractVersion: "dvd-recovery-storage-preflight-v1", status: "supported", reasonCode: null,
      facts: { filesystemType: "synthetic-local", storageClass: "local", mutationProtection: {
        status: "verified", contract: "linux-rwf-atomic-v1", unitBytes: 4096, memoryAlignmentBytes: 4096,
      }, journalReservationBytes: 1048576, journalPayloadBytes: 983040, journalReservation: "verified",
      journalSynchronization: "verified", imageSynchronization: "verified", checkpointSynchronization: "verified",
      checkpointReplacement: "verified", directorySynchronization: "verified", crossProcessWriterExclusion: "verified",
      crossHostWriterExclusion: "not_applicable", disconnectionBehavior: "not_applicable" } });
    const recovery = access.catalog.findArchiveRecovery(seeded.archive.id)!;
    access.close();
    const decision = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
    const enqueue = { discSelectionId: seeded.selection.id, encodingProfileId: seeded.profile.id,
      outputPath: join(fixture.mediaLibraryPath, "synthetic-race.mkv"), mutationKey: "synthetic-race-enqueue", expectedSourceDecision: decision };
    let encodeJobId: EncodeJobId | undefined;
    if (operation === "requeue") {
      const setup = openEncodeSourceTestAccess(fixture);
      encodeJobId = setup.encodeJobs.enqueue(enqueue).id;
      setup.encodeJobs.requestCancellation(encodeJobId);
      setup.close();
    }
    const barrier = new SharedArrayBuffer(4);
    const common = { databasePath: fixture.databasePath, mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath, barrier, operation, order };
    const encode = contender({ ...common, role: "encode", input: operation === "enqueue" ? enqueue : {
      encodeJobId, mutationKey: "synthetic-race-requeue", expectedSourceDecision: decision,
    } });
    let resume: ReturnType<typeof contender> | undefined;
    try {
      await encode.event("held");
      resume = contender({ ...common, role: "resume", input: {
        mutationKey: `synthetic-race-resume-${operation}-${order}`, archiveRecoveryId: recovery.id, attemptId: recovery.attemptId,
        checkpointRevision: decision.checkpoint!.revision, checkpointDigest: decision.checkpoint!.manifestDigest, speedMode: "normal",
      } });
      await resume.event("attempt");
      if (order === "resume-first") expect(await resume.result).toMatchObject({ outcome: "resumed" });
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      const [encoded, resumed] = await Promise.all([encode.result, resume.result]);
      if (order === "encode-first") {
        expect(encoded).toMatchObject({ outcome: "queued" });
        expect(resumed).toMatchObject({ outcome: "rejected", code: "ENCODE_WORK_CONFLICT" });
      } else {
        expect(encoded).toMatchObject({ outcome: "rejected", code: "ENCODE_WORK_CONFLICT", reasons: expect.arrayContaining(["RECOVERY_WAITING", "ENCODE_WORK_CONFLICT"]) });
        expect(resumed).toMatchObject({ outcome: "resumed" });
      }
      const observer = fixture.openAccess();
      expect(observer.encodeJobs.listForDiscSelection(seeded.selection.id).filter((job) => job.status === "queued")).toHaveLength(order === "encode-first" ? 1 : 0);
      expect(observer.catalog.findArchiveRecovery(seeded.archive.id)!.work !== null).toBe(order === "resume-first");
      observer.close();
    } finally {
      await encode.terminate(); await resume?.terminate();
    }
  }
}, 30_000);
