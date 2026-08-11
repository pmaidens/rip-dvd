import {
  linkSync,
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeOutputFilesystemIdentity,
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  sameEncodeOutputAuthoritySnapshot,
  sameEncodeOutputInode,
  sameEncodeOutputMutationSnapshot,
} from "./encode-output-filesystem-identity.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createOutput() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-output-identity-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "encode.mkv");
  writeFileSync(path, "encoded output", { flag: "wx" });
  return { directory, metadata: lstatSync(path), path };
}

describe("Encode output filesystem identity codec", () => {
  it("round-trips the filesystem snapshot using the existing tuple encoding", () => {
    const { metadata } = createOutput();

    const identity = encodeOutputFilesystemIdentity(metadata);

    expect(identity).toBe(
      JSON.stringify([
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.birthtimeMs,
        metadata.mtimeMs,
      ]),
    );
    expect(decodeOutputFilesystemIdentity(identity)).toEqual({
      birthtimeMs: metadata.birthtimeMs,
      deviceId: metadata.dev,
      inode: metadata.ino,
      modifiedAtMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    });
  });

  it.each([
    undefined,
    "",
    "not-json",
    "{}",
    "[]",
    "[1,2,3,4]",
    "[1,2,3,4,5,6]",
    '["1",2,3,4,5]',
    "[-1,2,3,4,5]",
    "[1,2,-1,4,5]",
    `[1,${Number.MAX_SAFE_INTEGER + 1},3,4,5]`,
  ])("rejects invalid encoded identities %#", (identity) => {
    expect(decodeOutputFilesystemIdentity(identity)).toBeNull();
  });

  it("preserves authority across worker-owned rename and link operations", () => {
    const { directory, metadata, path } = createOutput();
    const identity = encodeOutputFilesystemIdentity(metadata);
    const renamedPath = join(directory, "renamed.mkv");
    const linkedPath = join(directory, "linked.mkv");

    renameSync(path, renamedPath);
    const renamedMetadata = lstatSync(renamedPath);
    linkSync(renamedPath, linkedPath);
    const linkedMetadata = lstatSync(linkedPath);

    expect(sameEncodeOutputInode(metadata, renamedMetadata)).toBe(true);
    expect(sameEncodeOutputInode(metadata, linkedMetadata)).toBe(true);
    expect(
      matchesEncodeOutputFilesystemIdentity(identity, renamedMetadata),
    ).toBe(true);
    expect(
      matchesEncodeOutputFilesystemIdentity(identity, linkedMetadata),
    ).toBe(true);
  });

  it("distinguishes inode continuity from a mutated filesystem snapshot", () => {
    const { metadata, path } = createOutput();
    const identity = encodeOutputFilesystemIdentity(metadata);

    writeFileSync(path, "mutated encoded output");
    const mutatedMetadata = lstatSync(path);

    expect(sameEncodeOutputInode(metadata, mutatedMetadata)).toBe(true);
    expect(
      sameEncodeOutputMutationSnapshot(metadata, mutatedMetadata),
    ).toBe(false);
    expect(
      sameEncodeOutputAuthoritySnapshot(metadata, mutatedMetadata),
    ).toBe(false);
    expect(
      matchesEncodeOutputFilesystemIdentity(identity, mutatedMetadata),
    ).toBe(false);
  });
});
