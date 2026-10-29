import { afterEach, expect, it } from "vitest";
import {
  changeFailedCleanupOwnership, changeFailedValidation, disconnectKeepStorage, failedFileFaults,
  seedKeepPreflightFixture, unavailableKeepProbe,
} from "../../../../../../operator-cli/src/encode-output-keep-preflight.test-support.js";
import { createEncodeOutputKeepRoute } from "./route";

const fixtures: Awaited<ReturnType<typeof seedKeepPreflightFixture>>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ access, fixture }) => { access.close(); fixture.dispose(); }));
const origin = "http://localhost:3000";
const request = (identity: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/encode-outputs/${identity}/keep`, { method: "POST",
    headers: { Host: "localhost:3000", Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

it("shares explicit Keep and replay with the public CLI, without completing the job or acknowledging inspection", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  const body = { acknowledged: true, validationIdentity: preview.current.validationIdentity,
    previewToken: preview.previewToken, mutationKey: "synthetic-http-keep" };
  const route = () => createEncodeOutputKeepRoute(request(seeded.identity, body), seeded.identity,
    () => seeded.access, () => origin, unavailableKeepProbe);
  const web = await route();
  expect(web.status).toBe(200); expect(web.headers.get("Cache-Control")).toBe("no-store");
  const { mutationKey, ...review } = body;
  const cli = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", mutationKey,
    "--json", JSON.stringify(review)], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
  expect(cli.exitCode).toBe(0); expect(await web.json()).toEqual(cli.result);
  expect(await (await route()).json()).toEqual(cli.result);
  expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
  expect(seeded.access.encodeOutputInspectionReceipts.list(seeded.job.id, { limit: 20, offset: 0 }).receipts).toEqual([]);
  expect(JSON.stringify(cli.result)).not.toContain(seeded.fixture.mediaLibraryPath);
  const conflict = await createEncodeOutputKeepRoute(request(seeded.identity, { ...body,
    previewToken: `encode-output-keep-preview-v1.${"a".repeat(64)}` }), seeded.identity,
  () => seeded.access, () => origin, unavailableKeepProbe);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});

for (const fault of [
  ...failedFileFaults,
  { name: "validation", change: changeFailedValidation },
  { name: "cleanup ownership", change: changeFailedCleanupOwnership },
  { name: "storage", change: disconnectKeepStorage },
]) {
  it(`shares stale Keep rejection and current identities for changed ${fault.name}`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
    const { result: preview } = await seeded.preview();
    fault.change(seeded);
    const review = { acknowledged: true, validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken };
    const mutationKey = "synthetic-http-stale-keep";
    const web = await createEncodeOutputKeepRoute(request(seeded.identity, { ...review, mutationKey }), seeded.identity,
      () => seeded.access, () => origin, unavailableKeepProbe);
    const cli = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", mutationKey,
      "--json", JSON.stringify(review)], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
    expect(web.status).toBe(409); expect(cli.exitCode).not.toBe(0);
    expect(await web.json()).toEqual(cli.result);
    expect(cli.result).toMatchObject({ error: { current: { eligible: false, current: { artifactIdentity: seeded.identity } } } });
    expect(seeded.access.encodeOutputKeeps.latest(seeded.identity)).toBeNull();
  });
}

it("requires trusted JSON POST and explicit complete input before accessing persistence", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const body = { mutationKey: "synthetic-invalid-http-keep", acknowledged: false };
  for (const [headers, status, code] of [
    [{ Origin: "https://untrusted.invalid" }, 403, "CROSS_ORIGIN_MUTATION_REJECTED"],
    [{ "Content-Type": "text/plain" }, 415, "JSON_CONTENT_TYPE_REQUIRED"],
    [{}, 400, "INVALID_ARGUMENTS"],
  ] as const) {
    const result = await createEncodeOutputKeepRoute(request(seeded.identity, body, headers), seeded.identity,
      () => seeded.access, () => origin, unavailableKeepProbe);
    expect(result.status).toBe(status); expect(await result.json()).toMatchObject({ error: { code } });
  }
  expect(seeded.access.encodeOutputKeeps.latest(seeded.identity)).toBeNull();
});

it("shares ownership-first rejection when the submitted validation identity is also stale", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  changeFailedCleanupOwnership(seeded);
  const review = { acknowledged: true, validationIdentity: "00000000-0000-4000-8000-000000000000", previewToken: preview.previewToken };
  const mutationKey = "synthetic-http-priority-keep";
  const web = await createEncodeOutputKeepRoute(request(seeded.identity, { ...review, mutationKey }), seeded.identity,
    () => seeded.access, () => origin, unavailableKeepProbe);
  const cli = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", mutationKey,
    "--json", JSON.stringify(review)], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
  expect(web.status).toBe(409); expect(cli.exitCode).not.toBe(0);
  expect(await web.json()).toEqual(cli.result);
  expect(cli.result).toMatchObject({ error: { code: "OUTPUT_OWNERSHIP_LOST", current: { blockers: [
    { code: "OUTPUT_OWNERSHIP_LOST", message: expect.any(String) },
    { code: "OUTPUT_VALIDATION_CHANGED", message: expect.any(String) },
    { code: "KEEP_PREFLIGHT_STALE", message: expect.any(String) },
  ] } } });
});
