import { spawn } from "node:child_process";

import {
  DVD_NORMAL_ENDPOINT_PROOF_VERSION,
  type DvdArchiveBoundaryOutOfRangeEvidence,
} from "@rip-dvd/data-access";

import { optionalBoundedText } from "./bounded-text.js";
import type { DvdCopyRunner } from "./dvd-archiver.js";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";

const ENDPOINT_PROOF_PREFIX = "rip-dvd-endpoint-proof ";
const ENDPOINT_PROOF_TIMEOUT_MS = 5 * 60_000;
const MAX_ENDPOINT_OUTPUT_BYTES = 65_536;

export interface DvdNormalEndpointProof {
  proofVersion: typeof DVD_NORMAL_ENDPOINT_PROOF_VERSION;
  confirmationCount: 2;
  firstExcludedLba: number;
  outOfRangeEvidence: DvdArchiveBoundaryOutOfRangeEvidence;
}

export interface DvdEndpointProofRequest {
  authorizeProbe(): void | Promise<void>;
  devicePath: string;
  firstExcludedLba: number;
  signal: AbortSignal;
}

export interface DvdEndpointProver {
  prove(request: DvdEndpointProofRequest): Promise<DvdNormalEndpointProof>;
}

export class DvdReadableEndpointError extends Error {
  readonly firstExcludedLba: number;

  constructor(firstExcludedLba: number) {
    super(
      `DVD endpoint probe found readable data at first excluded LBA ${firstExcludedLba}`,
    );
    this.name = "DvdReadableEndpointError";
    this.firstExcludedLba = firstExcludedLba;
  }
}

interface DvdEndpointReadablePipe {
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

interface DvdEndpointWritablePipe {
  destroy(): void;
  on(event: "error", listener: (error: Error) => void): void;
  write(
    chunk: string,
    callback: (error?: Error | null) => void,
  ): boolean;
}

interface DvdEndpointChildProcess {
  pid?: number;
  stderr: DvdEndpointReadablePipe;
  stdio: Array<
    | DvdEndpointReadablePipe
    | DvdEndpointWritablePipe
    | null
  >;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

type SpawnDvdEndpointProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: readonly [
      "ignore",
      "ignore",
      "pipe",
      "ignore",
      "ignore",
      "ignore",
      "pipe",
      "pipe",
    ];
  },
) => DvdEndpointChildProcess;

function isByte(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 0xff;
}

function isUnsignedShort(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 0xffff;
}

export function parseDvdEndpointProof(
  payload: string,
  firstExcludedLba: number,
): DvdNormalEndpointProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD endpoint proof is malformed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("DVD endpoint proof is malformed");
  }
  const proof = parsed as Record<string, unknown>;
  const expectedKeys = [
    "asc",
    "ascq",
    "classifierVersion",
    "confirmationCount",
    "driverStatus",
    "firstExcludedLba",
    "hostStatus",
    "proofVersion",
    "protocolVersion",
    "scsiStatus",
    "senseKey",
    "senseResponseCode",
  ];
  if (
    JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(expectedKeys) ||
    proof.protocolVersion !== 1 ||
    proof.proofVersion !== DVD_NORMAL_ENDPOINT_PROOF_VERSION ||
    proof.confirmationCount !== 2 ||
    proof.firstExcludedLba !== firstExcludedLba ||
    proof.classifierVersion !== "scsi-read-classifier-v2" ||
    !isByte(proof.scsiStatus) ||
    (proof.scsiStatus & 0xfe) !== 2 ||
    proof.hostStatus !== 0 ||
    !isUnsignedShort(proof.driverStatus) ||
    ((proof.driverStatus & 0x0f) !== 0 &&
      (proof.driverStatus & 0x0f) !== 8) ||
    (proof.senseResponseCode !== 0x70 && proof.senseResponseCode !== 0x72) ||
    proof.senseKey !== 0x05 ||
    proof.asc !== 0x21 ||
    proof.ascq !== 0
  ) {
    throw new Error("DVD endpoint proof is malformed");
  }
  return {
    proofVersion: DVD_NORMAL_ENDPOINT_PROOF_VERSION,
    confirmationCount: 2,
    firstExcludedLba,
    outOfRangeEvidence: {
      classifierVersion: proof.classifierVersion,
      scsiStatus: proof.scsiStatus,
      hostStatus: 0,
      driverStatus: proof.driverStatus,
      senseResponseCode: proof.senseResponseCode,
      senseKey: 0x05,
      asc: 0x21,
      ascq: 0,
    },
  };
}

