import { describe, expect, it } from "vitest";

import { classifyLinuxFilesystemType } from "./linux-storage.js";

describe("Linux storage classification", () => {
  it.each([
    [0xef53n, "ext"],
    [0x58465342n, "xfs"],
    [0x9123683en, "btrfs"],
  ] as const)("classifies %s as local %s storage", (magic, name) => {
    expect(classifyLinuxFilesystemType(magic)).toEqual({
      filesystemType: name,
      storageClass: "local",
    });
  });

  it.each([
    [0x6969n, "nfs"],
    [0x517bn, "smb"],
    [0xff534d42n, "cifs"],
    [0x01021997n, "9p"],
    [0x73757245n, "coda"],
  ] as const)("classifies %s as network %s storage", (magic, name) => {
    expect(classifyLinuxFilesystemType(magic)).toEqual({
      filesystemType: name,
      storageClass: "network",
    });
  });

  it("keeps unrecognized filesystems unsupported", () => {
    expect(classifyLinuxFilesystemType(0x794c7630n)).toEqual({
      filesystemType: "linux-magic-0x794c7630",
      storageClass: "unknown",
    });
  });
});
