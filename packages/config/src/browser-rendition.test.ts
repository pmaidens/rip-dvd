import { expect, it } from "vitest";
import { browserRenditionConfig } from "./index.js";

it("keeps browser renditions closed unless explicitly enabled and never supplies a default password", () => {
  expect(browserRenditionConfig({})).toEqual({ enabled: false, password: null });
  expect(browserRenditionConfig({ RIP_DVD_BROWSER_RENDITIONS_ENABLED: "1" })).toEqual({ enabled: false, password: null });
  expect(browserRenditionConfig({ RIP_DVD_BROWSER_RENDITIONS_ENABLED: "true", RIP_DVD_BROWSER_RENDITIONS_PASSWORD: "synthetic-password" })).toEqual({ enabled: true, password: "synthetic-password" });
});
