import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { runCommand } from "./command.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

function fixture() {
  const created = createOperatorWorkflowFixture();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const current of fixtures.splice(0)) {
    current.dispose();
  }
});

it("reports database health as JSON through the public command runner", () => {
  const result = fixture().run(["health"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.result).toEqual({
    status: "ok",
    sqliteVersion: expect.any(String),
    journalMode: "wal",
    busyTimeoutMs: 5_000,
  });
});

it("reports deployment readiness from persisted Optical Drive and Disc Inspection state", () => {
  const current = fixture();
  const seed = current.openAccess();
  const drive = seed.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    serialNumber: "SYNTHETIC-DRIVE",
    isEnabled: true,
    isPresent: true,
  });
  const inspection = seed.discInspections.beginOrResume({
    opticalDriveId: drive.id,
    mediaGeneration: "synthetic-generation",
    mediaCapacityBytes: 2_048,
  }).inspection;
  seed.close();
  const result = current.run(["readiness"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.result).toEqual({
    schemaVersion: 1,
    activeWork: [{ kind: "disc_inspection", id: inspection.id, status: "running" }],
    opticalDrives: [{
      id: drive.id,
      devicePath: "/dev/sr0",
      serialNumber: "SYNTHETIC-DRIVE",
      isEnabled: true,
      isPresent: true,
    }],
  });
});

it("discovers commands and rejects unsupported invocations without opening SQLite", () => {
  const stdout: string[] = [];
  const io = {
    openAccess: () => { throw new Error("should not open SQLite"); },
    stdout: (text: string) => stdout.push(text),
    stderr: () => {},
  };

  expect(runCommand([], io)).toBe(0);
  expect(JSON.parse(stdout.pop()!)).toMatchObject({
    schemaVersion: 1,
    usage: "rip-dvd-operator <command>",
    commands: expect.arrayContaining([
      expect.objectContaining({ name: "health", inputs: { arguments: [], options: [] } }),
      expect.objectContaining({ name: "readiness", example: "rip-dvd-operator readiness" }),
    ]),
  });
  expect(runCommand(["commands"], io)).toBe(0);
  expect(JSON.parse(stdout.pop()!)).toEqual({
    schemaVersion: 1,
    commands: ["health", "readiness", "commands", "help"],
  });
  expect(runCommand(["health", "--help"], io)).toBe(0);
  expect(JSON.parse(stdout.pop()!)).toMatchObject({
    command: { name: "health", usage: "rip-dvd-operator health" },
  });
  expect(runCommand(["health", "--unexpected"], io)).toBe(2);
  expect(JSON.parse(stdout.pop()!)).toEqual({
    error: { code: "INVALID_ARGUMENTS", message: "health takes no arguments." },
  });
  expect(runCommand(["retired-command"], io)).toBe(2);
  expect(JSON.parse(stdout.pop()!)).toEqual({
    error: { code: "UNKNOWN_COMMAND", message: "Unknown command." },
  });
});

it("returns a stable failure without exposing database errors", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = runCommand(["health"], {
    openAccess: () => { throw new Error("private path and SQLite detail"); },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout[0])).toEqual({
    error: {
      code: "HEALTH_UNAVAILABLE",
      message: "Application health is unavailable.",
    },
  });
  expect(stdout[0]).not.toContain("private path");
  expect(stderr).toEqual(["Application health is unavailable.\n"]);
});

it("runs as a separate process without the web service", () => {
  const paths = fixture();
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const environment = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    RIP_DVD_DATABASE_PATH: paths.databasePath,
    RIP_DVD_MEDIA_LIBRARY_PATH: paths.mediaLibraryPath,
    RIP_DVD_ORIGINALS_LIBRARY_PATH: paths.originalsLibraryPath,
  };
  const invoke = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: environment,
  });

  const health = invoke("health");
  expect(health.status).toBe(0);
  expect(health.stderr).toBe("");
  expect(health.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(health.stdout)).toMatchObject({ status: "ok", journalMode: "wal" });

  const readiness = invoke("readiness");
  expect(readiness.status).toBe(0);
  expect(readiness.stderr).toBe("");
  expect(JSON.parse(readiness.stdout)).toEqual({
    schemaVersion: 1,
    activeWork: [],
    opticalDrives: [],
  });

  const invalid = invoke("health", "--invalid");
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toBe("health takes no arguments.\n");
  expect(JSON.parse(invalid.stdout)).toEqual({
    error: { code: "INVALID_ARGUMENTS", message: "health takes no arguments." },
  });

  const noConfig = spawnSync(process.execPath, [entry, "health"], {
    encoding: "utf8",
    env: {
      NODE_NO_WARNINGS: "1",
    },
  });
  expect(noConfig.status).toBe(1);
  expect(noConfig.stderr).toBe("Application configuration is missing or invalid.\n");
  expect(JSON.parse(noConfig.stdout)).toEqual({
    error: {
      code: "CONFIGURATION_ERROR",
      message: "Application configuration is missing or invalid.",
    },
  });
});
