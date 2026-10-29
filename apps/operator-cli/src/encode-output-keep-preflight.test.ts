import { afterEach, expect, it } from "vitest";
import { claimNextEncodeJob, type EncodeOutputKeepPreflight } from "@rip-dvd/application";
import { retainSyntheticFailedOutput } from "./encode-output-failed.test-support.js";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { encodeOutputArtifactIdentity, retainedEncodeOutputArtifactIdentity } from "@rip-dvd/application";
import { publishSyntheticClaim } from "./encode-output-provenance.test-support.js";
import { withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import {
  changeFailedCleanupOwnership, changeFailedOwnership, changeFailedValidation, changePredecessorValidation,
  denyFailedFileRead, disconnectKeepStorage, failedFileFaults,
  seedCorrectedKeepPreflightFixture, seedKeepPreflightFixture, unavailableKeepProbe,
} from "./encode-output-keep-preflight.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const failedProbe = async () => { throw new Error("Synthetic probe failure"); };

it("previews the exact complete failed output without recording acknowledgement or changing its job", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { access, job } = await seedEncodeClaim(fixture, { continuityRisk: true });
  try {
    const claim = (await claimNextEncodeJob(access, "synthetic-preflight-worker", fixture.originalsLibraryPath))!;
    const output = retainSyntheticFailedOutput(access, claim, fixture.mediaLibraryPath);
    const identity = `encode-output-v1.failed.${output.id}`;
    const before = access.encodeJobs.find(job.id);
    const result = await fixture.run(["encode-output", "keep-preflight", identity], undefined, undefined, { encodeOutputMediaProbe: failedProbe });
    expect(result.exitCode).toBe(0);
    const preview = result.result as EncodeOutputKeepPreflight;
    expect(preview).toMatchObject({ eligible: true, blockers: [], review: { status: "not_supplied" },
      artifact: { identity, state: "validation_failed", file: { completeness: "complete" }, validation: {
        result: "failed", recordIdentity: output.id, failure: { evidence: { kind: "duration", expectedSeconds: 500, observedSeconds: 10 } },
      }, provenance: { sourceSnapshot: { id: claim.claimToken } }, inspectability: { status: "unknown", reasonCode: "OUTPUT_PROBE_FAILED" } },
      current: { artifactIdentity: identity, validationIdentity: output.id, fileIdentity: output.filesystemIdentity, sourceSnapshotIdentity: claim.claimToken },
      normalDestination: { status: "absent", normalOutput: null },
      requiredAcknowledgement: { acknowledged: true, requiredInputs: ["artifactIdentity", "validationIdentity", "previewToken", "acknowledged", "mutationKey"] },
      completeWrite: { status: "verified", sha256: "7c4abd426916f2a3b8530ac82d54edd880ae32d764a2fe17d8e408a50355a250", recordedFileIdentity: output.filesystemIdentity },
      previewToken: expect.stringMatching(/^encode-output-keep-preview-v1\.[a-f0-9]{64}$/),
    });
    const again = await fixture.run(["encode-output", "keep-preflight", identity, "--json", JSON.stringify({ previewToken: preview.previewToken })],
      undefined, undefined, { encodeOutputMediaProbe: failedProbe });
    expect(again.result).toMatchObject({ ...preview, review: { status: "current", reasonCode: null } });
    expect(access.encodeJobs.find(job.id)).toEqual(before);
    expect(access.encodeOutputInspectionReceipts.list(job.id, { limit: 20, offset: 0 }).receipts).toEqual([]);
    expect(JSON.stringify(result.result)).not.toContain(fixture.mediaLibraryPath);
    expect(JSON.stringify(result.result)).not.toContain(fixture.originalsLibraryPath);
  } finally { access.close(); }
});

it("allows a stable complete failure with usable media metadata without promising playability", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const result = await seeded.preview(undefined, async () => ({ durationSeconds: 10, streams: [] }));
    expect(result.result).toMatchObject({ eligible: true, blockers: [], artifact: { inspectability: { status: "inspected" },
      media: { durationSeconds: 10, streams: [], playability: "not_assessed" } }, completeWrite: { status: "verified" } });
  } finally { seeded.access.close(); }
});

