import { describe, expect, it } from "vitest";

import { decodeLsblkOpticalDrives } from "./optical-drive-discovery.js";

describe("lsblk Optical Drive discovery decoder", () => {
  it("returns normalized Optical Drives from a nested block-device graph", () => {
    const output = JSON.stringify({
      blockdevices: [
        {
          path: "/dev/sda",
          type: "disk",
          children: [
            {
              path: "/dev/sr1",
              type: "rom",
              vendor: " LG ",
              model: " BD-RE ",
              serial: " DRIVE-002 ",
            },
          ],
        },
        {
          path: "/dev/sr0",
          type: "rom",
          vendor: " Pioneer ",
          model: " DVD-RW ",
          serial: " DRIVE-001 ",
        },
      ],
    });

    expect(decodeLsblkOpticalDrives(output)).toEqual([
      {
        devicePath: "/dev/sr0",
        displayName: "Pioneer DVD-RW",
        product: "DVD-RW",
        serialNumber: "DRIVE-001",
        vendor: "Pioneer",
      },
      {
        devicePath: "/dev/sr1",
        displayName: "LG BD-RE",
        product: "BD-RE",
        serialNumber: "DRIVE-002",
        vendor: "LG",
      },
    ]);
  });
});