function runEndpointProofProcess({
  authorizeProbe,
  devicePath,
  firstExcludedLba,
  signal,
  spawnProcess,
  timeoutMs,
}: DvdEndpointProofRequest & {
  spawnProcess: SpawnDvdEndpointProcess;
  timeoutMs: number;
}): Promise<DvdNormalEndpointProof> {
  const child = spawnProcess(
    "rip-dvd-dvdcss-reader",
    ["probe-endpoint-authorized", devicePath, String(firstExcludedLba)],
    {
      shell: false,
      stdio: [
        "ignore",
        "ignore",
        "pipe",
        "ignore",
        "ignore",
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const authorizationReady = child.stdio[6] as
    | DvdEndpointReadablePipe
    | null;
  const authorizationGrant = child.stdio[7] as
    | DvdEndpointWritablePipe
    | null;
  return new Promise((resolve, reject) => {
    let authorizationBuffer = "";
    let authorizationPending = false;
    let authorizationCount = 0;
    let diagnostics = "";
    let preferredError: unknown;
    let cancellationRequested = false;
    const rejectAfterClose = (error: unknown) => {
      preferredError ??= error;
      if (!cancellationRequested) {
        cancellationRequested = true;
        child.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(() => {
      rejectAfterClose(new Error("DVD endpoint proof timed out"));
    }, timeoutMs);
    timeout.unref();
    const onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        rejectAfterClose(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    if (authorizationReady === null || authorizationGrant === null) {
      rejectAfterClose(new Error("DVD endpoint proof streams are unavailable"));
    }
    child.stderr.on("data", (chunk) => {
      if (preferredError !== undefined) {
        return;
      }
      diagnostics += chunk.toString("utf8");
      if (Buffer.byteLength(diagnostics) > MAX_ENDPOINT_OUTPUT_BYTES) {
        rejectAfterClose(new Error("DVD endpoint proof exceeded its output bound"));
      }
    });
    child.stderr.on("error", rejectAfterClose);
    authorizationReady?.on("error", rejectAfterClose);
    authorizationGrant?.on("error", rejectAfterClose);
    authorizationReady?.on("data", (chunk) => {
      if (preferredError !== undefined) {
        return;
      }
      authorizationBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(authorizationBuffer) > 512) {
        rejectAfterClose(new Error("DVD endpoint proof authorization is malformed"));
        return;
      }
      const lines = authorizationBuffer.split("\n");
      authorizationBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (
          line !== "rip-dvd-boundary-probe-authorization-ready" ||
          authorizationPending
        ) {
          rejectAfterClose(new Error("DVD endpoint proof authorization is malformed"));
          return;
        }
        authorizationPending = true;
        const grant = () => {
          if (preferredError !== undefined || authorizationGrant === null) {
            return;
          }
          authorizationGrant.write("1", (error) => {
            if (error != null) {
              rejectAfterClose(error);
              return;
            }
            authorizationPending = false;
            authorizationCount += 1;
          });
        };
        try {
          const authorization = authorizeProbe();
          if (authorization instanceof Promise) {
            void authorization.then(grant, rejectAfterClose);
          } else {
            grant();
          }
        } catch (error) {
          rejectAfterClose(error);
        }
      }
    });
    child.once("error", rejectAfterClose);
    child.once("close", (code, processSignal) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      authorizationReady?.destroy();
      authorizationGrant?.destroy();
      if (preferredError !== undefined) {
        reject(preferredError);
        return;
      }
      if (
        code !== 0 ||
        authorizationPending ||
        authorizationBuffer.length !== 0 ||
        authorizationCount !== 4
      ) {
        const detail = optionalBoundedText(diagnostics, 500);
        if (
          detail ===
            `DVD endpoint probe rejected first excluded LBA ${firstExcludedLba}: readable_data`
        ) {
          reject(new DvdReadableEndpointError(firstExcludedLba));
          return;
        }
        reject(new Error(
          `DVD endpoint proof failed${
            detail
              ? `: ${detail}`
              : ` with ${processSignal ?? `status ${code}`}`
          }`,
        ));
        return;
      }
      const outputLines = diagnostics
        .split("\n")
        .filter((line) => line.length > 0);
      if (
        outputLines.length !== 1 ||
        !outputLines[0].startsWith(ENDPOINT_PROOF_PREFIX)
      ) {
        reject(new Error("DVD endpoint proof result is missing"));
        return;
      }
      try {
        resolve(parseDvdEndpointProof(
          outputLines[0].slice(ENDPOINT_PROOF_PREFIX.length),
          firstExcludedLba,
        ));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function createNodeDvdEndpointProver({
  copyRunner,
  spawnProcess = spawn as unknown as SpawnDvdEndpointProcess,
  timeoutMs = ENDPOINT_PROOF_TIMEOUT_MS,
}: {
  copyRunner: Pick<DvdCopyRunner, "withDeviceInactive">;
  spawnProcess?: SpawnDvdEndpointProcess;
  timeoutMs?: number;
}): DvdEndpointProver {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DVD endpoint proof timeout is invalid");
  }
  return {
    async prove(request) {
      request.signal.throwIfAborted();
      const devicePath = requireSafeOpticalDevicePath(request.devicePath);
      if (
        !Number.isSafeInteger(request.firstExcludedLba) ||
        request.firstExcludedLba <= 0
      ) {
        throw new Error("DVD endpoint proof boundary is invalid");
      }
      let proof: DvdNormalEndpointProof | undefined;
      await copyRunner.withDeviceInactive(devicePath, async () => {
        proof = await runEndpointProofProcess({
          ...request,
          devicePath,
          spawnProcess,
          timeoutMs,
        });
      });
      if (proof === undefined) {
        throw new Error("DVD endpoint proof result is missing");
      }
      return proof;
    },
  };
}