it("requires a new review when inspectability changes while the complete bytes stay the same", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const inspectedProbe = async () => ({ durationSeconds: 10, streams: [] });
    const reviewed = await seeded.preview(undefined, inspectedProbe);
    const stale = await seeded.preview(reviewed.result.previewToken!);
    expect(stale.result).toMatchObject({ eligible: false, previewToken: null, artifact: { inspectability: { status: "unknown" } },
      current: { fileIdentity: reviewed.result.current.fileIdentity }, review: { status: "stale" } });
    expect(stale.result.blockers.map(({ code }) => code)).toEqual(["KEEP_PREFLIGHT_STALE"]);
    const fresh = await seeded.preview();
    expect(fresh.result).toMatchObject({ eligible: true, blockers: [], artifact: { inspectability: { status: "unknown" } } });
  } finally { seeded.access.close(); }
});

it("accepts the same exact review through JSON, a file and stdin without accepting mutation options", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const initial = await seeded.preview();
    const body = JSON.stringify({ previewToken: initial.result.previewToken });
    const path = `${seeded.output.outputPath}.review.json`;
    writeFileSync(path, body);
    for (const [options, stdin] of [[ ["--json", body], undefined ], [ ["--file", path], undefined ], [ ["--stdin"], body ]] as const) {
      const result = await seeded.fixture.run(["encode-output", "keep-preflight", seeded.identity, ...options], undefined, stdin,
        { encodeOutputMediaProbe: unavailableKeepProbe });
      expect(result.exitCode).toBe(0);
      expect(result.result).toEqual({ ...initial.result, review: { status: "current", reasonCode: null } });
    }
    for (const options of [["--key", "synthetic-key"], ["--json", body, "--stdin"], ["--preview-token", initial.result.previewToken!], ["--json", "[]"], ["--json", "{"], ["--file", "synthetic-missing-input"]]) {
      const result = await seeded.fixture.run(["encode-output", "keep-preflight", seeded.identity, ...options]);
      expect(result.exitCode).not.toBe(0);
      expect(result.result).toMatchObject({ error: { code: expect.stringMatching(/^INVALID_(ARGUMENTS|INPUT)$/) } });
    }
  } finally { seeded.access.close(); }
});

it("withholds Keep for a published normal output", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic normal preflight input" });
  const result = await fixture.run(["encode-output", "keep-preflight", encodeOutputArtifactIdentity(predecessor.id)], undefined, undefined,
    { encodeOutputMediaProbe: unavailableKeepProbe });
  expect(result.exitCode).toBe(0);
  expect(result.result).toMatchObject({ eligible: false, previewToken: null, artifact: { state: "published" } });
  expect((result.result as EncodeOutputKeepPreflight).blockers.map(({ code }) => code)).toContain("OUTPUT_NOT_VALIDATION_FAILED");
});

it("withholds Keep for a retained normal output", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive, predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic retained normal preflight input" });
  const access = fixture.openAccess();
  try {
    const replacement = access.catalog.completeCatalogReviewWithReplacements(archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections",
      [{ predecessorEncodeJobId: predecessor.id, encodingProfileId: predecessor.encodingProfileId, outputPath: predecessor.outputPath }]).replacementEncodeJobs[0]!;
    publishSyntheticClaim(access, access.encodeJobs.claimNext("synthetic-retained-preflight-worker")!, true);
    const retained = access.encodeJobs.listRetainedOutputs([predecessor.id, replacement.id])[0]!;
    const result = await fixture.run(["encode-output", "keep-preflight", retainedEncodeOutputArtifactIdentity(retained.id)], undefined, undefined,
      { encodeOutputMediaProbe: unavailableKeepProbe });
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({ eligible: false, previewToken: null, artifact: { state: "retained" } });
    expect((result.result as EncodeOutputKeepPreflight).blockers.map(({ code }) => code)).toContain("OUTPUT_NOT_VALIDATION_FAILED");
  } finally { access.close(); }
});

