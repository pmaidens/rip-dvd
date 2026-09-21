import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createNodeDvdEndpointProver,
  DvdReadableEndpointError,
  parseDvdEndpointProof,
} from "./dvd-endpoint-prover.js";

function endpointPayload(firstExcludedLba = 4) {
  return {
    protocolVersion: 1,
    proofVersion: "dvd-normal-endpoint-proof-v1",
    confirmationCount: 2,
    firstExcludedLba,
    classifierVersion: "scsi-read-classifier-v2",
    scsiStatus: 2,
    hostStatus: 0,
    driverStatus: 8,
    senseResponseCode: 0x72,
    senseKey: 0x05,
    asc: 0x21,
    ascq: 0,
  };
}

function createEndpointChild(payload = endpointPayload()) {
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const ready = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  let grantCount = 0;
  let closed = false;
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stderr,
    stdio: [
      null,
      null,
      stderr,
      null,
      null,
      null,
      ready,
      Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        write: vi.fn((_chunk: string, callback: (error?: Error) => void) => {
          callback();
          grantCount += 1;
          queueMicrotask(() => {
            if (grantCount < 4) {
              ready.emit(
                "data",
                Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
              );
              return;
            }
            stderr.emit(
              "data",
              Buffer.from(`rip-dvd-endpoint-proof ${JSON.stringify(payload)}\n`),
            );
            closed = true;
            child.emit("close", 0, null);
          });
          return true;
        }),
      }),
    ],
    kill: vi.fn((signal: NodeJS.Signals) => {
      if (!closed) {
        closed = true;
        queueMicrotask(() => child.emit("close", null, signal));
      }
      return true;
    }),
  });
  queueMicrotask(() => {
    ready.emit(
      "data",
      Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
    );
  });
  return child;
}

function createRejectedEndpointChild(diagnostics: string) {
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const ready = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  let grantCount = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stderr,
    stdio: [
      null,
      null,
      stderr,
      null,
      null,
      null,
      ready,
      Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        write: vi.fn((_chunk: string, callback: (error?: Error) => void) => {
          callback();
          grantCount += 1;
          queueMicrotask(() => {
            if (grantCount < 4) {
              ready.emit(
                "data",
                Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
              );
              return;
            }
            stderr.emit("data", Buffer.from(`${diagnostics}\n`));
            child.emit("close", 1, null);
          });
          return true;
        }),
      }),
    ],
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    ready.emit(
      "data",
      Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
    );
  });
  return child;
}

describe("DVD normal endpoint proof", () => {
  it("requires four authorization fences around two matching reads", async () => {
    const child = createEndpointChild();
    const authorizeProbe = vi.fn();
    const withDeviceInactive = vi.fn(async (
      _devicePath: string,
      operation: () => Promise<void>,
    ) => operation());
    const prover = createNodeDvdEndpointProver({
      copyRunner: { withDeviceInactive },
      spawnProcess: vi.fn(() => child),
      timeoutMs: 1_000,
    });

    await expect(prover.prove({
      authorizeProbe,
      devicePath: "/dev/sr0",
      firstExcludedLba: 4,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      proofVersion: "dvd-normal-endpoint-proof-v1",
      confirmationCount: 2,
      firstExcludedLba: 4,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 0x72,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      },
    });
    expect(authorizeProbe).toHaveBeenCalledTimes(4);
    expect(withDeviceInactive).toHaveBeenCalledWith(
      "/dev/sr0",
      expect.any(Function),
    );
  });

  it("fails closed when a proof contradicts the requested boundary", async () => {
    const child = createEndpointChild(endpointPayload(5));
    const prover = createNodeDvdEndpointProver({
      copyRunner: {
        withDeviceInactive: async (_devicePath, operation) => operation(),
      },
      spawnProcess: () => child,
      timeoutMs: 1_000,
    });

    await expect(prover.prove({
      authorizeProbe() {},
      devicePath: "/dev/sr0",
      firstExcludedLba: 4,
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD endpoint proof is malformed");
  });

  it("classifies readable data at the requested endpoint", async () => {
    const firstExcludedLba = 4;
    const child = createRejectedEndpointChild(
      `DVD endpoint probe rejected first excluded LBA ${firstExcludedLba}: readable_data`,
    );
    const prover = createNodeDvdEndpointProver({
      copyRunner: {
        withDeviceInactive: async (_devicePath, operation) => operation(),
      },
      spawnProcess: () => child,
      timeoutMs: 1_000,
    });

    const rejection = prover.prove({
      authorizeProbe() {},
      devicePath: "/dev/sr0",
      firstExcludedLba,
      signal: new AbortController().signal,
    });
    await expect(rejection).rejects.toBeInstanceOf(DvdReadableEndpointError);
    await expect(rejection).rejects.toMatchObject({ firstExcludedLba });
  });

  it("propagates a failed claim, source, or cancellation fence", async () => {
    const child = createEndpointChild();
    const prover = createNodeDvdEndpointProver({
      copyRunner: {
        withDeviceInactive: async (_devicePath, operation) => operation(),
      },
      spawnProcess: () => child,
      timeoutMs: 1_000,
    });

    await expect(prover.prove({
      authorizeProbe() {
        throw new Error("Archive Request claim changed");
      },
      devicePath: "/dev/sr0",
      firstExcludedLba: 4,
      signal: new AbortController().signal,
    })).rejects.toThrow("Archive Request claim changed");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails closed when the endpoint helper times out", async () => {
    vi.useFakeTimers();
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const ready = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const grant = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: vi.fn(() => true),
    });
    let closed = false;
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stderr,
      stdio: [null, null, stderr, null, null, null, ready, grant],
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (!closed) {
          closed = true;
          queueMicrotask(() => child.emit("close", null, signal));
        }
        return true;
      }),
    });
    const prover = createNodeDvdEndpointProver({
      copyRunner: {
        withDeviceInactive: async (_devicePath, operation) => operation(),
      },
      spawnProcess: () => child,
      timeoutMs: 10,
    });

    try {
      const proof = prover.prove({
        authorizeProbe() {},
        devicePath: "/dev/sr0",
        firstExcludedLba: 4,
        signal: new AbortController().signal,
      });
      const rejected = expect(proof).rejects.toThrow(
        "DVD endpoint proof timed out",
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a readable response", { ...endpointPayload(), senseKey: 0 }],
    ["one confirmation", { ...endpointPayload(), confirmationCount: 1 }],
    ["an unknown classifier", {
      ...endpointPayload(),
      classifierVersion: "future-classifier",
    }],
    ["extra unbounded fields", { ...endpointPayload(), diagnostic: "x" }],
  ])("rejects %s", (_reason, payload) => {
    expect(() => parseDvdEndpointProof(JSON.stringify(payload), 4))
      .toThrow("DVD endpoint proof is malformed");
  });
});
