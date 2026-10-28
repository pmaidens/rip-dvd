import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EncodingReadiness } from "@rip-dvd/application";
import { seedEncodingReadiness } from "../../../../operator-cli/src/encoding-readiness.test-support";
import { openEncodeSourceTestAccess } from "../../../../operator-cli/src/encode-source-decision.test-support";
import { createOperatorWorkflowFixture } from "../../../../operator-cli/src/operator-workflow.test-support";
import { createEncodeJobsRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it.each(["current", "stale", "missing", "blocked"])("matches public enqueue JSON and HTTP rejection for %s evidence", async (kind) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: kind !== "blocked" });
  const readiness = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  const expectedSourceDecision = kind === "missing" ? undefined : kind === "stale"
    ? { ...readiness.selections[0]!.expectedSourceDecision, assessmentIdentity: "synthetic-old-assessment" }
    : readiness.selections[0]!.expectedSourceDecision;
  const input = { discSelectionId: seeded.selection.id, encodingProfileId: seeded.profile.id,
    outputPath: join(fixture.mediaLibraryPath, "synthetic-parity.mkv"), mutationKey: "synthetic-http-parity", expectedSourceDecision };
  const cli = await fixture.run(["encode-enqueue", "--key", input.mutationKey,
    "--disc-selection-id", input.discSelectionId, "--encoding-profile-id", input.encodingProfileId,
    "--output-path", input.outputPath, ...(expectedSourceDecision === undefined ? [] : ["--source-decision", JSON.stringify(expectedSourceDecision)])]);
  const access = fixture.openAccess();
  try {
    const response = await createEncodeJobsRoute(new Request("http://localhost/api/encode-jobs", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", Host: "localhost" }, body: JSON.stringify(input),
    }), () => access, () => ({ ...fixture, webTrustedOrigin: "http://localhost", Host: "localhost" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(cli.result);
    expect(cli.exitCode).toBe(2);
    expect(access.encodeJobs.listForDiscSelection(seeded.selection.id)).toEqual([]);
  } finally { access.close(); }
});

it("matches requeue preview and stale requeue identities across both adapters", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  const access = fixture.openAccess();
  access.catalog.completeCatalogReview(seeded.archive.id, access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  access.close();
  const expected = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
  const queued = await fixture.run(["encode-enqueue", "--key", "synthetic-preview-job", "--disc-selection-id", seeded.selection.id,
    "--encoding-profile-id", seeded.profile.id, "--output-path", join(fixture.mediaLibraryPath, "synthetic-preview.mkv"), "--source-decision", JSON.stringify(expected)],
  undefined, undefined, { openAccess: () => openEncodeSourceTestAccess(fixture) });
  expect(queued.exitCode).toBe(0);
  const id = (queued.result as { job: { id: string } }).job.id;
  await fixture.run(["encode-cancel", "--key", "synthetic-preview-cancel", "--encode-job-id", id]);
  const cliPreview = await fixture.run(["encode-requeue-preview", "--encode-job-id", id]);
  const observer = fixture.openAccess();
  try {
    const post = (body: unknown) => createEncodeJobsRoute(new Request("http://localhost/api/encode-jobs", {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: "http://localhost", Host: "localhost" }, body: JSON.stringify(body),
    }), () => observer, () => ({ ...fixture, webTrustedOrigin: "http://localhost", Host: "localhost" }));
    const preview = await post({ encodeJobId: id, action: "preview_requeue" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ preview: cliPreview.result });
    for (const expectedSourceDecision of [undefined, { ...expected, assessmentIdentity: "synthetic-old-assessment" }, expected]) {
      const cli = await fixture.run(["encode-requeue", "--key", "synthetic-requeue-stale", "--encode-job-id", id,
        ...(expectedSourceDecision === undefined ? [] : ["--source-decision", JSON.stringify(expectedSourceDecision)])]);
      const rejected = await post({ encodeJobId: id, action: "requeue", mutationKey: "synthetic-requeue-stale", expectedSourceDecision });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual(cli.result);
      expect(observer.encodeJobs.listForDiscSelection(seeded.selection.id)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    }
  } finally { observer.close(); }
});