for (const fault of failedFileFaults) {
  it(`withholds an actionable preview for ${fault.name} and returns current file evidence`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
    try {
      const reviewed = await seeded.preview();
      expect(reviewed.result.eligible).toBe(true);
      fault.change(seeded);
      const changed = await seeded.preview(reviewed.result.previewToken!);
      expect(changed.exitCode).toBe(0);
      expect(changed.result).toMatchObject({ eligible: false, previewToken: null, completeWrite: { status: "unknown", sha256: null },
        current: { artifactIdentity: seeded.identity, validationIdentity: seeded.output.id }, review: { status: "stale" } });
      expect(changed.result.blockers.map(({ code }) => code)).toContain(fault.code);
      expect(changed.result.blockers.map(({ code }) => code)).toContain("KEEP_PREFLIGHT_STALE");
      expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
      expect(seeded.access.encodeOutputInspectionReceipts.list(seeded.job.id, { limit: 1, offset: 0 }).receipts).toEqual([]);
      expect(JSON.stringify(changed.result)).not.toContain(seeded.fixture.mediaLibraryPath);
    } finally { seeded.access.close(); }
  });
}

it.skipIf(process.getuid?.() === 0)("reports an actual failed-file permission fault as unavailable storage", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await seeded.preview();
    denyFailedFileRead(seeded);
    const changed = await seeded.preview(reviewed.result.previewToken!);
    expect(changed.result).toMatchObject({ eligible: false, previewToken: null, completeWrite: { status: "unknown", sha256: null } });
    expect(changed.result.blockers.map(({ code }) => code)).toContain("OUTPUT_FILE_UNAVAILABLE");
    expect(JSON.stringify(changed.result)).not.toContain(seeded.output.outputPath);
  } finally { chmodSync(seeded.output.outputPath, 0o600); seeded.access.close(); }
});

it("does not mistake an unavailable storage directory for an empty normal destination", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await seeded.preview();
    disconnectKeepStorage(seeded);
    const changed = await seeded.preview(reviewed.result.previewToken!);
    expect(changed.result).toMatchObject({ eligible: false, previewToken: null, normalDestination: { status: "unknown", fileIdentity: null },
      completeWrite: { status: "unknown", sha256: null }, current: { fileIdentity: null } });
    expect(changed.result.blockers.map(({ code }) => code)).toContain("DESTINATION_EVIDENCE_UNAVAILABLE");
  } finally { seeded.access.close(); }
});

it("binds exact validation evidence while keeping a stable complete file inspectable", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await seeded.preview();
    changeFailedValidation(seeded);
    const changed = await seeded.preview(reviewed.result.previewToken!);
    expect(changed.result).toMatchObject({ eligible: false, previewToken: null, review: { status: "stale", reasonCode: "KEEP_PREFLIGHT_STALE" },
      current: { fileIdentity: reviewed.result.current.fileIdentity, validationIdentity: seeded.output.id },
      artifact: { validation: { failure: { evidence: { kind: "duration", observedSeconds: 11 } } } }, completeWrite: { status: "verified" } });
    expect(changed.result.blockers.map(({ code }) => code)).toEqual(["KEEP_PREFLIGHT_STALE"]);
    const fresh = await seeded.preview();
    expect(fresh.result.eligible).toBe(true);
    expect(fresh.result.previewToken).not.toBe(reviewed.result.previewToken);
  } finally { seeded.access.close(); }
});

it("reports lost file ownership before stale review evidence", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await seeded.preview();
    changeFailedOwnership(seeded);
    const changed = await seeded.preview(reviewed.result.previewToken!);
    expect(changed.result).toMatchObject({ eligible: false, previewToken: null, current: { fileIdentity: reviewed.result.current.fileIdentity } });
    expect(changed.result.blockers.map(({ code }) => code)).toEqual(["OUTPUT_OWNERSHIP_LOST", "KEEP_PREFLIGHT_STALE"]);
  } finally { seeded.access.close(); }
});

it("withholds Keep when cleanup has claimed the failed file", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await seeded.preview();
    changeFailedCleanupOwnership(seeded);
    const result = await seeded.preview(reviewed.result.previewToken!);
    expect(result.result).toMatchObject({ eligible: false, previewToken: null });
    expect(result.result.blockers.map(({ code }) => code)).toContain("OUTPUT_OWNERSHIP_LOST");
    expect(result.result.current.fileAuthority.cleanupEncodeJobId).toBe(seeded.job.id);
  } finally { seeded.access.close(); }
});

