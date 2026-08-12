import { describe, expect, it, vi } from "vitest";

import { DiscInspectionError } from "./disc-inspection-error.js";
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
    ).rejects.toEqual(expect.objectContaining<Partial<DiscInspectionError>>({
      kind: "abort",
      message: "Optical Drive instance changed before DVD persistence",
      reasonCode: "drive_identity_changed",
    }));
  });
});
