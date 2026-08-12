import type { DiscoveredOpticalDrive } from "@rip-dvd/data-access";

import { optionalBoundedText } from "./bounded-text.js";
import { MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES } from "./optical-drive-command-runner.js";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";
import {
  flattenBlockDeviceGraph,
  isVirtualQemuOpticalDevice,
} from "./optical-drive-discovery-policy.js";

const MAX_DISCOVERED_DEVICES = 32;
const MAX_BLOCK_DEVICE_NODES = 256;
const MAX_LABEL_LENGTH = 256;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeLsblkOpticalDrives(
  output: string,
): DiscoveredOpticalDrive[] {
  if (Buffer.byteLength(output) > MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES) {
    throw new Error("lsblk output exceeds the discovery size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("lsblk returned malformed JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("lsblk returned a malformed result");
  }
  const records = flattenBlockDeviceGraph(parsed.blockdevices, {
    maxDevices: MAX_BLOCK_DEVICE_NODES,
    source: "lsblk",
  });
  if (!records.every(isRecord)) {
    throw new Error("lsblk output contains a malformed block-device node");
  }
  const drives = records
    .filter(
      (record) =>
        record.type === "rom" &&
        !isVirtualQemuOpticalDevice({
          model: record.model,
          vendor: record.vendor,
        }),
    )
    .map((record): DiscoveredOpticalDrive => {
      const vendor = optionalBoundedText(record.vendor, MAX_LABEL_LENGTH);
      const product = optionalBoundedText(record.model, MAX_LABEL_LENGTH);
      const serialNumber = optionalBoundedText(record.serial, MAX_LABEL_LENGTH);
      const displayName = [vendor, product].filter(Boolean).join(" ");
      return {
        devicePath: requireSafeOpticalDevicePath(record.path),
        ...(displayName ? { displayName } : {}),
        ...(vendor ? { vendor } : {}),
        ...(product ? { product } : {}),
        ...(serialNumber ? { serialNumber } : {}),
      };
    });
  if (drives.length > MAX_DISCOVERED_DEVICES) {
    throw new Error(
      `lsblk returned more than ${MAX_DISCOVERED_DEVICES} Optical Drives`,
    );
  }
  if (new Set(drives.map((drive) => drive.devicePath)).size !== drives.length) {
    throw new Error("lsblk returned duplicate Optical Drive device paths");
  }
  return drives.sort((left, right) =>
    left.devicePath.localeCompare(right.devicePath),
  );
}
