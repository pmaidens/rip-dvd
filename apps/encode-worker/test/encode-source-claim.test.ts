import { withEvidenceGuardsDisabled } from "../../operator-cli/src/archive-evidence.test-support.js";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { pollEncodeWorker, type HandBrakeRunRequest } from "../src/encode-worker.js";
import { seedEncodeClaim, withdrawClaimAcceptance, injectClaimRecoveryState } from "../../operator-cli/src/encode-claim.test-support.js";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { encodeOutputArtifactIdentity } from "@rip-dvd/application";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });
const fixture = () => { const value = createOperatorWorkflowFixture(); fixtures.push(value); return value; };

it.each(["image", "checkpoint", "recovery", "ownership"])("never starts HandBrake when %s changes after claim", async (fault) => {
  const current = fixture();
  const seeded = await seedEncodeClaim(current);
  const ownership = createArchiveImageOwnership({ authorityRootPath: current.originalsLibraryPath });
  const runner = { run: vi.fn() };
  let invalidOwnership = false;
  const guardedOwnership = { ...ownership,
    withConsistentRead: ((request: Parameters<typeof ownership.withConsistentRead>[0]) => ownership.withConsistentRead({ ...request,
      task: (handle) => request.task({ ...handle, assertOwned() {
        handle.assertOwned();
        if (invalidOwnership) throw new Error("Synthetic ownership loss");
      } }),
    })) as typeof ownership.withConsistentRead,
  };
  try {
    await pollEncodeWorker({ ...current, access: seeded.access, concurrency: 1, log: () => {},
      signal: new AbortController().signal, archiveImageOwnership: guardedOwnership, runner,
      subtitleScanner: { scan: vi.fn(async () => {
        if (fault === "image") writeFileSync(seeded.archive.archivePath, "synthetic changed source");
        else if (fault === "ownership") invalidOwnership = true;
        else {
          const db = new DatabaseSync(current.databasePath);
          if (fault === "checkpoint") withEvidenceGuardsDisabled(current.databasePath, (unprotected) => {
            unprotected.prepare("UPDATE dvd_archive_evidence_headers SET current_manifest_revision = current_manifest_revision + 1 WHERE original_disc_archive_id = ?").run(seeded.archive.id);
          });
          else injectClaimRecoveryState(current, seeded.archive.id, "paused");
          db.close();
        }
        return [];
      }) }, outputValidator: { prepareAndValidate: vi.fn() },
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
    expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toHaveLength(1);
  } finally { seeded.access.close(); }
});

it("withdraws acceptance after a winning claim while HandBrake still uses that exact snapshot", async () => {
  const current = fixture();
  const seeded = await seedEncodeClaim(current, { mainFeature: true });
  const ownership = createArchiveImageOwnership({ authorityRootPath: current.originalsLibraryPath });
  let originalSnapshot: unknown;
  const runner = { run: vi.fn(async (request: HandBrakeRunRequest) => {
    expect(request.arguments_).toContain("--title");
    expect(request.arguments_).not.toContain("--main-feature");
    expect(request.arguments_).toContain("--angle");
    expect(request.sourceOwnershipDescriptor).toEqual(expect.any(Number));
    throw new Error("Synthetic encode termination after observed safe start");
  }) };
  try {
    await pollEncodeWorker({ ...current, access: seeded.access, concurrency: 1, log: () => {},
      signal: new AbortController().signal, archiveImageOwnership: ownership, runner,
      subtitleScanner: { scan: vi.fn(async () => {
        originalSnapshot = seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)[0];
        await withdrawClaimAcceptance(current, seeded.archive.id, seeded.expectedSourceDecision.acceptanceIdentity!);
        return [];
      }) }, outputValidator: { prepareAndValidate: vi.fn() },
    });
    expect(runner.run).toHaveBeenCalledOnce();
    expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toEqual([originalSnapshot]);
    expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)[0]?.source.acceptance?.decision).toBe("accepted");
  } finally { seeded.access.close(); }
});

