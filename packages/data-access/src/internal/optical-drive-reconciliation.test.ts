import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import type { OpticalDriveId } from "../types.js";
import { planOpticalDriveReconciliation } from "./optical-drive-reconciliation.js";

const storedDriveId = "stored-drive" as OpticalDriveId;

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
          id: storedDriveId,
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

  it("matches a configured drive by stable serial after its device path changes", () => {
    const plan = planOpticalDriveReconciliation(
      [
        {
          devicePath: "/dev/sr1",
          isConfiguredDevice: true,
          serialNumber: "STABLE-1",
        },
      ],
      [
        {
          id: storedDriveId,
          devicePath: "/dev/sr2",
          configurationDefaultResolved: true,
          isConfiguredTarget: true,
          isPresent: false,
          product: "DVD RW",
          serialNumber: "STABLE-1",
          vendor: "Optiarc",
        },
      ],
    );

    expect(plan.drives[0]).toMatchObject({
      existingId: storedDriveId,
      authorizationUpdate: {},
    });
  });

  it("rejects duplicate discovered serial evidence", () => {
    expect(() =>
      planOpticalDriveReconciliation(
        [
          {
            devicePath: "/dev/sr0",
            isConfiguredDevice: false,
            serialNumber: "DUPLICATE",
          },
          {
            devicePath: "/dev/sr1",
            isConfiguredDevice: false,
            serialNumber: "DUPLICATE",
          },
        ],
        [],
      ),
    ).toThrow("Discovered Optical Drive serial numbers must be unique");
  });

  it("reserves serial matches before matching replacements at old paths", () => {
    const movedDriveId = "moved-drive" as OpticalDriveId;
    const plan = planOpticalDriveReconciliation(
      [
        {
          devicePath: "/dev/sr0",
          isConfiguredDevice: false,
          serialNumber: "REPLACEMENT",
        },
        {
          devicePath: "/dev/sr1",
          isConfiguredDevice: true,
          serialNumber: "MOVED",
        },
      ],
      [
        {
          id: movedDriveId,
          devicePath: "/dev/sr0",
          configurationDefaultResolved: true,
          isConfiguredTarget: true,
          isPresent: true,
          product: "DVD RW",
          serialNumber: "MOVED",
          vendor: "Optiarc",
        },
      ],
    );

    expect(plan.drives).toMatchObject([
      {
        existingId: undefined,
        insertAuthorization: { isEnabled: false },
      },
      {
        existingId: movedDriveId,
        authorizationUpdate: {},
      },
    ]);
  });

  it("rejects ambiguous stored serial evidence before any persistence", () => {
    const stored = (id: string, devicePath: string) => ({
      id: id as OpticalDriveId,
      devicePath,
      configurationDefaultResolved: true,
      isConfiguredTarget: false,
      isPresent: false,
      product: "DVD RW",
      serialNumber: "DUPLICATE-STORED",
      vendor: "Optiarc",
    });

    expect(() =>
      planOpticalDriveReconciliation(
        [],
        [stored("first", "/dev/sr0"), stored("second", "/dev/sr1")],
      ),
    ).toThrow("Stored Optical Drive serial number is ambiguous");
  });

  it("disables same-path hardware when continuity is unproven after disappearance", () => {
    const plan = planOpticalDriveReconciliation(
      [{ devicePath: "/dev/sr0", isConfiguredDevice: false }],
      [
        {
          id: storedDriveId,
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
          id: storedDriveId,
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
