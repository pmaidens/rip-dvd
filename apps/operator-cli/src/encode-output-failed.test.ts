import { afterEach, expect, it } from "vitest";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimNextEncodeJob, encodeOutputArtifactIdentity, type EncodeOutputInspection } from "@rip-dvd/application";
import { retainSyntheticFailedOutput } from "./encode-output-failed.test-support.js";
import { publishSyntheticClaim } from "./encode-output-provenance.test-support.js";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedFailedCorrespondenceOutput } from "./encode-output-correspondence.test-support.js";
import type { EncodeOutputIntervalInspection } from "@rip-dvd/application";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => { throw new Error("Synthetic unavailable media probe"); };

it("keeps an inspected failed artifact's frozen interval evidence unknown through a later normal generation", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedFailedCorrespondenceOutput(fixture);
  const query = () => fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
    undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 500, streams: [] }) });
  try {
    const first = await query();
    expect(first).toMatchObject({ exitCode: 0, result: {
      inspection: { artifact: { state: "validation_failed", validation: { result: "failed" },
        file: { completeness: "complete" }, inspectability: { status: "inspected" }, availableActions: [{ name: "export", eligible: true }] } },
      intervals: [{ status: "unknown", reasonCode: "OUTPUT_TIMING_UNSUPPORTED", outputInterval: null,
        evidence: { claimSnapshotId: seeded.claim.claimToken, measuredCorrespondence: null } }],
      targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" },
    } });
    seeded.access.encodeJobs.requeue(seeded.claim.id, { expectedSourceDecision: seeded.snapshot.source.decision });
    const next = (await claimNextEncodeJob(seeded.access, "synthetic-later-normal-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(seeded.access, next);
    const after = await query();
    expect(after.exitCode).toBe(0);
    expect((after.result as EncodeOutputIntervalInspection).intervals).toEqual((first.result as EncodeOutputIntervalInspection).intervals);
  } finally { seeded.access.close(); }
});

it("inspects and exports a complete failed generation without promising playback or Keep", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { continuityRisk: true });
  const { access } = seeded;
  try {
    const claim = (await claimNextEncodeJob(access, "synthetic-failed-output-worker", fixture.originalsLibraryPath))!;
    const retained = retainSyntheticFailedOutput(access, claim, fixture.mediaLibraryPath);
    const path = retained.outputPath;
    const summaries = access.readConsistentSnapshot((snapshot) => {
      expect(snapshot.encodeJobs).not.toHaveProperty("listValidationFailedOutputs");
      return snapshot.encodeJobs.listValidationFailedOutputSummaries(claim.id, { limit: 1 });
    });
    expect(summaries).toEqual([{ id: retained.id, encodeJobId: claim.id }]);
    const listed = await fixture.run(["inspect", "encode-jobs", claim.id]);
    expect(listed.exitCode).toBe(0);
    const artifacts = (listed.result as { item: { encodeOutputArtifacts: { identity: string; state: string }[] } }).item.encodeOutputArtifacts;
    expect(artifacts).toEqual([{ identity: expect.stringMatching(/^encode-output-v1.failed\./), state: "validation_failed" }]);
    const identity = artifacts[0]!.identity;
    const inspect = async () => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
    const inspected = await inspect();
    expect(inspected.artifact).toMatchObject({ state: "validation_failed", encodeJob: { status: "failed" },
      validation: { result: "failed", recordedResult: "failed", failure: { evidence: { kind: "duration", observedSeconds: 10 } } },
      file: { completeness: "complete", identityContinuity: "verified" },
      provenance: { sourceSnapshot: { id: claim.claimToken, source: { sourceContinuityRisk: true } } },
      inspectability: { status: "unknown", reasonCode: "OUTPUT_PROBE_FAILED" }, media: { playability: "not_assessed" } });
    expect(JSON.stringify(inspected)).not.toContain(fixture.mediaLibraryPath);
    expect(inspected.artifact.validation.failure?.diagnostic).toBe("Encode Output duration validation failed.");
    expect(retained.failure.diagnostic).toContain(path);
    expect(inspected.operatorInspection.history).toEqual([]);
    const source = inspected.artifact.provenance.sourceSnapshot!.source;
    const intervals = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify({
      assessmentIdentity: source.assessment.id, titleIdentityObservationId: source.titleIdentity.id, intervalIndexes: [0],
    })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(intervals).toMatchObject({ exitCode: 0, result: {
      inspection: { artifact: { state: "validation_failed", validation: { result: "failed" } } },
      intervals: [{ status: "unknown", outputInterval: null, reasonCode: "OUTPUT_INSPECTION_UNAVAILABLE" }],
      targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" },
    } });
    const destination = join(fixture.operatorHostPath, "failed-export.mkv");
    expect((await fixture.run(["encode-output", "export", identity, "--destination", destination])).exitCode).toBe(0);
    expect(readFileSync(destination, "utf8")).toBe("synthetic complete failed encode");
    const args = ["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-failed-receipt", "--json",
      JSON.stringify({ acknowledged: true, reviewToken: inspected.operatorInspection.reviewToken })];
    const receipt = await fixture.run(args, undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(receipt.exitCode).toBe(0);
    expect(JSON.stringify(receipt.result)).not.toContain(fixture.mediaLibraryPath);
    expect(receipt.result).toMatchObject({ receipt: { evidence: { state: "validation_failed", validation: { result: "failed" } } } });
    expect((await fixture.run(args)).result).toEqual(receipt.result);
    expect((await inspect()).operatorInspection.status).toBe("acknowledged");
    const changed = `${path}.changed`;
    writeFileSync(changed, "synthetic different bytes"); renameSync(changed, path);
    const stale = await inspect();
    expect(stale.artifact.file.completeness).toBe("unknown");
    expect(stale.operatorInspection.acknowledgement.eligible).toBe(false);
    expect(stale.artifact.validation).toMatchObject({ recordedResult: "failed", failure: { evidence: { kind: "duration" } } });
    expect((await fixture.run(["encode-output", "export", identity, "--destination", `${destination}.changed`])).exitCode).not.toBe(0);
  } finally { access.close(); }
});