it("refuses a live prior writer even after its lease expires", async () => {
  const current = fixture();
  const seeded = await seedEncodeClaim(current);
  const ownership = createArchiveImageOwnership({ authorityRootPath: current.originalsLibraryPath, claimLeaseDurationMs: 10 });
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const writer = ownership.withWriter({ archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath,
    originalsLibraryPath: current.originalsLibraryPath, signal: new AbortController().signal,
    task: async () => { entered(); await held; } });
  try {
    await ready;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 60_000);
    expect(ownership.inspect({ archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath,
      originalsLibraryPath: current.originalsLibraryPath })).toMatchObject({ writer: { state: "active" }, workerClaim: { state: "expired" } });
    const runner = { run: vi.fn() };
    await pollEncodeWorker({ ...current, access: seeded.access, concurrency: 1, log: () => {},
      signal: new AbortController().signal, archiveImageOwnership: ownership, runner });
    expect(runner.run).not.toHaveBeenCalled();
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("queued");
    expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toEqual([]);
  } finally { vi.useRealTimers(); release(); await writer; seeded.access.close(); }
});

it("checks the claimed checkpoint before even the subtitle scan opens the image", async () => {
  const current = fixture();
  const seeded = await seedEncodeClaim(current);
  const ownership = createArchiveImageOwnership({ authorityRootPath: current.originalsLibraryPath });
  const scanner = { scan: vi.fn(async () => []) };
  const runner = { run: vi.fn() };
  const guarded = { ...ownership, withConsistentRead: ((request: Parameters<typeof ownership.withConsistentRead>[0]) =>
    ownership.withConsistentRead({ ...request, task: async (handle) => {
      if (seeded.access.encodeJobs.find(seeded.job.id)?.status === "running") {
        writeFileSync(seeded.archive.archivePath, "synthetic mutation between claim and execution");
      }
      return request.task(handle);
    } })) as typeof ownership.withConsistentRead };
  try {
    await pollEncodeWorker({ ...current, access: seeded.access, concurrency: 1, log: () => {},
      signal: new AbortController().signal, archiveImageOwnership: guarded, runner, subtitleScanner: scanner });
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
  } finally { seeded.access.close(); }
});

it("holds shared ownership for the complete marked archive encode read", async () => {
  const current = fixture();
  const seeded = await seedEncodeClaim(current);
  const ownership = createArchiveImageOwnership({ authorityRootPath: current.originalsLibraryPath });
  let ownershipActive = false;
  let descriptor: number | undefined;
  const assertOwned = vi.fn(() => { expect(ownershipActive).toBe(true); });
  const guarded = { ...ownership, withConsistentRead: ((request: Parameters<typeof ownership.withConsistentRead>[0]) =>
    ownership.withConsistentRead({ ...request, task: async (handle) => {
      ownershipActive = true; descriptor = handle.descriptor;
      try { return await request.task({ ...handle, assertOwned() { handle.assertOwned(); assertOwned(); } }); }
      finally { ownershipActive = false; }
    } })) as typeof ownership.withConsistentRead };
  const runner = { run: vi.fn(async ({ outputPath, sourceOwnershipDescriptor }: HandBrakeRunRequest) => {
    expect(ownershipActive).toBe(true);
    expect(sourceOwnershipDescriptor).toBe(descriptor);
    writeFileSync(outputPath, "synthetic consistent encode", { flag: "wx" });
  }) };
  const scanner = { scan: vi.fn(async (_path: string, _title: number, _signal: AbortSignal, sourceOwnershipDescriptor?: number) => {
    expect(ownershipActive).toBe(true);
    expect(sourceOwnershipDescriptor).toBe(descriptor);
    return [];
  }) };
  try {
    await pollEncodeWorker({ ...current, access: seeded.access, concurrency: 1, log: () => {},
      signal: new AbortController().signal, archiveImageOwnership: guarded, runner, subtitleScanner: scanner,
      outputValidator: { prepareAndValidate: vi.fn(async () => {}) } });
    expect(runner.run).toHaveBeenCalledOnce();
    expect(scanner.scan).toHaveBeenCalledOnce();
    expect(assertOwned).toHaveBeenCalled();
    expect(ownershipActive).toBe(false);
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("completed");
    const snapshot = seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)[0]!;
    const inspected = await current.run(["encode-output", "inspect", encodeOutputArtifactIdentity(seeded.job.id)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 500, streams: [] }) });
    expect(inspected).toMatchObject({ exitCode: 0, result: { artifact: {
      provenance: { sourceSnapshotAvailability: "recorded", sourceSnapshot: JSON.parse(JSON.stringify(snapshot)) },
      validation: { recordIdentity: expect.any(String) },
    } } });
  } finally { seeded.access.close(); }
});
