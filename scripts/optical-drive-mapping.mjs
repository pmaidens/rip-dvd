import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  flattenBlockDeviceGraph,
  isVirtualQemuOpticalDevice,
  normalizeOpticalHardwareText,
} from "../apps/archive-worker/src/optical-drive-discovery-policy.js";

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_BLOCK_DEVICES = 256;
const MAX_CONFIGURED_DRIVES = 32;
const DEVICE_PATH = /^\/dev\/(sr|sg)\d+$/;

export function decodeLsblkDevices(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("lsblk returned malformed JSON");
  }
  return flattenBlockDeviceGraph(parsed?.blockdevices, {
    maxDevices: MAX_BLOCK_DEVICES,
    source: "lsblk",
  })
    .filter((device) => device.type === "rom")
    .map((device) => {
      const blockDevicePath = normalizeOpticalHardwareText(device.path);
      const kernelName = normalizeOpticalHardwareText(device.kname);
      if (
        blockDevicePath === undefined ||
        kernelName === undefined ||
        !/^sr\d+$/.test(kernelName) ||
        blockDevicePath !== `/dev/${kernelName}`
      ) {
        throw new Error("lsblk returned an unsafe optical block-device path");
      }
      return {
        blockDevicePath,
        kernelName,
        model: normalizeOpticalHardwareText(device.model),
        serialNumber: normalizeOpticalHardwareText(device.serial),
        vendor: normalizeOpticalHardwareText(device.vendor),
      };
    });
}

export function decodeUdevProperties(output) {
  const properties = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      properties.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return properties;
}

export function pairScsiGenericDevice(kernelName, sysfsRoot = "/sys") {
  const directory = resolve(
    sysfsRoot,
    "class",
    "block",
    kernelName,
    "device",
    "scsi_generic",
  );
  let names;
  try {
    names = readdirSync(directory).filter((name) => /^sg\d+$/.test(name));
  } catch (error) {
    if (error?.code === "ENOENT") {
      names = [];
    } else {
      throw error;
    }
  }
  if (names.length !== 1) {
    throw new Error(
      `Optical block device /dev/${kernelName} has ${names.length} matching SCSI-generic devices`,
    );
  }
  return `/dev/${names[0]}`;
}

