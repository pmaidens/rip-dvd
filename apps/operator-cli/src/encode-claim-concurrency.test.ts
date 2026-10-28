import { encodeContender } from "./encode-concurrency.test-support.js";
import { recordSyntheticRecoveryStorage } from "./encode-source-decision.test-support.js";
import { afterEach, expect, it } from "vitest";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

const contender = (data: Record<string, unknown>) => encodeContender(new URL("../test/encode-claim-concurrency-worker.mjs", import.meta.url), data);

it.each(["claim-first", "withdraw-first"])("serializes acceptance withdrawal and claim at the exact transaction boundary, %s", async (order) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, {});
  const preview = (await fixture.run(["catalog-review", "preview-withdrawal", seeded.archive.id,
    "--accepted-decision-id", seeded.expectedSourceDecision.acceptanceIdentity!])).result as { previewToken: string };
  const common = { databasePath: fixture.databasePath, originalsLibraryPath: fixture.originalsLibraryPath,
    mediaLibraryPath: fixture.mediaLibraryPath, order, barrier: new SharedArrayBuffer(4) };
  const claim = contender({ ...common, role: "claim" });
  let withdrawal: ReturnType<typeof contender> | undefined;
  try {
    await claim.event("held");
    withdrawal = contender({ ...common, role: "withdraw", input: {
      originalDiscArchiveId: seeded.archive.id, acceptedDecisionId: seeded.expectedSourceDecision.acceptanceIdentity,
      mutationKey: "synthetic-racing-withdrawal", operator: "Synthetic operator", previewToken: preview.previewToken,
    } });
    await withdrawal.event("attempt");
    if (order === "withdraw-first") expect(await withdrawal.result).toMatchObject({ outcome: "withdrawn" });
    Atomics.store(new Int32Array(common.barrier), 0, 1); Atomics.notify(new Int32Array(common.barrier), 0);
    const [claimed, withdrawn] = await Promise.all([claim.result, withdrawal.result]);
    expect(withdrawn.outcome).toBe("withdrawn");
    expect(claimed.outcome).toBe(order === "claim-first" ? "running" : "unclaimed");
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe(order === "claim-first" ? "running" : "queued");
    const snapshots = seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id);
    expect(snapshots).toHaveLength(order === "claim-first" ? 1 : 0);
    if (order === "claim-first") expect(snapshots[0]?.source.acceptance?.id).toBe(seeded.expectedSourceDecision.acceptanceIdentity);
    const recovery = seeded.access.catalog.findArchiveRecovery(seeded.archive.id)!;
    recordSyntheticRecoveryStorage(seeded.access);
    expect(() => seeded.access.archiveRecoveryWork.requestResume({ archiveRecoveryId: recovery.id, attemptId: recovery.attemptId,
      mutationKey: "synthetic-claim-resume", checkpointRevision: seeded.expectedSourceDecision.checkpoint!.revision,
      checkpointDigest: seeded.expectedSourceDecision.checkpoint!.manifestDigest, speedMode: "normal" })).toThrow(expect.objectContaining({ code: "ENCODE_WORK_CONFLICT" }));
  } finally { await claim.terminate(); await withdrawal?.terminate(); seeded.access.close(); }
}, 30_000);

it.each(["claim-first", "resume-first"])("excludes Recovery Resume across a prepared claim transaction, %s", async (order) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture);
  recordSyntheticRecoveryStorage(seeded.access);
  const recovery = seeded.access.catalog.findArchiveRecovery(seeded.archive.id)!;
  const common = { databasePath: fixture.databasePath, originalsLibraryPath: fixture.originalsLibraryPath,
    mediaLibraryPath: fixture.mediaLibraryPath, order: order === "claim-first" ? "claim-first" : "withdraw-first", barrier: new SharedArrayBuffer(4) };
  const claim = contender({ ...common, role: "claim" });
  let resume: ReturnType<typeof contender> | undefined;
  try {
    await claim.event("held");
    resume = contender({ ...common, role: "resume", input: { archiveRecoveryId: recovery.id, attemptId: recovery.attemptId,
      mutationKey: "synthetic-prepared-claim-resume", checkpointRevision: seeded.expectedSourceDecision.checkpoint!.revision,
      checkpointDigest: seeded.expectedSourceDecision.checkpoint!.manifestDigest, speedMode: "normal" } });
    await resume.event("attempt");
    if (order === "resume-first") expect(await resume.result).toMatchObject({ outcome: "rejected", code: "ENCODE_WORK_CONFLICT" });
    Atomics.store(new Int32Array(common.barrier), 0, 1); Atomics.notify(new Int32Array(common.barrier), 0);
    expect(await claim.result).toMatchObject({ outcome: "running" });
    expect(await resume.result).toMatchObject({ outcome: "rejected", code: "ENCODE_WORK_CONFLICT" });
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("running");
    expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toHaveLength(1);
    expect(seeded.access.catalog.findArchiveRecovery(seeded.archive.id)?.work).toBeNull();
  } finally { await claim.terminate(); await resume?.terminate(); seeded.access.close(); }
}, 30_000);
