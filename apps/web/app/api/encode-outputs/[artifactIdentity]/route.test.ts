import { afterEach, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { claimNextEncodeJob, encodeOutputArtifactIdentity, retainedEncodeOutputArtifactIdentity, type EncodeOutputInspection } from "@rip-dvd/application";
import { seedEncodeClaim, withdrawClaimAcceptance } from "../../../../../operator-cli/src/encode-claim.test-support.js";
import { publishSyntheticClaim, seedMixedCoverageOutput } from "../../../../../operator-cli/src/encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputAcknowledgementRoute, createEncodeOutputInspectionRoute } from "./route";

const origin = "http://localhost:3000";
const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 90, streams: [] });

it("shares unknown-impact reasons with a complete selected map and omits private paths", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedMixedCoverageOutput(fixture);
  const identity = encodeOutputArtifactIdentity(seeded.job.id);
  const access = fixture.openAccess();
  try {
    const response = await createEncodeOutputInspectionRoute(new Request(`${origin}/api/encode-outputs/${identity}`), identity, () => access, probe);
    const cli = await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(response.status).toBe(200);
    const web = await response.json();
    expect(cli.result).toEqual(web);
    expect(web).toMatchObject({ artifact: { sourceDamage: { knownSourceDamage: false, unknownImpact: true, watchability: "not_assessed" } } });
    expect(JSON.stringify(web)).not.toContain(fixture.originalsLibraryPath);
    expect(JSON.stringify(web)).not.toContain(fixture.mediaLibraryPath);
  } finally { access.close(); }
});

it("shares retained replacement inspection and keeps historical source evidence unknown", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive, predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic historical HTTP replacement" });
  const access = fixture.openAccess();
  try {
    const replacement = access.catalog.completeCatalogReviewWithReplacements(archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections",
      [{ predecessorEncodeJobId: predecessor.id, encodingProfileId: predecessor.encodingProfileId, outputPath: predecessor.outputPath }]).replacementEncodeJobs[0]!;
    publishSyntheticClaim(access, access.encodeJobs.claimNext("synthetic-retained-http-worker")!, true);
    const retained = access.encodeJobs.listRetainedOutputs([predecessor.id, replacement.id])[0]!;
    for (const identity of [retainedEncodeOutputArtifactIdentity(retained.id), encodeOutputArtifactIdentity(replacement.id)]) {
      const web = await createEncodeOutputInspectionRoute(new Request(`${origin}/api/encode-outputs/${identity}`), identity, () => access, probe);
      const cli = await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe });
      expect(web.status).toBe(200);
      expect(cli.exitCode).toBe(0);
      expect(await web.json()).toEqual(cli.result);
      expect(cli.result).toMatchObject({ artifact: { provenance: { sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" },
        sourceDamage: { unknownImpact: true, watchability: "not_assessed" } } });
    }
  } finally { access.close(); }
});

it("shares recorded source/validation evidence through requeue and preserves receipts after later withdrawal", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { continuityRisk: true });
  const { access } = seeded;
  const identity = encodeOutputArtifactIdentity(seeded.job.id);
  const parity = async () => {
    const web = await createEncodeOutputInspectionRoute(new Request(`${origin}/api/encode-outputs/${identity}`), identity, () => access, probe);
    const cli = await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(web.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    const result = await web.json() as EncodeOutputInspection;
    expect(cli.result).toEqual(result);
    return result;
  };
  try {
    const claim = (await claimNextEncodeJob(access, "synthetic-http-source-worker", fixture.originalsLibraryPath))!;
    const validation = publishSyntheticClaim(access, claim);
    const first = await parity();
    expect(first.artifact).toMatchObject({ validation: { recordIdentity: validation.id }, provenance: {
      sourceSnapshotAvailability: "recorded", sourceSnapshot: { id: claim.claimToken,
        source: { sourceContinuityRisk: true, acceptance: { decision: "accepted" } } },
    } });
    const body = { acknowledged: true, reviewToken: first.operatorInspection.reviewToken, mutationKey: "synthetic-source-http-receipt" };
    const response = await createEncodeOutputAcknowledgementRoute(request(identity, body), identity, () => access, () => origin, probe);
    expect(response.status).toBe(200);
    const receipt = (await response.json() as { receipt: unknown }).receipt;
    access.encodeJobs.requeue(claim.id, { expectedSourceDecision: seeded.expectedSourceDecision });
    const next = (await claimNextEncodeJob(access, "synthetic-http-retry-worker", fixture.originalsLibraryPath))!;
    expect((await parity()).artifact.provenance).toEqual(first.artifact.provenance);
    access.encodeJobs.fail(next, "Synthetic retry stopped before publication", { preserveReplacementAuthority: true });
    await withdrawClaimAcceptance(fixture, seeded.archive.id, seeded.expectedSourceDecision.acceptanceIdentity!);
    expect((await parity()).operatorInspection.history).toEqual([receipt]);
    expect((await parity()).artifact.provenance).toEqual(first.artifact.provenance);
  } finally { access.close(); }
});

