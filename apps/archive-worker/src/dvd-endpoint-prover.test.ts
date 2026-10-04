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

function createEndpointChild(
  payload = endpointPayload(),
  output = `rip-dvd-endpoint-proof ${JSON.stringify(payload)}\n`,
  exitCode = 0,
) {
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
              Buffer.from(output),
            );
            closed = true;
            child.emit("close", exitCode, null);
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

  it("accepts one valid proof alongside native SCSI diagnostics", async () => {
    const payload = endpointPayload();
    const child = createEndpointChild(payload, [
      "DVD SCSI read command failed: status=2 host=0 driver=8",
      "DVD SCSI read command failed: status=2 host=0 driver=8",
      `rip-dvd-endpoint-proof ${JSON.stringify(payload)}`,
      "DVD helper diagnostic after proof",
      "",
    ].join("\n"));
    const authorizeProbe = vi.fn();
    const prover = createNodeDvdEndpointProver({
      copyRunner: {
        withDeviceInactive: async (_devicePath, operation) => operation(),
      },
      spawnProcess: () => child,
      timeoutMs: 1_000,
    });

    await expect(prover.prove({
      authorizeProbe,
      devicePath: "/dev/sr0",
      firstExcludedLba: 4,
      signal: new AbortController().signal,
    })).resolves.toEqual(parseDvdEndpointProof(JSON.stringify(payload), 4));
    expect(authorizeProbe).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      "diagnostics without a proof",
      "DVD SCSI read command failed: status=2 host=0 driver=8\n",
    ],
    [
      "duplicate proofs",
      Array(2)
        .fill(`rip-dvd-endpoint-proof ${JSON.stringify(endpointPayload())}\n`)
        .join(""),
    ],
    [
      "conflicting proofs",
      [endpointPayload(), endpointPayload(5)]
        .map((payload) => `rip-dvd-endpoint-proof ${JSON.stringify(payload)}\n`)
        .join(""),
    ],
    [
      "a malformed proof alongside a valid proof",
      `rip-dvd-endpoint-proof {malformed}\nrip-dvd-endpoint-proof ${JSON.stringify(endpointPayload())}\n`,
    ],
  ])("fails closed with %s", async (_reason, output) => {
    const child = createEndpointChild(endpointPayload(), output);
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
    })).rejects.toThrow("DVD endpoint proof result is missing");
  });

  it("rejects malformed proof evidence even with diagnostic output", async () => {
    const payload = endpointPayload(5);
    const child = createEndpointChild(payload,
      `DVD SCSI read command failed: status=2 host=0 driver=8\nrip-dvd-endpoint-proof ${JSON.stringify(payload)}\n`,
    );
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

  it("rejects a valid proof when the helper exits unsuccessfully", async () => {
    const child = createEndpointChild(endpointPayload(), undefined, 1);
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
    })).rejects.toThrow("DVD endpoint proof failed");
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
