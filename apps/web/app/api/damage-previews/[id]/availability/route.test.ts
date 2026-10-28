import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDamagePreview } from "../../../../../../operator-cli/src/damage-preview.test-support.js";
import { createDamagePreviewAvailabilityRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("shares exact availability, preflight tokens, costs, unknowns and all reasons with public JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture, "whole_cell");
  const access = fixture.openAccess();
  try {
    const origin = "http://localhost:3000";
    const url = `${origin}/api/damage-previews/${seeded.archive.id}/availability`;
    for (const input of [undefined, seeded.input, { ...seeded.input, intervalIndexes: [2], samplingWindow: { startMilliseconds: 100_000, endMilliseconds: 110_000 } }]) {
      const args = input === undefined ? [] : ["--json", JSON.stringify(input)];
      const cli = await fixture.run(["damage-preview", "availability", seeded.archive.id, ...args]);
      const web = await createDamagePreviewAvailabilityRoute(new Request(url, input === undefined ? {} : {
        method: "POST", headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input),
      }), seeded.archive.id, () => access, () => origin);
      expect(web.status).toBe(200);
      expect(web.headers.get("Cache-Control")).toBe("no-store");
      expect(cli.exitCode).toBe(0);
      expect(await web.json()).toEqual(cli.result);
    }
    const invalid = await createDamagePreviewAvailabilityRoute(new Request(url, {
      method: "POST", headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: "{}",
    }), seeded.archive.id, () => access, () => origin);
    expect(invalid.status).toBe(400);
    const crossOrigin = await createDamagePreviewAvailabilityRoute(new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seeded.input),
    }), seeded.archive.id, () => access, () => origin);
    expect(crossOrigin.status).toBe(403);
  } finally { access.close(); }
});
