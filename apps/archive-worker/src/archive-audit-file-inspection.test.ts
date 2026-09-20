import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectArchiveAuditFile } from "./archive-audit-file-inspection.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeBothEndian16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

function writeBothEndian32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

function isoImage(volumeSectorCount: number): Buffer {
  const image = Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES);
  const primary = image.subarray(
    16 * DVD_SECTOR_SIZE_BYTES,
    17 * DVD_SECTOR_SIZE_BYTES,
  );
  primary[0] = 1;
  primary.write("CD001", 1, "ascii");
  primary[6] = 1;
  writeBothEndian32(primary, 80, volumeSectorCount);
  writeBothEndian16(primary, 120, 1);
  writeBothEndian16(primary, 124, 1);
  writeBothEndian16(primary, 128, DVD_SECTOR_SIZE_BYTES);
  const terminator = image.subarray(
    17 * DVD_SECTOR_SIZE_BYTES,
    18 * DVD_SECTOR_SIZE_BYTES,
  );
  terminator[0] = 255;
  terminator.write("CD001", 1, "ascii");
  terminator[6] = 1;
  return image;
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-audit-"));
  temporaryDirectories.push(directory);
  return directory;
}

const signal = new AbortController().signal;

describe("archive audit file inspection", () => {
  it("uses the production geometry rules to report definite truncation", async () => {
    const root = fixture();
    const path = join(root, "truncated.iso");
    writeFileSync(path, isoImage(601));

    await expect(inspectArchiveAuditFile(path, root, signal)).resolves.toEqual({
      actualSizeBytes: 600 * DVD_SECTOR_SIZE_BYTES,
      geometry: {
        imageSectorCount: 600,
        isoVolumeSectorCount: 601,
        udfMaximumDeclaredSectorCount: null,
      },
      outcome: "definite_truncation",
    });
  });

  it("fails safely for missing, malformed, and unsupported images", async () => {
    const root = fixture();
    const malformedPath = join(root, "malformed.iso");
    const malformed = isoImage(600);
    malformed.writeUInt32BE(599, 16 * DVD_SECTOR_SIZE_BYTES + 84);
    writeFileSync(malformedPath, malformed);
    const unsupportedPath = join(root, "unsupported.iso");
    writeFileSync(
      unsupportedPath,
      Buffer.alloc(600 * DVD_SECTOR_SIZE_BYTES),
    );

    await expect(inspectArchiveAuditFile(
      join(root, "missing.iso"),
      root,
      signal,
    )).resolves.toMatchObject({ outcome: "missing_file" });
    await expect(inspectArchiveAuditFile(
      malformedPath,
      root,
      signal,
    )).resolves.toMatchObject({ outcome: "malformed_metadata" });
    await expect(inspectArchiveAuditFile(
      unsupportedPath,
      root,
      signal,
    )).resolves.toMatchObject({ outcome: "unsupported_layout" });
  });

  it("rejects paths outside the configured archive root before reading them", async () => {
    const root = fixture();
    const outside = fixture();
    const outsidePath = join(outside, "outside.iso");
    writeFileSync(outsidePath, isoImage(600));

    await expect(inspectArchiveAuditFile(
      outsidePath,
      root,
      signal,
    )).resolves.toEqual({
      actualSizeBytes: null,
      geometry: null,
      outcome: "containment_rejection",
    });
  });
});
