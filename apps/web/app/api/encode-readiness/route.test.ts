import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../operator-cli/src/operator-workflow.test-support";
import { seedEncodingReadiness } from "../../../../operator-cli/src/encoding-readiness.test-support";
import { createEncodingReadinessRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it.each(["clean", "damage", "unknown", "historical"])("matches public CLI readiness and identities for %s content", async (kind) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive } = kind === "historical" ? seedCatalogReviewForReadFixture(fixture)
    : await seedEncodingReadiness(fixture, { clean: kind === "clean", partial: kind === "unknown" });
  const cli = await fixture.run(["encode-readiness", archive.id]);
  const access = fixture.openAccess();
  try {
    const response = await createEncodingReadinessRoute(new Request(`http://localhost/api/encode-readiness?archiveId=${archive.id}`),
      () => access, () => ({ originalsLibraryPath: fixture.originalsLibraryPath }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(cli.result);
    const choices = await createEncodingReadinessRoute(new Request("http://localhost/api/encode-readiness"), () => access);
    expect(await choices.json()).toEqual((await fixture.run(["encode-readiness"])).result);
  } finally { access.close(); }
});

it.each(["archiveId=../invalid", "archiveId=a&archiveId=b", "offset=-1", "offset=1&offset=2", "archiveId=a&offset=1", "other=1"])("rejects invalid query %s before opening persistence", async (query) => {
  const response = await createEncodingReadinessRoute(new Request(`http://localhost/api/encode-readiness?${query}`),
    () => { throw new Error("Must not open persistence"); });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "INVALID_ARGUMENTS" } });
});

it("reports a missing archive with the same code as CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const access = fixture.openAccess();
  try {
    const response = await createEncodingReadinessRoute(new Request("http://localhost/api/encode-readiness?archiveId=synthetic-missing"), () => access,
      () => ({ originalsLibraryPath: fixture.originalsLibraryPath }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  } finally { access.close(); }
});
