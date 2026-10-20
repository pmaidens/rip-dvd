import { statfsSync } from "node:fs";

const LOCAL_FILESYSTEMS = new Map<bigint, string>([
  [0xef53n, "ext"],
  [0x58465342n, "xfs"],
  [0x9123683en, "btrfs"],
]);

const NETWORK_FILESYSTEMS = new Map<bigint, string>([
  [0x6969n, "nfs"],
  [0x517bn, "smb"],
  [0xff534d42n, "cifs"],
  [0x01021997n, "9p"],
  [0x73757245n, "coda"],
]);

export interface LinuxStorageInspection {
  filesystemType: string;
  storageClass: "local" | "network" | "unknown";
}

function normalizedFilesystemType(type: number | bigint): bigint {
  return BigInt.asUintN(32, BigInt(type));
}

export function classifyLinuxFilesystemType(
  filesystemType: number | bigint,
): LinuxStorageInspection {
  const type = normalizedFilesystemType(filesystemType);
  const localName = LOCAL_FILESYSTEMS.get(type);
  if (localName !== undefined) {
    return { filesystemType: localName, storageClass: "local" };
  }
  const networkName = NETWORK_FILESYSTEMS.get(type);
  if (networkName !== undefined) {
    return { filesystemType: networkName, storageClass: "network" };
  }
  return {
    filesystemType: `linux-magic-0x${type.toString(16)}`,
    storageClass: "unknown",
  };
}

export function inspectLinuxStorage(path: string): LinuxStorageInspection {
  return classifyLinuxFilesystemType(
    statfsSync(path, { bigint: true }).type,
  );
}
