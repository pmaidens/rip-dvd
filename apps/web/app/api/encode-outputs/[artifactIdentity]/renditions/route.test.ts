import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { compatibleOutputProbe, requestSyntheticRendition } from "../../../../../../operator-cli/src/encode-output-rendition.test-support.js";
import { createEncodeOutputRenditionsRoute } from "./route";
import { createBrowserRenditionInspectionRoute } from "../../../browser-renditions/[id]/route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const config = { enabled: true, password: "synthetic-viewing-password" };
const authorization = `Basic ${Buffer.from(`operator:${config.password}`).toString("base64")}`;

it("shares durable admission, replay, stale checks and inspection with the CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticRendition(fixture);
  const access = fixture.openAccess();
  const url = `http://localhost:3000/api/encode-outputs/${seeded.identity}/renditions`;
  const options = { getAccess: () => access, accessConfig: config, probe: compatibleOutputProbe, trustedOrigin: "http://localhost:3000" };
  const headers = { Authorization: authorization, Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" };
  try {
    const available = await createEncodeOutputRenditionsRoute(new Request(url, { headers }), seeded.identity, options);
    expect(await available.json()).toEqual(seeded.review);
    const replay = await createEncodeOutputRenditionsRoute(new Request(url, { method: "POST", headers, body: JSON.stringify({ mutationKey: "synthetic-rendition-request", reviewToken: seeded.review.reviewToken }) }), seeded.identity, options);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(seeded.request);
    const stale = await createEncodeOutputRenditionsRoute(new Request(url, { method: "POST", headers, body: JSON.stringify({ mutationKey: "synthetic-stale-request", reviewToken: "a".repeat(64) }) }), seeded.identity, options);
    const cli = await fixture.run(["encode-output", "request-rendition", seeded.identity, "--key", "synthetic-stale-request", "--json", JSON.stringify({ reviewToken: "a".repeat(64) })], undefined, undefined, { encodeOutputMediaProbe: compatibleOutputProbe, browserRenditionsEnabled: true });
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual(cli.result);
    const inspected = createBrowserRenditionInspectionRoute(new Request(`http://localhost:3000/api/browser-renditions/${seeded.request.id}`, { headers }), seeded.request.id, () => access, config);
    expect(await inspected.json()).toEqual((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result);
    expect(available.headers.get("Cache-Control")).toBe("no-store");
  } finally { access.close(); }
});
it("authenticates creation and inspection before opening persistence, and rejects cross-origin mutation", async () => {
  const unavailableAccess = () => { throw new Error("Must not open persistence"); };
  for (const method of ["GET", "POST"]) {
    const response = await createEncodeOutputRenditionsRoute(new Request("http://localhost:3000/api/encode-outputs/synthetic/renditions", { method }), "synthetic", { getAccess: unavailableAccess, accessConfig: config });
    expect(response.status).toBe(401); expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
  }
  const denied = createBrowserRenditionInspectionRoute(new Request("http://localhost:3000/api/browser-renditions/synthetic"), "synthetic", unavailableAccess, config);
  expect(denied.status).toBe(401);
  const crossOrigin = await createEncodeOutputRenditionsRoute(new Request("http://localhost:3000/api/encode-outputs/synthetic/renditions", { method: "POST", headers: { Authorization: authorization, Host: "localhost:3000", Origin: "https://hostile.example", "Content-Type": "application/json" }, body: "{}" }), "synthetic", { getAccess: unavailableAccess, accessConfig: config, trustedOrigin: "http://localhost:3000" });
  expect(crossOrigin.status).toBe(403);
});
