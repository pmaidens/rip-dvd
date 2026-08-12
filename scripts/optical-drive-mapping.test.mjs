import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  decodeLsblkDevices,
  discoverPhysicalOpticalDrives,
  generateHardwareOverride,
  pairScsiGenericDevice,
  parseHardwareIdentityConfig,
  renderComposeOverride,
  resolveConfiguredMappings,
  writeOverrideAtomically,
} from "./optical-drive-mapping.mjs";

function config() {
  return parseHardwareIdentityConfig({
    version: 1,
    primarySerialNumber: "OPT-001",
    opticalDriveSerialNumbers: ["OPT-001", "LG-002"],
  });
}

function discovered() {
  return [
    {
      blockDevicePath: "/dev/sr1",
      scsiGenericPath: "/dev/sg2",
      serialNumber: "OPT-001",
    },
    {
      blockDevicePath: "/dev/sr2",
      scsiGenericPath: "/dev/sg4",
      serialNumber: "LG-002",
    },
  ];
}

describe("optical-drive hardware mapping", () => {
  it("pairs sr and sg devices through sysfs rather than numeric suffixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rip-dvd-sysfs-"));
    mkdirSync(join(root, "class/block/sr1/device/scsi_generic/sg2"), {
      recursive: true,
    });
    mkdirSync(join(root, "class/block/sr2/device/scsi_generic/sg4"), {
      recursive: true,
    });

    assert.equal(pairScsiGenericDevice("sr1", root), "/dev/sg2");
    assert.equal(pairScsiGenericDevice("sr2", root), "/dev/sg4");
  });

  it("discovers physical optical drives while excluding QEMU and disks", async () => {
    const root = await mkdtemp(join(tmpdir(), "rip-dvd-discovery-"));
    mkdirSync(join(root, "class/block/sr0/device/scsi_generic/sg0"), {
      recursive: true,
    });
    mkdirSync(join(root, "class/block/sr1/device/scsi_generic/sg7"), {
      recursive: true,
    });
    const lsblk = JSON.stringify({
      blockdevices: [
        { path: "/dev/sda", kname: "sda", type: "disk", vendor: "SanDisk" },
        {
          path: "/dev/sr0",
          kname: "sr0",
          type: "rom",
          vendor: "QEMU",
          model: "QEMU DVD-ROM",
        },
        {
          path: "/dev/sr1",
          kname: "sr1",
          type: "rom",
          vendor: "Optiarc",
          model: "DVD RW AD-7580S",
        },
      ],
    });
    const command = (executable, arguments_) => {
      if (executable === "lsblk") return lsblk;
      if (arguments_.at(-1) === "--name=/dev/sr0") {
        return "ID_VENDOR=QEMU\nID_MODEL=QEMU_DVD-ROM\n";
      }
      return "ID_VENDOR=Optiarc\nID_MODEL=DVD_RW_AD-7580S\nID_SERIAL_SHORT=OPT-001\n";
    };

    assert.deepEqual(
      discoverPhysicalOpticalDrives({ command, sysfsRoot: root }),
      [
        {
          blockDevicePath: "/dev/sr1",
          model: "DVD_RW_AD-7580S",
          scsiGenericPath: "/dev/sg7",
          serialNumber: "OPT-001",
          vendor: "Optiarc",
        },
      ],
    );
  });

  it("renders the same identities after independent sr and sg renumbering", () => {
    const before = resolveConfiguredMappings(config(), discovered());
    const after = resolveConfiguredMappings(config(), [
      {
        ...discovered()[0],
        blockDevicePath: "/dev/sr4",
        scsiGenericPath: "/dev/sg1",
      },
      {
        ...discovered()[1],
        blockDevicePath: "/dev/sr0",
        scsiGenericPath: "/dev/sg6",
      },
    ]);

    assert.match(
      renderComposeOverride(config(), before),
      /\/dev\/sr1:\/dev\/sr1:r/,
    );
    assert.match(
      renderComposeOverride(config(), after),
      /\/dev\/sr4:\/dev\/sr4:r/,
    );
    assert.match(
      renderComposeOverride(config(), after),
      /\/dev\/sg1:\/dev\/sg1:r/,
    );
  });

  it("is idempotent and does not rewrite an unchanged override", async () => {
    const root = await mkdtemp(join(tmpdir(), "rip-dvd-override-"));
    const outputPath = join(root, "compose.override.yaml");
    const content = renderComposeOverride(config(), discovered());

    assert.equal(writeOverrideAtomically(outputPath, content), "updated");
    const firstModified = statSync(outputPath).mtimeMs;
    assert.equal(writeOverrideAtomically(outputPath, content), "unchanged");
    assert.equal(statSync(outputPath).mtimeMs, firstModified);
  });

  it("leaves a working override unchanged when identity discovery is ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "rip-dvd-ambiguous-"));
    const configPath = join(root, "optical-drives.json");
    const outputPath = join(root, "compose.override.yaml");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        primarySerialNumber: "OPT-001",
        opticalDriveSerialNumbers: ["OPT-001"],
      }),
    );
    writeFileSync(outputPath, "known-working-override\n");

    assert.throws(
      () =>
        generateHardwareOverride({
          configPath,
          outputPath,
          discover: () => [
            {
              blockDevicePath: "/dev/sr0",
              scsiGenericPath: "/dev/sg1",
              serialNumber: "OPT-001",
            },
            {
              blockDevicePath: "/dev/sr1",
              scsiGenericPath: "/dev/sg2",
              serialNumber: "OPT-001",
            },
          ],
        }),
      /matched 2 devices/,
    );
    assert.equal(readFileSync(outputPath, "utf8"), "known-working-override\n");
  });

  it("preserves a working override when lsblk and udev serials conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "rip-dvd-conflicting-evidence-"));
    const configPath = join(root, "optical-drives.json");
    const outputPath = join(root, "compose.override.yaml");
    mkdirSync(join(root, "sys/class/block/sr1/device/scsi_generic/sg2"), {
      recursive: true,
    });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        primarySerialNumber: "UDEV-SERIAL",
        opticalDriveSerialNumbers: ["UDEV-SERIAL"],
      }),
    );
    writeFileSync(outputPath, "known-working-override\n");
    const command = (executable) =>
      executable === "lsblk"
        ? JSON.stringify({
            blockdevices: [
              {
                path: "/dev/sr1",
                kname: "sr1",
                type: "rom",
                serial: "LSBLK-SERIAL",
              },
            ],
          })
        : "ID_SERIAL_SHORT=UDEV-SERIAL\n";

    assert.throws(
      () =>
        generateHardwareOverride({
          configPath,
          outputPath,
          discover: () =>
            discoverPhysicalOpticalDrives({
              command,
              sysfsRoot: join(root, "sys"),
            }),
        }),
      /conflicting serial evidence/,
    );
    assert.equal(readFileSync(outputPath, "utf8"), "known-working-override\n");
  });

  it("excludes a device when either discovery source identifies QEMU", async () => {
    const root = await mkdtemp(join(tmpdir(), "rip-dvd-qemu-conflict-"));
    mkdirSync(join(root, "class/block/sr0/device/scsi_generic/sg1"), {
      recursive: true,
    });
    const command = (executable) =>
      executable === "lsblk"
        ? JSON.stringify({
            blockdevices: [
              {
                path: "/dev/sr0",
                kname: "sr0",
                type: "rom",
                vendor: "QEMU",
                model: "QEMU DVD-ROM",
              },
            ],
          })
        : "ID_VENDOR=Optiarc\nID_MODEL=DVD_RW\nID_SERIAL_SHORT=MASKED\n";

    assert.deepEqual(
      discoverPhysicalOpticalDrives({ command, sysfsRoot: root }),
      [],
    );
  });

  it("rejects malformed lsblk optical paths", () => {
    assert.throws(
      () =>
        decodeLsblkDevices(
          JSON.stringify({
            blockdevices: [{ path: "/dev/sr0", kname: "sr9", type: "rom" }],
          }),
        ),
      /unsafe optical block-device path/,
    );
  });
});