function request(identity: string, body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/encode-outputs/${identity}`, {
    method: "POST", headers: { "Content-Type": "application/json", Host: "localhost:3000", Origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

it("shares acknowledgement, replay, conflict and stale evidence results with the JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic HTTP receipt output" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const access = fixture.openAccess();
  try {
    const inspection = await createEncodeOutputInspectionRoute(new Request(`${origin}/api/encode-outputs/${identity}`), identity, () => access, probe);
    const reviewed = await inspection.json() as EncodeOutputInspection;
    expect(reviewed.operatorInspection.history).toEqual([]);
    const body = { acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken, mutationKey: "synthetic-http-receipt-key" };
    const web = await createEncodeOutputAcknowledgementRoute(request(identity, body), identity, () => access, () => origin, probe);
    expect(web.status).toBe(200);
    expect(web.headers.get("Cache-Control")).toBe("no-store");
    const cli = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", body.mutationKey, "--json",
      JSON.stringify({ acknowledged: true, reviewToken: body.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await web.json());
    const webPage = await createEncodeOutputInspectionRoute(new Request(`${origin}/api/encode-outputs/${identity}?receipt-limit=1&receipt-offset=1`), identity, () => access, probe);
    const cliPage = await fixture.run(["encode-output", "inspect", identity, "--receipt-limit", "1", "--receipt-offset", "1"], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(cliPage.exitCode).toBe(0);
    expect(cliPage.result).toEqual(await webPage.json());
    expect(cliPage.result).toMatchObject({ operatorInspection: { history: [], receipts: [expect.any(Object)], historyNextOffset: null } });
    const changed = { ...body, reviewToken: "0".repeat(64) };
    const conflict = await createEncodeOutputAcknowledgementRoute(request(identity, changed), identity, () => access, () => origin, probe);
    const cliConflict = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", body.mutationKey, "--json", JSON.stringify({ acknowledged: true, reviewToken: changed.reviewToken })]);
    expect(conflict.status).toBe(409);
    expect(cliConflict.result).toEqual(await conflict.json());
    writeFileSync(predecessor.outputPath, "synthetic changed parity bytes");
    const staleBody = { ...body, mutationKey: "synthetic-stale-http-receipt" };
    const stale = await createEncodeOutputAcknowledgementRoute(request(identity, staleBody), identity, () => access, () => origin, probe);
    const cliStale = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", staleBody.mutationKey, "--json",
      JSON.stringify({ acknowledged: true, reviewToken: body.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(stale.status).toBe(409);
    expect(cliStale.result).toEqual(await stale.json());
  } finally { access.close(); }
});

it("requires a trusted mutation request and explicit acknowledgement before opening persistence", async () => {
  const identity = `encode-output-v1.published.${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
  const forbidden = await createEncodeOutputAcknowledgementRoute(request(identity, {}, "https://untrusted.example"), identity,
    () => { throw new Error("Must not open persistence"); }, () => origin);
  expect(forbidden.status).toBe(403);
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const access = fixture.openAccess();
  try {
    const invalid = await createEncodeOutputAcknowledgementRoute(request(identity, { acknowledged: false }), identity, () => access, () => origin);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  } finally { access.close(); }
});
