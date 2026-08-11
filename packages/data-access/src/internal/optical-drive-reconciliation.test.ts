import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import { planOpticalDriveReconciliation } from "./optical-drive-reconciliation.js";

describe("optical drive reconciliation policy", () => {
  it("rejects ambiguous discovery snapshots before persistence", () => {
    expect(() =>
      planOpticalDriveReconciliation(
        [
          { devicePath: "/dev/sr0", isConfiguredDevice: false },
          { devicePath: "/dev/sr0", isConfiguredDevice: false },
        ],
        [],
      ),
    ).toThrow(DomainInvariantError);

    expect(() =>
      planOpticalDriveReconciliation(
        [
          { devicePath: "/dev/sr0", isConfiguredDevice: true },
          { devicePath: "/dev/sr1", isConfiguredDevice: true },
        ],
        [],
      ),
    ).toThrow(DomainInvariantError);
  });

  it("treats a matching nonempty serial as continuity despite model changes", () => {
    const plan = planOpticalDriveReconciliation(
      [
        {
          devicePath: "/dev/sr0",
          isConfiguredDevice: false,
          product: "New model text",
          serialNumber: " SERIAL-1 ",
          vendor: "New vendor text",
        },
      ],
      [
        {
          devicePath: "/dev/sr0",
          configurationDefaultResolved: true,
          isConfiguredTarget: false,
          isPresent: false,
          product: "Old model text",
          serialNumber: "SERIAL-1",
          vendor: "Old vendor text",
        },
      ],
    );

    expect(plan.drives[0]?.authorizationUpdate).toEqual({});
  });

  it("disables same-path hardware when continuity is unproven after disappearance", () => {
    const plan = planOpticalDriveReconciliation(
      [{ devicePath: "/dev/sr0", isConfiguredDevice: false }],
      [
        {
          devicePath: "/dev/sr0",
          configurationDefaultResolved: true,
          isConfiguredTarget: false,
          isPresent: false,
          product: "Drive",
          serialNumber: null,
          vendor: "Vendor",
        },
      ],
    );

    expect(plan.drives[0]?.authorizationUpdate).toEqual({
      configurationDefaultResolved: true,
      isEnabled: false,
    });
  });

  it("consumes a retargeted configured default without authorizing the target", () => {
    const plan = planOpticalDriveReconciliation(
      [{ devicePath: "/dev/sr1", isConfiguredDevice: true }],
      [
        {
          devicePath: "/dev/sr0",
          configurationDefaultResolved: true,
          isConfiguredTarget: true,
          isPresent: true,
          product: null,
          serialNumber: "OLD",
          vendor: null,
        },
      ],
    );

    expect(plan.configuredTargetPath).toBe("/dev/sr1");
    expect(plan.drives[0]).toMatchObject({
      insertAuthorization: {
        configurationDefaultResolved: true,
        isEnabled: false,
      },
    });
  });
});
