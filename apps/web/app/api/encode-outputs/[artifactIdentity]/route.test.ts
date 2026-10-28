import { afterEach, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { encodeOutputArtifactIdentity, type EncodeOutputInspection } from "@rip-dvd/application";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputAcknowledgementRoute, createEncodeOutputInspectionRoute } from "./route";

const origin = "http://localhost:3000";
const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 90, streams: [] });

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
