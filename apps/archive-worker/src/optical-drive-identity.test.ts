import { describe, expect, it, vi } from "vitest";

import { createBoundOpticalDriveIdentity } from "./optical-drive-identity.js";

describe("bound Optical Drive identity", () => {
  it("rejects a bound device instance that changes before persistence", async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce("instance-41")
      .mockResolvedValueOnce("instance-43");
    const identity = createBoundOpticalDriveIdentity({ observe });
    const signal = new AbortController().signal;
    const binding = await identity.bind(
      { devicePath: "/dev/sr0", serialNumber: "DRIVE-001" },
      signal,
    );

    await expect(
      identity.requireCurrent(binding, "before DVD persistence", signal),
    ).rejects.toThrow("Optical Drive instance changed before DVD persistence");
  });
});
