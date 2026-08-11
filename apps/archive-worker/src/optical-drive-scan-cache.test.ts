import { describe, expect, it } from "vitest";

import { createOpticalDriveScanCache } from "./optical-drive-scan-cache.js";

describe("Optical Drive scan cache policy", () => {
  it("evicts scans for device paths absent from the latest discovery", () => {
    const cache = createOpticalDriveScanCache();
    cache.remember("/dev/sr0", "17", null);

    expect(cache.find("/dev/sr0", "17")).toEqual({ result: null });

    cache.retainDiscovered(["/dev/sr1"]);

    expect(cache.find("/dev/sr0", "17")).toBeUndefined();
  });
});