it("pages immutable failed generations through requeue and keeps their receipts separate from normal output", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { clean: true });
  const { access } = seeded;
  const options = { encodeOutputMediaProbe: async () => ({ durationSeconds: 10, streams: [] }) };
  const inspect = async (identity: string) => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options)).result as EncodeOutputInspection;
  try {
    const firstClaim = (await claimNextEncodeJob(access, "synthetic-failed-history-worker", fixture.originalsLibraryPath))!;
    const first = retainSyntheticFailedOutput(access, firstClaim, fixture.mediaLibraryPath);
    const identity = `encode-output-v1.failed.${first.id}`;
    const reviewed = await inspect(identity);
    expect(reviewed.artifact).toMatchObject({ validation: { result: "failed" }, inspectability: { status: "inspected" }, media: { playability: "not_assessed" } });
    const receipt = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-history-failed-receipt", "--json",
      JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, options);
    expect(receipt.exitCode).toBe(0);
    access.encodeJobs.requeue(seeded.job.id, { expectedSourceDecision: seeded.expectedSourceDecision });
    const next = (await claimNextEncodeJob(access, "synthetic-failed-history-worker", fixture.originalsLibraryPath))!;
    const second = retainSyntheticFailedOutput(access, next, fixture.mediaLibraryPath);
    for (const [offset, output, nextOffset] of [[0, second, 1], [1, first, null]] as const) {
      const result = await fixture.run(["inspect", "encode-jobs", seeded.job.id, "--limit", "1", "--offset", String(offset)]);
      expect(result.exitCode).toBe(0);
      expect(result.result).toMatchObject({ item: { encodeOutputArtifacts: [{ identity: `encode-output-v1.failed.${output.id}`, state: "validation_failed" }],
        encodeOutputArtifactPage: { nextOffset } } });
    }
    access.encodeJobs.requeue(seeded.job.id, { expectedSourceDecision: seeded.expectedSourceDecision });
    const normalClaim = (await claimNextEncodeJob(access, "synthetic-normal-history-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(access, normalClaim);
    const normal = await inspect(encodeOutputArtifactIdentity(seeded.job.id));
    expect(normal.artifact.state).toBe("published");
    expect(normal.operatorInspection).toMatchObject({ status: "not_acknowledged", receipts: [], history: [(receipt.result as { receipt: unknown }).receipt] });
    expect(normal.operatorInspection.generationIdentity).not.toBe(reviewed.operatorInspection.generationIdentity);
    const old = await inspect(identity);
    expect(old.artifact.provenance.sourceSnapshot?.id).toBe(firstClaim.claimToken);
    expect(old.artifact.validation).toEqual(reviewed.artifact.validation);
    expect(old.operatorInspection.status).toBe("acknowledged");
    expect((await fixture.run(["encode-output", "inspect", `encode-output-v1.failed.${seeded.job.id}`])).exitCode).not.toBe(0);
  } finally { access.close(); }
});
