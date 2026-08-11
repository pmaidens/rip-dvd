import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadLegacyQueueCutoverProtocol,
  serializeLegacyQueueCutoverProtocol,
} from "./legacy-queue-cutover-protocol.js";

const expectedProtocol = {
  version: 1,
  command: "hold-cutover",
  indexes: {
    state: 0,
    release: 1,
    heartbeat: 2,
  },
  states: {
    starting: 0,
    intentReady: 1,
    ready: 2,
    released: 3,
    failed: 4,
  },
  sentinels: {
    abort: "supervisor-abort",
    error: "error",
    intentReady: "intent-ready",
    ready: "ready",
    release: "release",
    released: "released",
    workerError: "worker-error",
  },
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("legacy queue cutover protocol", () => {
  it("loads and serializes the authoritative cross-language contract", () => {
    const protocolPath = resolve(
      import.meta.dirname,
      "../../../../rip_dvd/legacy_queue_cutover_protocol.json",
    );

    const protocol = loadLegacyQueueCutoverProtocol(protocolPath);

    expect(protocol).toEqual(expectedProtocol);
    expect(JSON.parse(serializeLegacyQueueCutoverProtocol(protocol))).toEqual(
      expectedProtocol,
    );
  });

  it("rejects a contract that omits a required participant field", () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-cutover-protocol-"));
    temporaryDirectories.push(root);
    const protocolPath = join(root, "protocol.json");
    const { workerError: _workerError, ...incompleteSentinels } =
      expectedProtocol.sentinels;
    writeFileSync(
      protocolPath,
      JSON.stringify({
        ...expectedProtocol,
        sentinels: incompleteSentinels,
      }),
    );

    expect(() => loadLegacyQueueCutoverProtocol(protocolPath)).toThrow(
      /sentinels\.workerError/,
    );
  });
});