it("names a coexisting normal output and binds destination evidence without replacing its bytes", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { access, job, expectedSourceDecision } = await seedEncodeClaim(fixture, { clean: true });
  try {
    const firstClaim = (await claimNextEncodeJob(access, "synthetic-normal-preflight-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(access, firstClaim);
    const normalBytes = readFileSync(job.outputPath);
    access.encodeJobs.requeue(job.id, { expectedSourceDecision });
    const failedClaim = (await claimNextEncodeJob(access, "synthetic-coexisting-preflight-worker", fixture.originalsLibraryPath))!;
    const output = retainSyntheticFailedOutput(access, failedClaim, fixture.mediaLibraryPath);
    const identity = `encode-output-v1.failed.${output.id}`;
    const run = async (token?: string) => (await fixture.run(["encode-output", "keep-preflight", identity,
      ...(token === undefined ? [] : ["--json", JSON.stringify({ previewToken: token })])], undefined, undefined,
    { encodeOutputMediaProbe: unavailableKeepProbe })).result as EncodeOutputKeepPreflight;
    const reviewed = await run();
    expect(reviewed).toMatchObject({ eligible: true, artifact: { encodeJob: { status: "failed" } }, normalDestination: {
      status: "present", fileIdentity: expect.any(String), normalOutput: { artifactIdentity: encodeOutputArtifactIdentity(job.id), encodeJobId: job.id, validationResult: "passed" },
    } });
    expect(readFileSync(job.outputPath)).toEqual(normalBytes);
    writeFileSync(job.outputPath, "synthetic changed normal destination");
    const stale = await run(reviewed.previewToken!);
    expect(stale).toMatchObject({ eligible: false, previewToken: null, review: { status: "stale" }, normalDestination: { status: "present" } });
    expect(stale.current.destinationRevision).not.toBe(reviewed.current.destinationRevision);
    expect(stale.blockers.map(({ code }) => code)).toEqual(["KEEP_PREFLIGHT_STALE"]);
    expect(access.encodeJobs.find(job.id)?.status).toBe("failed");
  } finally { access.close(); }
});

it("identifies the published predecessor when a failed correction reserves its unchanged normal destination", async () => {
  const seeded = await seedCorrectedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    expect(seeded.claim.id).toBe(seeded.job.id);
    const jobBefore = seeded.access.encodeJobs.find(seeded.job.id);
    expect(jobBefore).toMatchObject({ status: "failed", completedAt: null, predecessorEncodeJobId: seeded.predecessor.id, reservesOutputPath: true });
    const normalBefore = readFileSync(seeded.predecessor.outputPath);
    const failedBefore = readFileSync(seeded.output.outputPath);
    const recordBefore = seeded.access.encodeJobs.findValidationFailedOutput(seeded.output.id);
    const reviewed = await seeded.preview();
    expect(reviewed.exitCode).toBe(0);
    expect(reviewed.result).toMatchObject({ eligible: true, blockers: [], normalDestination: {
      status: "present", normalOutput: { encodeJobId: seeded.predecessor.id,
        artifactIdentity: encodeOutputArtifactIdentity(seeded.predecessor.id), validationIdentity: seeded.normalValidation.id,
        fileIdentity: seeded.normalValidation.filesystemIdentity, validationResult: "passed" },
    }, artifact: { encodeJob: { id: seeded.job.id, status: "failed", completedAt: null } } });
    changePredecessorValidation(seeded);
    const stale = await seeded.preview(reviewed.result.previewToken!);
    expect(stale.result).toMatchObject({ eligible: false, previewToken: null, review: { status: "stale" },
      current: { artifactIdentity: seeded.identity, validationIdentity: seeded.output.id,
        fileIdentity: reviewed.result.current.fileIdentity, authorityRevision: reviewed.result.current.authorityRevision },
      normalDestination: { fileIdentity: reviewed.result.normalDestination.fileIdentity,
        normalOutput: { encodeJobId: seeded.predecessor.id, validationIdentity: seeded.normalValidation.id } } });
    expect(stale.result.blockers.map(({ code }) => code)).toEqual(["KEEP_PREFLIGHT_STALE"]);
    expect(stale.result.current.destinationRevision).not.toBe(reviewed.result.current.destinationRevision);
    const fresh = await seeded.preview();
    expect(fresh.result).toMatchObject({ eligible: true, blockers: [], normalDestination: { normalOutput: { encodeJobId: seeded.predecessor.id } } });
    expect(readFileSync(seeded.predecessor.outputPath)).toEqual(normalBefore);
    expect(readFileSync(seeded.output.outputPath)).toEqual(failedBefore);
    expect(seeded.access.encodeJobs.find(seeded.job.id)).toEqual(jobBefore);
    expect(seeded.access.encodeJobs.findValidationFailedOutput(seeded.output.id)).toEqual(recordBefore);
    expect(seeded.access.encodeOutputInspectionReceipts.list(seeded.job.id, { limit: 1, offset: 0 }).receipts).toEqual([]);
    expect(JSON.stringify(fresh.result)).not.toContain(seeded.fixture.mediaLibraryPath);
  } finally { seeded.access.close(); }
});