function run(executable, arguments_) {
  return execFileSync(executable, arguments_, {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function discoverPhysicalOpticalDrives({
  command = run,
  sysfsRoot = "/sys",
} = {}) {
  const devices = decodeLsblkDevices(
    command("lsblk", [
      "--json",
      "--output",
      "PATH,KNAME,TYPE,VENDOR,MODEL,SERIAL",
    ]),
  );
  const discovered = [];
  for (const device of devices) {
    const udev = decodeUdevProperties(
      command("udevadm", [
        "info",
        "--query=property",
        `--name=${device.blockDevicePath}`,
      ]),
    );
    const udevModel = normalizeOpticalHardwareText(udev.get("ID_MODEL"));
    const udevVendor = normalizeOpticalHardwareText(udev.get("ID_VENDOR"));
    if (
      isVirtualQemuOpticalDevice({
        model: device.model,
        vendor: device.vendor,
      }) ||
      isVirtualQemuOpticalDevice({ model: udevModel, vendor: udevVendor })
    ) {
      continue;
    }
    const udevSerial = normalizeOpticalHardwareText(
      udev.get("ID_SERIAL_SHORT"),
    );
    if (
      udevSerial !== undefined &&
      device.serialNumber !== undefined &&
      udevSerial !== device.serialNumber
    ) {
      throw new Error(
        `Optical block device ${device.blockDevicePath} has conflicting serial evidence`,
      );
    }
    const serialNumber =
      udevSerial ??
      device.serialNumber ??
      normalizeOpticalHardwareText(udev.get("ID_SERIAL"));
    discovered.push({
      blockDevicePath: device.blockDevicePath,
      model: udevModel ?? device.model,
      scsiGenericPath: pairScsiGenericDevice(device.kernelName, sysfsRoot),
      serialNumber,
      vendor: udevVendor ?? device.vendor,
    });
  }
  return discovered.sort((left, right) =>
    left.blockDevicePath.localeCompare(right.blockDevicePath),
  );
}

export function parseHardwareIdentityConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Optical-drive identity configuration must be an object");
  }
  if (value.version !== 1) {
    throw new Error("Optical-drive identity configuration version must be 1");
  }
  const serialNumbers = value.opticalDriveSerialNumbers;
  if (!Array.isArray(serialNumbers) || serialNumbers.length === 0) {
    throw new Error("opticalDriveSerialNumbers must be a nonempty array");
  }
  const normalized = serialNumbers.map((serial) => {
    const value = normalizeOpticalHardwareText(serial);
    if (value === undefined) {
      throw new Error(
        "Configured optical-drive serial numbers must be nonempty strings",
      );
    }
    return value;
  });
  if (normalized.length > MAX_CONFIGURED_DRIVES) {
    throw new Error(
      `At most ${MAX_CONFIGURED_DRIVES} optical drives may be configured`,
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Configured optical-drive serial numbers must be unique");
  }
  const primarySerialNumber = normalizeOpticalHardwareText(
    value.primarySerialNumber,
  );
  if (
    primarySerialNumber === undefined ||
    !normalized.includes(primarySerialNumber)
  ) {
    throw new Error("primarySerialNumber must name one configured optical drive");
  }
  return { primarySerialNumber, serialNumbers: normalized };
}

export function resolveConfiguredMappings(config, discovered) {
  const discoveredBySerial = new Map();
  for (const drive of discovered) {
    const serial = normalizeOpticalHardwareText(drive.serialNumber);
    if (serial === undefined) {
      continue;
    }
    const matches = discoveredBySerial.get(serial) ?? [];
    matches.push(drive);
    discoveredBySerial.set(serial, matches);
  }
  const mappings = config.serialNumbers.map((serialNumber) => {
    const matches = discoveredBySerial.get(serialNumber) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Configured optical-drive serial ${JSON.stringify(serialNumber)} matched ${matches.length} devices`,
      );
    }
    const drive = matches[0];
    for (const path of [drive.blockDevicePath, drive.scsiGenericPath]) {
      if (!DEVICE_PATH.test(path)) {
        throw new Error(`Discovered device path is unsafe: ${path}`);
      }
    }
    return { ...drive, serialNumber };
  });
  const blockPaths = mappings.map((drive) => drive.blockDevicePath);
  const genericPaths = mappings.map((drive) => drive.scsiGenericPath);
  if (
    new Set(blockPaths).size !== blockPaths.length ||
    new Set(genericPaths).size !== genericPaths.length
  ) {
    throw new Error("Configured optical-drive mappings do not have unique paths");
  }
  return mappings;
}

export function renderComposeOverride(config, mappings) {
  const primary = mappings.find(
    (drive) => drive.serialNumber === config.primarySerialNumber,
  );
  if (primary === undefined) {
    throw new Error("Primary optical-drive mapping is unavailable");
  }
  const deviceLines = mappings.flatMap((drive) => [
    `      - "${drive.blockDevicePath}:${drive.blockDevicePath}:r"`,
    `      - "${drive.scsiGenericPath}:${drive.scsiGenericPath}:r"`,
  ]);
  return [
    "# Generated by scripts/optical-drive-mapping.mjs; do not edit.",
    "services:",
    "  archive-worker:",
    "    environment:",
    `      RIP_DVD_ARCHIVE_DEVICE_PATH: "${primary.blockDevicePath}"`,
    `      RIP_DVD_ARCHIVE_CSS_DEVICE_PATH: "${primary.scsiGenericPath}"`,
    "    devices: !override",
    ...deviceLines,
    "",
  ].join("\n");
}

export function writeOverrideAtomically(outputPath, content) {
  try {
    if (readFileSync(outputPath, "utf8") === content) {
      return "unchanged";
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw cleanupError;
      }
    }
    throw error;
  }
  return "updated";
}

export function generateHardwareOverride({
  configPath,
  outputPath,
  discover = discoverPhysicalOpticalDrives,
}) {
  const config = parseHardwareIdentityConfig(
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  const mappings = resolveConfiguredMappings(config, discover());
  const content = renderComposeOverride(config, mappings);
  return writeOverrideAtomically(outputPath, content);
}

function parseArguments(arguments_) {
  const options = {
    configPath: ".local/optical-drives.json",
    outputPath: "compose.override.yaml",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--config" && arguments_[index + 1] !== undefined) {
      options.configPath = arguments_[index + 1];
      index += 1;
    } else if (argument === "--output" && arguments_[index + 1] !== undefined) {
      options.outputPath = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(
        "Usage: node scripts/optical-drive-mapping.mjs [--config PATH] [--output PATH]",
      );
    }
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = generateHardwareOverride(options);
    process.stdout.write(
      `Optical-drive Compose override ${result}: ${options.outputPath}\n`,
    );
  } catch (error) {
    process.stderr.write(`Optical-drive mapping failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
