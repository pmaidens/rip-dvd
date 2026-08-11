import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLegacyQueueCutoverProtocol } from "./legacy-queue-cutover-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("legacy queue cutover protocol", () => {
  it("preserves the stable command and sentinel behavior", () => {
    const protocolPath = resolve(
      import.meta.dirname,
      "../../../../rip_dvd/legacy_queue_cutover_protocol.json",
    );

    const protocol = loadLegacyQueueCutoverProtocol(protocolPath);

    expect(protocol.version).toBe(1);
    expect(protocol.command).toBe("hold-cutover");
    expect(protocol.sentinels).toEqual({
      abort: "supervisor-abort",
      error: "error",
      intentReady: "intent-ready",
      ready: "ready",
      release: "release",
      released: "released",
      workerError: "worker-error",
    });
  });

  it("rejects a contract that omits a required participant field", () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-cutover-protocol-"));
    temporaryDirectories.push(root);
    const protocolPath = join(root, "protocol.json");
    const authoritativeProtocolPath = resolve(
      import.meta.dirname,
      "../../../../rip_dvd/legacy_queue_cutover_protocol.json",
    );
    const incompleteProtocol = JSON.parse(
      readFileSync(authoritativeProtocolPath, "utf8"),
    ) as { sentinels: Record<string, string> };
    delete incompleteProtocol.sentinels.workerError;
    writeFileSync(protocolPath, JSON.stringify(incompleteProtocol));

    expect(() => loadLegacyQueueCutoverProtocol(protocolPath)).toThrow(
      /sentinels\.workerError/,
    );
  });
});