for (const [name, change, expected] of [
  ["file", (seeded: Awaited<ReturnType<typeof seedKeepPreflightFixture>>) => failedFileFaults[0].change(seeded), "OUTPUT_IDENTITY_CHANGED"],
  ["validation", changeFailedValidation, "OUTPUT_AUTHORITY_CHANGED"],
  ["ownership", changeFailedOwnership, "OUTPUT_OWNERSHIP_LOST"],
] as const) {
  it(`refuses evidence changed during a ${name} probe without mutating workflow state`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
    try {
      const result = await seeded.preview(undefined, async () => { change(seeded); return { durationSeconds: 10, streams: [] }; });
      expect(result.result).toMatchObject({ eligible: false, previewToken: null });
      expect(result.result.blockers.map(({ code }) => code)).toContain(expected);
      expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
      expect(seeded.access.encodeOutputInspectionReceipts.list(seeded.job.id, { limit: 1, offset: 0 }).receipts).toEqual([]);
    } finally { seeded.access.close(); }
  });
}

it("reports every combined blocker in stable priority order", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await seeded.preview();
    changeFailedOwnership(seeded);
    failedFileFaults[2].change(seeded);
    const first = await seeded.preview(reviewed.result.previewToken!);
    const second = await seeded.preview(reviewed.result.previewToken!);
    const codes = first.result.blockers.map(({ code }) => code);
    expect(codes[0]).toBe("OUTPUT_OWNERSHIP_LOST");
    expect(codes).toContain("OUTPUT_INCOMPLETE");
    expect(codes).toContain("OUTPUT_EMPTY");
    expect(codes.at(-1)).toBe("KEEP_PREFLIGHT_STALE");
    expect(second.result).toEqual(first.result);
  } finally { seeded.access.close(); }
});

it("does not invent immutable source evidence for a historical failed artifact", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    withEvidenceGuardsDisabled(seeded.fixture.databasePath, (database) => {
      database.prepare("UPDATE validation_failed_encode_outputs SET source_snapshot = NULL WHERE id = ?").run(seeded.output.id);
    });
    const result = await seeded.preview();
    expect(result.result).toMatchObject({ artifact: { provenance: { sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" } },
      current: { sourceSnapshotIdentity: null } });
  } finally { seeded.access.close(); }
});

it("rejects malformed identities, input fields and tokens through the public command", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    for (const input of [{ previewToken: "not-a-token" }, { acknowledged: true }, { previewToken: null }, { mutationKey: "synthetic-key" }]) {
      const result = await seeded.fixture.run(["encode-output", "keep-preflight", seeded.identity, "--json", JSON.stringify(input)]);
      expect(result.exitCode).not.toBe(0);
      expect(result.result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    }
    const malformed = await seeded.fixture.run(["encode-output", "keep-preflight", "synthetic-invalid-identity"]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    const missing = await seeded.fixture.run(["encode-output", "keep-preflight", "encode-output-v1.failed.00000000-0000-4000-8000-000000000000"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.result).toMatchObject({ error: { code: "ENCODE_OUTPUT_NOT_FOUND" } });
  } finally { seeded.access.close(); }
});
