import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBoundedArchiveAuditFileInspector } from "./archive-audit-file-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function helper(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-audit-helper-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "helper.mjs");
  writeFileSync(path, source);
  return path;
}

describe("bounded archive audit file helper", () => {
  it("accepts one bounded structured inspection", async () => {
    const helperPath = helper(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({
          actualSizeBytes: 2048,
          geometry: {
            imageSectorCount: 1,
            isoVolumeSectorCount: 1,
            udfMaximumDeclaredSectorCount: null
          },
          outcome: "ok"
        }));
      });
    `);
    const inspector = createBoundedArchiveAuditFileInspector({
      helperPath,
      timeoutMs: 1_000,
    });

    await expect(inspector.inspect(
      "/archives/disc.iso",
      "/archives",
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: "ok", actualSizeBytes: 2_048 });
  });

  it("kills a helper that exceeds its per-file runtime", async () => {
    const helperPath = helper("process.stdin.resume(); setInterval(() => {}, 1000);");
    const inspector = createBoundedArchiveAuditFileInspector({
      helperPath,
      timeoutMs: 20,
    });

    await expect(inspector.inspect(
      "/archives/disc.iso",
      "/archives",
      new AbortController().signal,
    )).resolves.toEqual({
      actualSizeBytes: null,
      geometry: null,
      outcome: "read_timeout",
    });
  });

  it("maps malformed or oversized helper output to a fixed read error", async () => {
    const helperPath = helper(
      `process.stdout.write("x".repeat(5000)); process.stdin.resume();`,
    );
    const inspector = createBoundedArchiveAuditFileInspector({
      helperPath,
      timeoutMs: 1_000,
    });

    await expect(inspector.inspect(
      "/archives/disc.iso",
      "/archives",
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: "read_error" });
  });

  it("rejects incomplete successful helper output", async () => {
    const helperPath = helper(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({
          actualSizeBytes: -1,
          geometry: null,
          outcome: "ok"
        }));
      });
    `);
    const inspector = createBoundedArchiveAuditFileInspector({
      helperPath,
      timeoutMs: 1_000,
    });

    await expect(inspector.inspect(
      "/archives/disc.iso",
      "/archives",
      new AbortController().signal,
    )).resolves.toEqual({
      actualSizeBytes: null,
      geometry: null,
      outcome: "read_error",
    });
  });
});
