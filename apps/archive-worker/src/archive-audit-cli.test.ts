import { describe, expect, it, vi } from "vitest";

import { runArchiveAudit } from "./archive-audit.js";
import {
  type ArchiveAuditCliDependencies,
  type ArchiveAuditCliHost,
  runArchiveAuditCli,
} from "./archive-audit-cli.js";

function fixture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const host: ArchiveAuditCliHost = {
    environment: {
      RIP_DVD_DATABASE_PATH: "/data/catalog.sqlite",
      RIP_DVD_ORIGINALS_LIBRARY_PATH: "/media/originals",
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  const readRecords = vi.fn(() => ({ records: [], truncated: false }));
  const dependencies: ArchiveAuditCliDependencies = {
    createFileInspector: vi.fn(() => ({
      inspect: async () => ({
        actualSizeBytes: null,
        geometry: null,
        outcome: "read_error" as const,
      }),
    })),
    readRecords,
    runAudit: runArchiveAudit,
  };
  return { dependencies, host, readRecords, stderr, stdout };
}

describe("archive audit command", () => {
  it("passes explicit bounds into the stable report", async () => {
    const scenario = fixture();

    await expect(runArchiveAuditCli([
      "--limit",
      "7",
      "--concurrency",
      "3",
      "--file-timeout-ms",
      "4000",
      "--runtime-timeout-ms",
      "9000",
    ], scenario.host, scenario.dependencies)).resolves.toBe(0);

    expect(scenario.readRecords).toHaveBeenCalledWith(
      "/data/catalog.sqlite",
      7,
    );
    expect(scenario.stderr).toEqual([]);
    expect(JSON.parse(scenario.stdout.join(""))).toMatchObject({
      commandVersion: "archive-audit-v1",
      schemaVersion: 1,
      scope: {
        recordLimit: 7,
        concurrency: 3,
        fileTimeoutMs: 4_000,
        runtimeTimeoutMs: 9_000,
        truncated: false,
      },
      findings: [],
    });
  });

  it("fails with a bounded error instead of echoing invalid input", async () => {
    const scenario = fixture();

    await expect(runArchiveAuditCli(
      ["--unknown", "super-secret-path"],
      scenario.host,
      scenario.dependencies,
    )).resolves.toBe(1);

    expect(scenario.stdout).toEqual([]);
    expect(scenario.stderr).toEqual([
      `${JSON.stringify({ error: "archive_audit_failed" })}\n`,
    ]);
    expect(scenario.stderr.join("")).not.toContain("super-secret-path");
  });
});
