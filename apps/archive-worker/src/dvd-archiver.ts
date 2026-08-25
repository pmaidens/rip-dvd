import { randomUUID } from "node:crypto";
import {
  type Stats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import {
  link,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createCleanReadArchiveIntegrityEvidence,
  createCorrectedDvdArchiveBoundaryEvidence,
  createUnknownArchiveIntegrityEvidence,
  createWatchableSalvageArchiveIntegrityEvidence,
  type ArchiveIntegrityEvidence,
  type ArchiveJobProgress,
  type ArchiveReadFailureStage,
  type CorrectedDvdArchiveBoundaryEvidence,
} from "@rip-dvd/data-access";
import {
  isDvdFingerprint,
  isDvdMetadataFingerprint,
  type DvdTitleMap,
} from "@rip-dvd/data-access/dvd-scan";

import { requireDvdContentSize } from "./dvd-content-policy.js";
import {
  MAX_ARCHIVE_PATH_BYTES,
  requireSafeArchiveRoot,
} from "./archive-root.js";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";
import { optionalBoundedText } from "./bounded-text.js";
import {
  createBoundedSingleFlightCoordinator,
  type ActiveBoundedProcess,
} from "./bounded-child-process.js";
import {
  DvdReadFailureError,
  DVD_RECOVERY_POLICY_VERSION,
  DVD_READ_FAILURE_RESULT_PREFIX,
  DVD_RECOVERY_RESULT_PREFIX,
  DVD_SECTOR_SIZE_BYTES,
  formatUnvalidatedDvdRecovery,
  formatDvdRecoveryResumeBitmap,
  isProvenDvdBoundaryCandidate,
  parseDvdRecoveryResultProtocol,
  parseDvdReadFailureResultProtocol,
  type DamagedDvdRecoveryResult,
  type DvdRecoveryResult,
  type DvdValidationResult,
  type OutOfRangeDvdReadFailureResult,
  validateDvdRecoveryResult,
  validateResumedDvdRecoveryResult,
} from "./dvd-recovery-contracts.js";
import type { DvdCompletenessProver } from "./dvd-completeness-prover.js";
import {
  DVD_WATCHABLE_SALVAGE_POLICY_VERSION,
  formatRejectedDvdSalvage,
  type DvdSalvageValidator,
} from "./dvd-salvage-validator.js";
import {
  commitDvdBoundaryRescueWorkspace,
  commitDvdRescueWorkspace,
  dvdBoundaryRetentionMapPath,
  dvdRescueWorkspacePaths,
  loadDvdRescueWorkspace,
  recordDvdBoundaryFailure,
  removeDvdRescueWorkspace,
  type DvdRescueIdentity,
  type DvdRescueWorkspace,
  updateDvdRescueWorkspace,
} from "./dvd-rescue-workspace.js";
import {
  defaultDvdRescueWorkspaceLock,
  type DvdRescueWorkspaceLock,
} from "./dvd-rescue-workspace-lock.js";

const MAX_ARCHIVE_RECOVERY_ENTRIES = 4_096;
const MAX_COPY_DIAGNOSTIC_BYTES = 65_536;
const MAX_COPY_PROTOCOL_BYTES = 1_200_000;
const MAX_PROC_ENTRIES = 4_096;
const MAX_PROC_FILE_DESCRIPTORS = 65_536;
const COPY_TIMEOUT_MS = 12 * 60 * 60_000;
const COPY_STALL_TIMEOUT_MS = 30 * 60_000;
const COPY_AUTHORIZATION_READY_TIMEOUT_MS = 5_000;
const COPY_START_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const DEVICE_RECOVERY_LOCK_TIMEOUT_MS = 5_000;
const FLOCK_CONFLICT_EXIT_CODE = 75;
const DVD_READ_FAILURE_EXIT_STATUS = 3;

function dvdArchiveStem(fingerprint: string): string {
  const digest = fingerprint.slice(fingerprint.lastIndexOf(":") + 1);
  return isDvdMetadataFingerprint(fingerprint) ? `dvdmeta-${digest}` : digest;
}

export type DvdCopyContinuation =
  | {
      kind: "damaged";
      imageFilesystemIdentity: string;
      recoveryResult: DamagedDvdRecoveryResult;
    }
  | {
      kind: "boundary";
      imageByteCount: number;
      imageFilesystemIdentity: string;
      readFailure: OutOfRangeDvdReadFailureResult;
    };

export interface DvdCopyRequest {
  authorizeProbe?(): void | Promise<void>;
  authorizeStart?(): void | Promise<void>;
  continuation?: DvdCopyContinuation;
  devicePath: string;
  outputPath: string;
  sizeBytes: number;
  signal: AbortSignal;
  onBytesCopied(bytes: number): void;
}

export interface DvdCopyRunner {
  copy(request: DvdCopyRequest): Promise<DvdRecoveryResult>;
  isActive(devicePath: string, outputPath: string): boolean;
  withDeviceInactive(
    devicePath: string,
    mutation: () => undefined,
  ): Promise<void>;
  waitForInactive(devicePath: string, outputPath: string): Promise<void>;
}

export class DvdArchiveReadFailureError extends DvdReadFailureError {
  readonly retentionError: unknown | null;
  readonly stage: ArchiveReadFailureStage;

  constructor(
    stage: ArchiveReadFailureStage,
    readFailure: DvdReadFailureError["readFailure"],
    retentionError: unknown = null,
  ) {
    super(readFailure);
    this.name = "DvdArchiveReadFailureError";
    this.retentionError = retentionError;
    this.stage = stage;
  }
}

function dvdCopyContinuationProtocol(
  continuation: DvdCopyContinuation | undefined,
  sizeBytes: number,
): {
  authorizationPayload: string;
  helperOperation:
    | "copy-authorized"
    | "resume-authorized"
    | "resume-boundary-authorized";
  imageFilesystemIdentity?: string;
} {
  if (continuation === undefined) {
    return {
      authorizationPayload: "1",
      helperOperation: "copy-authorized",
    };
  }
  if (!/^\d+:[1-9]\d*$/.test(continuation.imageFilesystemIdentity)) {
    throw new Error("DVD rescue image identity is invalid");
  }
  if (continuation.kind === "damaged") {
    return {
      authorizationPayload:
        `1${formatDvdRecoveryResumeBitmap(continuation.recoveryResult)}`,
      helperOperation: "resume-authorized",
      imageFilesystemIdentity: continuation.imageFilesystemIdentity,
    };
  }
  if (
    !Number.isSafeInteger(continuation.imageByteCount) ||
    continuation.imageByteCount < 0 ||
    continuation.imageByteCount >= sizeBytes ||
    continuation.imageByteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
    continuation.imageByteCount !==
      continuation.readFailure.retainedImageByteCount ||
    continuation.imageByteCount >
      continuation.readFailure.firstFailingLba * DVD_SECTOR_SIZE_BYTES
  ) {
    throw new Error("DVD rescue boundary continuation is invalid");
  }
  return {
    authorizationPayload: `1${continuation.imageByteCount}`,
    helperOperation: "resume-boundary-authorized",
    imageFilesystemIdentity: continuation.imageFilesystemIdentity,
  };
}

function dvdCopyContinuationFromWorkspace(
  workspace: DvdRescueWorkspace | null,
): DvdCopyContinuation | undefined {
  if (workspace?.recoveryResult?.outcome === "damaged") {
    return {
      kind: "damaged",
      imageFilesystemIdentity: workspace.imageFilesystemIdentity,
      recoveryResult: workspace.recoveryResult,
    };
  }
  if (
    workspace !== null &&
    workspace.boundaryFailure !== null &&
    workspace.recoveryResult === null
  ) {
    return {
      kind: "boundary",
      imageByteCount: workspace.imageByteCount,
      imageFilesystemIdentity: workspace.imageFilesystemIdentity,
      readFailure: workspace.boundaryFailure,
    };
  }
  return undefined;
}

interface DvdCopyChildProcess {
  pid?: number;
  stdio: [
    null,
    null,
    DvdCopyReadablePipe,
    null,
    DvdCopyReadablePipe,
    DvdCopyWritablePipe,
    DvdCopyReadablePipe?,
    DvdProbeAuthorizationWritablePipe?,
  ];
  stderr: {
    destroy(): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
  };
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

interface DvdCopyReadablePipe {
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

interface DvdCopyWritablePipe {
  destroy(): void;
  end(chunk?: string): void;
}

interface DvdProbeAuthorizationWritablePipe {
  destroy(): void;
  on(event: "error", listener: (error: Error) => void): void;
  write(
    chunk: string,
    callback: (error?: Error | null) => void,
  ): boolean;
}

type SpawnDvdCopyProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: [
      "ignore",
      "ignore",
      "pipe",
      number,
      "pipe",
      "pipe",
      "pipe",
      "pipe",
    ];
  },
) => DvdCopyChildProcess;

interface DvdDeviceLockChildProcess {
  stderr: DvdCopyReadablePipe | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

type SpawnDvdDeviceLockProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "pipe", number];
  },
) => DvdDeviceLockChildProcess;

function openDeviceLock(devicePath: string): number {
  const descriptor = openSync(
    devicePath,
    fsConstants.O_RDONLY |
      fsConstants.O_NONBLOCK |
      fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(devicePath);
    if (
      (!opened.isBlockDevice() && !opened.isCharacterDevice()) ||
      (!linked.isBlockDevice() && !linked.isCharacterDevice()) ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error("DVD archive device lock is unsafe");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function createNodeDvdCopyRunner({
  deviceLockTimeoutMs = DEVICE_RECOVERY_LOCK_TIMEOUT_MS,
  maxActiveCopies = 1,
  requireInactive = requireDeviceInactive,
  spawnLockProcess = spawn as unknown as SpawnDvdDeviceLockProcess,
  spawnProcess = spawn as unknown as SpawnDvdCopyProcess,
  stallTimeoutMs = COPY_STALL_TIMEOUT_MS,
  timeoutMs = COPY_TIMEOUT_MS,
}: {
  deviceLockTimeoutMs?: number;
  maxActiveCopies?: number;
  requireInactive?: (devicePath: string) => void;
  spawnLockProcess?: SpawnDvdDeviceLockProcess;
  spawnProcess?: SpawnDvdCopyProcess;
  stallTimeoutMs?: number;
  timeoutMs?: number;
} = {}): DvdCopyRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DVD archive copy timeout is invalid");
  }
  if (
    !Number.isSafeInteger(deviceLockTimeoutMs) ||
    deviceLockTimeoutMs <= 0
  ) {
    throw new Error("DVD archive recovery lock timeout is invalid");
  }
  if (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new Error("DVD archive copy stall timeout is invalid");
  }
  const copyKey = (devicePath: string, outputPath: string) =>
    JSON.stringify([devicePath, outputPath]);
  const activeCopiesByDevicePath = new Map<string, number>();
  const activeCopiesByOutputPath = new Map<string, number>();
  const incrementActiveCopy = (activeCopies: Map<string, number>, key: string) =>
    activeCopies.set(key, (activeCopies.get(key) ?? 0) + 1);
  const decrementActiveCopy = (activeCopies: Map<string, number>, key: string) => {
    const remaining = (activeCopies.get(key) ?? 1) - 1;
    if (remaining === 0) {
      activeCopies.delete(key);
    } else {
      activeCopies.set(key, remaining);
    }
  };
  const coordinator = createBoundedSingleFlightCoordinator<
    DvdCopyRequest,
    DvdRecoveryResult
  >({
    exhaustedCapacityError: "A DVD archive copy is already active",
    invalidCapacityError: "DVD archive copy capacity is invalid",
    maxActiveProcesses: maxActiveCopies,
    validateReuse() {
      throw new Error("DVD archive copy is still active");
    },
    start(request): ActiveBoundedProcess<DvdRecoveryResult> {
      const continuationProtocol = dvdCopyContinuationProtocol(
        request.continuation,
        request.sizeBytes,
      );
      const lockDescriptor = openDeviceLock(request.devicePath);
      let child: DvdCopyChildProcess;
      try {
        child = spawnProcess(
          "flock",
          [
            "--exclusive",
            "--nonblock",
            "--no-fork",
            "--conflict-exit-code",
            String(FLOCK_CONFLICT_EXIT_CODE),
            "/proc/self/fd/3",
            "rip-dvd-dvdcss-reader",
            continuationProtocol.helperOperation,
            requireSafeOpticalDevicePath(request.devicePath),
            request.outputPath,
            String(requireDvdContentSize(request.sizeBytes)),
            ...(continuationProtocol.imageFilesystemIdentity === undefined
              ? []
              : [continuationProtocol.imageFilesystemIdentity]),
          ],
          {
            shell: false,
            stdio: [
              "ignore",
              "ignore",
              "pipe",
              lockDescriptor,
              "pipe",
              "pipe",
              "pipe",
              "pipe",
            ],
          },
        );
      } finally {
        closeSync(lockDescriptor);
      }
      let operationSettled = false;
      let processClosed = false;
      let cancellationRequested = false;
      let authorizationStarted = false;
      let authorizationSettled = false;
      let authorizationBuffer = "";
      let probeAuthorizationBuffer = "";
      let probeAuthorizationPending = false;
      let progressBuffer = "";
      let highestCopiedBytes = 0;
      let diagnostics = "";
      let recoveryResultPayload: string | undefined;
      let readFailureResultPayload: string | undefined;
      let resolveResult!: (result: DvdRecoveryResult) => void;
      let rejectResult!: (reason: unknown) => void;
      let resolveClosed!: () => void;
      let stallTimeout: ReturnType<typeof setTimeout> | undefined;
      let probeAuthorizationTimeout: ReturnType<typeof setTimeout> | undefined;
      const result = new Promise<DvdRecoveryResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const rejectOperation = (error: unknown) => {
        if (!operationSettled) {
          operationSettled = true;
          rejectResult(error);
        }
      };
      const resolveOperation = (recoveryResult: DvdRecoveryResult) => {
        if (!operationSettled) {
          operationSettled = true;
          resolveResult(recoveryResult);
        }
      };
      const confirmClosed = () => {
        if (!processClosed) {
          processClosed = true;
          resolveClosed();
        }
      };
      const cancel = () => {
        if (cancellationRequested || processClosed) {
          return;
        }
        cancellationRequested = true;
        clearTimeout(stallTimeout);
        clearTimeout(probeAuthorizationTimeout);
        child.stderr.destroy();
        child.stdio[4].destroy();
        child.stdio[5].destroy();
        child.stdio[6]?.destroy();
        child.stdio[7]?.destroy();
        try {
          child.kill("SIGKILL");
        } finally {
          // A device read can remain blocked in the kernel after SIGKILL. It
          // must not retain parent event-loop handles while its tombstone
          // continues to protect the live output path.
          child.unref();
        }
      };
      const armStallTimeout = () => {
        clearTimeout(stallTimeout);
        stallTimeout = setTimeout(() => {
          rejectOperation(new Error("DVD archive copy stalled"));
          cancel();
        }, stallTimeoutMs);
        stallTimeout.unref();
      };
      const authorizationReadyTimeout = setTimeout(() => {
        if (!authorizationSettled) {
          authorizationSettled = true;
          rejectOperation(
            new Error("DVD archive copy authorization readiness timed out"),
          );
          cancel();
        }
      }, COPY_AUTHORIZATION_READY_TIMEOUT_MS);
      authorizationReadyTimeout.unref();
      let startAuthorizationTimeout: ReturnType<typeof setTimeout> | undefined;
      child.stdio[4].on("data", (chunk) => {
        if (
          authorizationStarted ||
          authorizationSettled ||
          cancellationRequested
        ) {
          return;
        }
        authorizationBuffer = `${authorizationBuffer}${chunk.toString("utf8")}`
          .slice(-128);
        if (!authorizationBuffer.includes("rip-dvd-copy-authorization-ready\n")) {
          return;
        }
        authorizationStarted = true;
        clearTimeout(authorizationReadyTimeout);
        startAuthorizationTimeout = setTimeout(() => {
          if (!authorizationSettled) {
            authorizationSettled = true;
            rejectOperation(new Error("DVD archive copy authorization timed out"));
            cancel();
          }
        }, COPY_START_AUTHORIZATION_TIMEOUT_MS);
        startAuthorizationTimeout.unref();
        const grantAuthorization = () => {
          if (authorizationSettled || cancellationRequested || processClosed) {
            return;
          }
          authorizationSettled = true;
          clearTimeout(startAuthorizationTimeout);
          child.stdio[5].end(continuationProtocol.authorizationPayload);
          armStallTimeout();
        };
        const rejectAuthorization = (error: unknown) => {
          if (authorizationSettled) {
            return;
          }
          authorizationSettled = true;
          clearTimeout(startAuthorizationTimeout);
          rejectOperation(error);
          cancel();
        };
        try {
          const authorization = request.authorizeStart?.();
          if (authorization instanceof Promise) {
            void authorization.then(grantAuthorization, rejectAuthorization);
          } else {
            grantAuthorization();
          }
        } catch (error) {
          rejectAuthorization(error);
        }
      });
      const rejectProbeAuthorization = (error: unknown) => {
        if (!probeAuthorizationPending) {
          return;
        }
        probeAuthorizationPending = false;
        clearTimeout(probeAuthorizationTimeout);
        rejectOperation(error);
        cancel();
      };
      const grantProbeAuthorization = () => {
        if (
          !probeAuthorizationPending ||
          cancellationRequested ||
          processClosed
        ) {
          return;
        }
        const probeAuthorization = child.stdio[7];
        if (probeAuthorization === undefined) {
          rejectProbeAuthorization(
            new Error("DVD boundary probe authorization is unavailable"),
          );
          return;
        }
        const completeProbeAuthorization = (error?: Error | null) => {
          if (error != null) {
            rejectProbeAuthorization(error);
            return;
          }
          if (
            !probeAuthorizationPending ||
            cancellationRequested ||
            processClosed
          ) {
            return;
          }
          probeAuthorizationPending = false;
          clearTimeout(probeAuthorizationTimeout);
          armStallTimeout();
        };
        try {
          probeAuthorization.write("1", completeProbeAuthorization);
        } catch (error) {
          rejectProbeAuthorization(error);
        }
      };
      const requestProbeAuthorization = () => {
        if (probeAuthorizationPending) {
          rejectOperation(
            new Error("DVD boundary probe authorization overlapped"),
          );
          cancel();
          return;
        }
        probeAuthorizationPending = true;
        clearTimeout(stallTimeout);
        probeAuthorizationTimeout = setTimeout(() => {
          rejectProbeAuthorization(
            new Error("DVD boundary probe authorization timed out"),
          );
        }, COPY_START_AUTHORIZATION_TIMEOUT_MS);
        probeAuthorizationTimeout.unref();
        try {
          if (request.authorizeProbe === undefined) {
            throw new Error("DVD boundary probe authorization is unavailable");
          }
          const authorization = request.authorizeProbe();
          if (authorization instanceof Promise) {
            void authorization.then(
              grantProbeAuthorization,
              rejectProbeAuthorization,
            );
          } else {
            grantProbeAuthorization();
          }
        } catch (error) {
          rejectProbeAuthorization(error);
        }
      };
      child.stdio[7]?.on("error", (error) => {
        if (operationSettled || cancellationRequested || processClosed) {
          return;
        }
        if (probeAuthorizationPending) {
          rejectProbeAuthorization(error);
          return;
        }
        rejectOperation(error);
        cancel();
      });
      child.stdio[6]?.on("data", (chunk) => {
        if (operationSettled || cancellationRequested) {
          return;
        }
        probeAuthorizationBuffer += chunk.toString("utf8");
        if (probeAuthorizationBuffer.length > 256) {
          rejectOperation(
            new Error("DVD boundary probe authorization is malformed"),
          );
          cancel();
          return;
        }
        const lines = probeAuthorizationBuffer.split("\n");
        probeAuthorizationBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line !== "rip-dvd-boundary-probe-authorization-ready") {
            rejectOperation(
              new Error("DVD boundary probe authorization is malformed"),
            );
            cancel();
            return;
          }
          requestProbeAuthorization();
        }
      });
      const appendDiagnostic = (text: string) => {
        const diagnostic = text.trim();
        if (diagnostic.length === 0) {
          return;
        }
        diagnostics = `${diagnostics}${diagnostics ? "\n" : ""}${diagnostic}`.slice(
          -MAX_COPY_DIAGNOSTIC_BYTES,
        );
      };
      const parseCopyOutput = (text: string, flush = false) => {
        progressBuffer += text;
        if (progressBuffer.length > MAX_COPY_PROTOCOL_BYTES) {
          throw new Error("DVD recovery helper output exceeded its bound");
        }
        const segments = progressBuffer.split(/[\r\n]/);
        progressBuffer = flush ? "" : (segments.pop() ?? "");
        for (const segment of segments) {
          if (segment.startsWith(DVD_RECOVERY_RESULT_PREFIX)) {
            if (
              recoveryResultPayload !== undefined ||
              readFailureResultPayload !== undefined
            ) {
              throw new Error("DVD terminal helper result is malformed");
            }
            recoveryResultPayload = segment.slice(
              DVD_RECOVERY_RESULT_PREFIX.length,
            );
            continue;
          }
          if (segment.startsWith(DVD_READ_FAILURE_RESULT_PREFIX)) {
            if (
              recoveryResultPayload !== undefined ||
              readFailureResultPayload !== undefined
            ) {
              throw new Error("DVD terminal helper result is malformed");
            }
            readFailureResultPayload = segment.slice(
              DVD_READ_FAILURE_RESULT_PREFIX.length,
            );
            continue;
          }
          const match = /^\s*(\d+)\s+bytes\b/.exec(segment);
          const bytes = match ? Number(match[1]) : Number.NaN;
          if (Number.isSafeInteger(bytes) && bytes >= 0) {
            if (bytes > highestCopiedBytes) {
              highestCopiedBytes = bytes;
              armStallTimeout();
            }
            request.onBytesCopied(bytes);
          } else {
            appendDiagnostic(segment);
          }
        }
      };

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (operationSettled || cancellationRequested) {
          return;
        }
        try {
          parseCopyOutput(text);
        } catch (error) {
          rejectOperation(error);
          cancel();
        }
      });
      child.once("error", (error) => {
        rejectOperation(error);
        // A spawn failure proves that there is no child left to reap. Other
        // process errors retain the tombstone until `close` is observed.
        if (child.pid === undefined) {
          confirmClosed();
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(authorizationReadyTimeout);
        clearTimeout(startAuthorizationTimeout);
        clearTimeout(stallTimeout);
        clearTimeout(probeAuthorizationTimeout);
        confirmClosed();
        if (cancellationRequested) {
          rejectOperation(new Error("DVD archive copy was cancelled"));
          return;
        }
        if (code === FLOCK_CONFLICT_EXIT_CODE) {
          rejectOperation(new Error("DVD archive device is still active"));
          return;
        }
        try {
          parseCopyOutput("", true);
        } catch (error) {
          rejectOperation(error);
          return;
        }
        if (code === 0) {
          if (
            recoveryResultPayload === undefined ||
            readFailureResultPayload !== undefined
          ) {
            rejectOperation(new Error("DVD recovery helper result is missing"));
            return;
          }
          try {
            resolveOperation(
              parseDvdRecoveryResultProtocol(
                recoveryResultPayload,
                request.sizeBytes,
              ),
            );
          } catch (error) {
            rejectOperation(error);
          }
          return;
        }
        if (
          code === DVD_READ_FAILURE_EXIT_STATUS &&
          readFailureResultPayload !== undefined &&
          recoveryResultPayload === undefined
        ) {
          try {
            rejectOperation(
              new DvdReadFailureError(
                parseDvdReadFailureResultProtocol(
                  readFailureResultPayload,
                  request.sizeBytes,
                ),
              ),
            );
          } catch (error) {
            rejectOperation(error);
          }
          return;
        }
        if (
          code === DVD_READ_FAILURE_EXIT_STATUS ||
          readFailureResultPayload !== undefined
        ) {
          rejectOperation(
            new Error("DVD read failure helper result is invalid"),
          );
          return;
        }
        const detail = optionalBoundedText(diagnostics, 500);
        rejectOperation(
          new Error(
            `DVD archive copy failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${code}`}`}`,
          ),
        );
      });

      incrementActiveCopy(activeCopiesByDevicePath, request.devicePath);
      incrementActiveCopy(activeCopiesByOutputPath, request.outputPath);
      void closed.then(() => {
        decrementActiveCopy(activeCopiesByDevicePath, request.devicePath);
        decrementActiveCopy(activeCopiesByOutputPath, request.outputPath);
      });

      return { result, closed, cancel };
    },
  });

  return {
    copy(request) {
      const safeDevicePath = requireSafeOpticalDevicePath(request.devicePath);
      if (activeCopiesByOutputPath.has(request.outputPath)) {
        return Promise.reject(new Error("DVD archive copy is still active"));
      }
      requirePartialInactive(request.outputPath);
      requireInactive(safeDevicePath);
      return coordinator.run(copyKey(safeDevicePath, request.outputPath), request, {
        signal: request.signal,
        timeoutError: "DVD archive copy timed out",
        timeoutMs,
      });
    },
    isActive(devicePath, outputPath) {
      const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
      if (
        activeCopiesByOutputPath.has(outputPath) ||
        coordinator.isActive(copyKey(safeDevicePath, outputPath))
      ) {
        return true;
      }
      try {
        requirePartialInactive(outputPath);
        return false;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "DVD archive copy is still active"
        ) {
          return true;
        }
        throw error;
      }
    },
    withDeviceInactive(devicePath, mutation) {
      const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
      if (activeCopiesByDevicePath.has(safeDevicePath)) {
        throw new Error("DVD archive copy is still active");
      }
      return withExclusiveDeviceInactivity(
        safeDevicePath,
        mutation,
        requireInactive,
        spawnLockProcess,
        deviceLockTimeoutMs,
      );
    },
    waitForInactive(devicePath, outputPath) {
      return coordinator.waitForInactive(
        copyKey(requireSafeOpticalDevicePath(devicePath), outputPath),
      );
    },
  };
}

function isVanishedProcEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function requireSameOwnerInodeInactive(
  target: Stats,
  ownerUid: number,
  activeError: string,
  ambiguousError: string,
): void {
  let processDirectory;
  try {
    processDirectory = opendirSync("/proc");
  } catch {
    throw new Error(ambiguousError);
  }

  let processCount = 0;
  let descriptorCount = 0;
  try {
    let processEntry;
    while ((processEntry = processDirectory.readSync()) !== null) {
      if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) {
        continue;
      }
      processCount += 1;
      if (processCount > MAX_PROC_ENTRIES) {
        throw new Error(ambiguousError);
      }
      let processMetadata;
      try {
        processMetadata = statSync(`/proc/${processEntry.name}`);
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        throw new Error(ambiguousError);
      }
      if (processMetadata.uid !== ownerUid) {
        continue;
      }
      let descriptorDirectory;
      try {
        descriptorDirectory = opendirSync(`/proc/${processEntry.name}/fd`);
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        throw new Error(ambiguousError);
      }
      try {
        let descriptorEntry;
        while ((descriptorEntry = descriptorDirectory.readSync()) !== null) {
          descriptorCount += 1;
          if (descriptorCount > MAX_PROC_FILE_DESCRIPTORS) {
            throw new Error(ambiguousError);
          }
          try {
            const opened = statSync(
              `/proc/${processEntry.name}/fd/${descriptorEntry.name}`,
            );
            if (opened.dev === target.dev && opened.ino === target.ino) {
              throw new Error(activeError);
            }
          } catch (error) {
            if (isVanishedProcEntry(error)) {
              continue;
            }
            if (
              error instanceof Error &&
              error.message === activeError
            ) {
              throw error;
            }
            throw new Error(ambiguousError);
          }
        }
      } finally {
        descriptorDirectory.closeSync();
      }
    }
  } finally {
    processDirectory.closeSync();
  }
}

function requireDeviceInactive(devicePath: string): void {
  const device = lstatSync(devicePath);
  if (
    device.isSymbolicLink() ||
    (!device.isBlockDevice() && !device.isCharacterDevice()) ||
    process.geteuid === undefined
  ) {
    throw new Error("DVD archive device path is unsafe");
  }
  requireSameOwnerInodeInactive(
    device,
    process.geteuid(),
    "DVD archive device is still active",
    "Could not prove the DVD archive device is inactive",
  );
}

async function withExclusiveDeviceInactivity(
  devicePath: string,
  mutation: () => undefined,
  requireInactive: (devicePath: string) => void,
  spawnLockProcess: SpawnDvdDeviceLockProcess,
  timeoutMs: number,
): Promise<void> {
  // The scan catches pre-lock and pre-upgrade readers. Acquiring the same
  // inode flock used by copy then closes the gap through the mutation.
  requireInactive(devicePath);
  const lockDescriptor = openDeviceLock(devicePath);
  let child: DvdDeviceLockChildProcess;
  try {
    child = spawnLockProcess(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONFLICT_EXIT_CODE),
        "3",
      ],
      {
        shell: false,
        stdio: ["ignore", "ignore", "pipe", lockDescriptor] as const,
      },
    );
  } catch (error) {
    closeSync(lockDescriptor);
    throw error;
  }
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  const childDiagnostics = child.stderr;
  if (childDiagnostics === null) {
    child.kill("SIGKILL");
    child.unref();
    closeSync(lockDescriptor);
    throw new Error("DVD archive device lock streams are unavailable");
  }
  let stderr = "";
  let spawnError: unknown;
  child.once("error", (error) => {
    spawnError = error;
  });
  childDiagnostics.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_024);
  });
  let acquisitionTimedOut = false;
  let acquisitionTimeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    closed,
    new Promise<undefined>((resolveTimeout) => {
      acquisitionTimeout = setTimeout(() => {
        acquisitionTimedOut = true;
        child.kill("SIGKILL");
        resolveTimeout(undefined);
      }, timeoutMs);
      acquisitionTimeout.unref();
    }),
  ]);
  clearTimeout(acquisitionTimeout);
  if (acquisitionTimedOut || outcome === undefined) {
    childDiagnostics.destroy();
    child.unref();
    closeSync(lockDescriptor);
    throw new Error("DVD archive device lock timed out");
  }
  if (spawnError !== undefined || outcome.code !== 0) {
    closeSync(lockDescriptor);
    if (outcome.code === FLOCK_CONFLICT_EXIT_CODE) {
      throw new Error("DVD archive device is still active");
    }
    if (spawnError !== undefined) {
      throw spawnError;
    }
    const detail = optionalBoundedText(stderr, 500);
    throw new Error(
      `DVD archive device lock failed${
        detail
          ? `: ${detail}`
          : ` with ${outcome.signal ?? `status ${outcome.code}`}`
      }`,
    );
  }
  try {
    mutation();
  } finally {
    // Descriptor-mode `flock(1)` locks the inherited open-file description.
    // Retaining the parent's descriptor after that short process exits keeps
    // exclusion authoritative for the whole synchronous mutation.
    closeSync(lockDescriptor);
  }
}

function requirePartialInactive(partialPath: string): void {
  let partial;
  try {
    partial = lstatSync(partialPath);
  } catch (error) {
    if (isVanishedProcEntry(error)) {
      return;
    }
    throw error;
  }
  if (!partial.isFile() || partial.isSymbolicLink()) {
    throw new Error("DVD archive partial path is unsafe");
  }
  requireSameOwnerInodeInactive(
    partial,
    partial.uid,
    "DVD archive copy is still active",
    "Could not prove the DVD archive partial is inactive",
  );
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function discoverAttemptPartialPaths(root: string, digest: string): string[] {
  const prefix = `.${digest}.`;
  const suffix = ".iso.rip-dvd-partial";
  const partialPaths: string[] = [];
  let directory;
  try {
    directory = opendirSync(root);
  } catch {
    throw new Error("Could not safely discover DVD archive partials");
  }
  let entryCount = 0;
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_RECOVERY_ENTRIES) {
        throw new Error("DVD archive partial recovery exceeds the safety limit");
      }
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) {
        continue;
      }
      const attemptId = entry.name.slice(prefix.length, -suffix.length);
      if (UUID_V4_PATTERN.test(attemptId)) {
        partialPaths.push(join(root, entry.name));
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "DVD archive partial recovery exceeds the safety limit"
    ) {
      throw error;
    }
    throw new Error("Could not safely discover DVD archive partials");
  } finally {
    directory.closeSync();
  }
  return partialPaths.sort();
}

export async function withCancelledDvdArchiveInactive({
  archiveRequestId,
  devicePath,
  fingerprint,
  mutation,
  originalsLibraryPath,
  runner,
  signal = new AbortController().signal,
  workspaceLock = defaultDvdRescueWorkspaceLock,
}: {
  archiveRequestId?: string;
  devicePath: string;
  fingerprint: string;
  mutation: () => undefined;
  originalsLibraryPath: string;
  runner: DvdCopyRunner;
  signal?: AbortSignal;
  workspaceLock?: DvdRescueWorkspaceLock;
}): Promise<void> {
  const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
  if (!isDvdFingerprint(fingerprint)) {
    throw new Error("Detected Disc fingerprint is invalid");
  }
  const root = await requireSafeArchiveRoot(originalsLibraryPath);
  const digest = dvdArchiveStem(fingerprint);
  const task = () =>
    runner.withDeviceInactive(safeDevicePath, () => {
      const partialPaths = [
        join(root, `.${digest}.iso.rip-dvd-partial`),
        ...discoverAttemptPartialPaths(root, digest),
        ...(archiveRequestId === undefined
          ? []
          : [dvdRescueWorkspacePaths(root, archiveRequestId).imagePath]),
      ];
      for (const partialPath of partialPaths) {
        if (runner.isActive(safeDevicePath, partialPath)) {
          throw new Error("DVD archive copy is still active");
        }
        requirePartialInactive(partialPath);
      }
      mutation();
      return undefined;
    });
  return archiveRequestId === undefined
    ? task()
    : workspaceLock.withLock({
        fingerprint,
        originalsLibraryPath: root,
        signal,
        task,
      });
}

export interface PreserveDvdArchiveOptions {
  archiveRequestId?: string;
  authorizeCopy?(): void | Promise<void>;
  authorizeMutation?(): void | Promise<void>;
  devicePath: string;
  completenessProver?: DvdCompletenessProver;
  fingerprint: string;
  expectedTitleMap?: DvdTitleMap;
  originalsLibraryPath: string;
  runner: DvdCopyRunner;
  salvageValidator?: DvdSalvageValidator;
  revalidateReadFailure?(): void | Promise<void>;
  signal: AbortSignal;
  sizeBytes: number;
  sync?(path: string): Promise<void>;
  verifySource(): Promise<void>;
  onProgress(progress: ArchiveJobProgress): void;
}

export interface PreservedDvdArchive {
  archivePath: string;
  archiveFilesystemIdentity: string;
  correctedBoundaryEvidence?: CorrectedDvdArchiveBoundaryEvidence;
  finalizePublication?(): Promise<void>;
  integrityEvidence: ArchiveIntegrityEvidence;
  recovered: boolean;
  sizeBytes: number;
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function movePartialAside(
  partialPath: string,
  authorizeMutation?: () => void | Promise<void>,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(partialPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("DVD archive partial path is not a regular file");
  }
  const failedPath = `${partialPath}.failed`;
  try {
    const failedMetadata = await lstat(failedPath);
    if (!failedMetadata.isFile() || failedMetadata.isSymbolicLink()) {
      throw new Error("DVD archive failed path is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await authorizeMutation?.();
  await rename(partialPath, failedPath);
}

export async function quarantinePublishedArchive(
  archivePath: string,
  expectedFilesystemIdentity: string,
  authorizeMutation?: () => void | Promise<void>,
): Promise<void> {
  const metadata = await optionalMetadata(archivePath);
  if (metadata === null) {
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Published DVD archive path is not a regular file");
  }
  if (filesystemIdentity(metadata) !== expectedFilesystemIdentity) {
    throw new Error("Published DVD archive changed before cleanup");
  }
  const failedPath = `${archivePath}.failed`;
  const failedMetadata = await optionalMetadata(failedPath);
  if (
    failedMetadata !== null &&
    (!failedMetadata.isFile() || failedMetadata.isSymbolicLink())
  ) {
    throw new Error("Published DVD archive failed path is not a regular file");
  }
  const revalidated = await lstat(archivePath);
  if (filesystemIdentity(revalidated) !== expectedFilesystemIdentity) {
    throw new Error("Published DVD archive changed before cleanup");
  }
  await authorizeMutation?.();
  if (
    failedMetadata !== null &&
    failedMetadata.dev === revalidated.dev &&
    failedMetadata.ino === revalidated.ino
  ) {
    await unlink(archivePath);
  } else {
    await rename(archivePath, failedPath);
  }
  await syncPath(dirname(archivePath));
}

async function optionalMetadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function filesystemIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
): string {
  if (
    !Number.isSafeInteger(metadata.dev) ||
    !Number.isSafeInteger(metadata.ino) ||
    metadata.dev < 0 ||
    metadata.ino <= 0
  ) {
    throw new Error("DVD archive filesystem identity is invalid");
  }
  return `${metadata.dev}:${metadata.ino}`;
}

function matchesRescueImageIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expectedIdentity: string,
  expectedSizeBytes: number,
): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size === expectedSizeBytes &&
    `${metadata.dev}:${metadata.ino}` === expectedIdentity
  );
}

type DvdSalvageDecision =
  | {
      outcome: "publish";
      integrityEvidence: ReturnType<
        typeof createWatchableSalvageArchiveIntegrityEvidence
      >;
    }
  | {
      outcome: "reject";
      error: Error;
    };

async function evaluateDvdSalvage({
  expectedTitleMap,
  imagePath,
  recoveryResult,
  salvageValidator,
  signal,
}: {
  expectedTitleMap?: DvdTitleMap;
  imagePath: string;
  recoveryResult: DamagedDvdRecoveryResult;
  salvageValidator?: DvdSalvageValidator;
  signal: AbortSignal;
}): Promise<DvdSalvageDecision> {
  let salvageValidation;
  if (salvageValidator !== undefined) {
    if (expectedTitleMap === undefined) {
      throw new Error(
        "DVD salvage validation requires the inspected title map",
      );
    }
    salvageValidation = await salvageValidator.validate({
      expectedTitleMap,
      imagePath,
      recoveryResult,
      signal,
    });
  }
  signal.throwIfAborted();
  if (salvageValidation?.outcome === "accepted") {
    return {
      outcome: "publish",
      integrityEvidence: createWatchableSalvageArchiveIntegrityEvidence(
        DVD_WATCHABLE_SALVAGE_POLICY_VERSION,
        recoveryResult.unrecoveredSectorRanges,
        salvageValidation.badSectorCountsByTitle,
      ),
    };
  }
  return {
    outcome: "reject",
    error: new Error(
      salvageValidation?.outcome === "rejected"
        ? formatRejectedDvdSalvage(salvageValidation.reason, recoveryResult)
        : formatUnvalidatedDvdRecovery(recoveryResult),
    ),
  };
}

async function publishDvdArchiveLink({
  archivePath,
  expectedFilesystemIdentity,
  expectedSizeBytes,
  mismatchMessage,
  removeSourceAfterLink,
  root,
  sourcePath,
  sync,
}: {
  archivePath: string;
  expectedFilesystemIdentity: string;
  expectedSizeBytes: number;
  mismatchMessage: string;
  removeSourceAfterLink: boolean;
  root: string;
  sourcePath: string;
  sync(path: string): Promise<void>;
}): Promise<string> {
  let published = false;
  let publishedFilesystemIdentity = expectedFilesystemIdentity;
  try {
    await link(sourcePath, archivePath);
    published = true;
    const publishedArchive = await lstat(archivePath);
    publishedFilesystemIdentity = filesystemIdentity(publishedArchive);
    if (
      !matchesRescueImageIdentity(
        publishedArchive,
        expectedFilesystemIdentity,
        expectedSizeBytes,
      )
    ) {
      throw new Error(mismatchMessage);
    }
    if (removeSourceAfterLink) {
      await unlink(sourcePath);
    }
    await sync(root);
    return publishedFilesystemIdentity;
  } catch (error) {
    if (published) {
      await quarantinePublishedArchive(
        archivePath,
        publishedFilesystemIdentity,
      );
    }
    throw error;
  }
}

async function publishCorrectedDvdBoundary({
  archivePath,
  authorizeMutation,
  boundaryFailure,
  completenessProver,
  existingPublishedFilesystemIdentity,
  expectedTitleMap,
  onProgress,
  rescueWorkspace,
  root,
  signal,
  sync,
  verifySource,
}: {
  archivePath: string;
  authorizeMutation?: () => void | Promise<void>;
  boundaryFailure: OutOfRangeDvdReadFailureResult;
  completenessProver: DvdCompletenessProver;
  existingPublishedFilesystemIdentity?: string;
  expectedTitleMap: DvdTitleMap;
  onProgress(progress: ArchiveJobProgress): void;
  rescueWorkspace: DvdRescueWorkspace;
  root: string;
  signal: AbortSignal;
  sync(path: string): Promise<void>;
  verifySource(): Promise<void>;
}): Promise<PreservedDvdArchive> {
  if (!isProvenDvdBoundaryCandidate(boundaryFailure)) {
    throw new Error("DVD corrected-boundary candidate is not proven");
  }
  const publishedSizeBytes =
    boundaryFailure.firstFailingLba * DVD_SECTOR_SIZE_BYTES;
  await authorizeMutation?.();
  signal.throwIfAborted();
  await verifySource();
  signal.throwIfAborted();
  await authorizeMutation?.();
  signal.throwIfAborted();
  onProgress({ phase: "verifying", progressPercent: 99 });
  await sync(rescueWorkspace.imagePath);
  signal.throwIfAborted();
  const imageBefore = await lstat(rescueWorkspace.imagePath);
  if (
    !matchesRescueImageIdentity(
      imageBefore,
      rescueWorkspace.imageFilesystemIdentity,
      publishedSizeBytes,
    )
  ) {
    throw new Error("DVD corrected-boundary image is invalid");
  }
  const proof = await completenessProver.prove({
    candidateBoundaryLba: boundaryFailure.firstFailingLba,
    expectedTitleMap,
    imagePath: rescueWorkspace.imagePath,
    signal,
  });
  signal.throwIfAborted();
  await verifySource();
  signal.throwIfAborted();
  await authorizeMutation?.();
  signal.throwIfAborted();
  const imageAfter = await lstat(rescueWorkspace.imagePath);
  if (
    !matchesRescueImageIdentity(
      imageAfter,
      rescueWorkspace.imageFilesystemIdentity,
      publishedSizeBytes,
    ) ||
    imageAfter.mtimeMs !== imageBefore.mtimeMs ||
    imageAfter.ctimeMs !== imageBefore.ctimeMs
  ) {
    throw new Error("DVD corrected-boundary image changed during validation");
  }
  const correctedBoundaryEvidence =
    createCorrectedDvdArchiveBoundaryEvidence({
      reportedSizeBytes: boundaryFailure.declaredByteCount,
      publishedSizeBytes,
      firstExcludedLba: boundaryFailure.firstFailingLba,
      maximumReferencedLba: proof.maximumReferencedLba,
      outOfRangeEvidence: {
        classifierVersion: boundaryFailure.classifierVersion,
        scsiStatus: boundaryFailure.scsiStatus,
        hostStatus: boundaryFailure.hostStatus,
        driverStatus: boundaryFailure.driverStatus,
        senseResponseCode: boundaryFailure.senseResponseCode,
        senseKey: boundaryFailure.senseKey,
        asc: boundaryFailure.asc,
        ascq: boundaryFailure.ascq,
      },
    });
  onProgress({ phase: "finalizing", progressPercent: 99 });
  await sync(rescueWorkspace.imagePath);
  signal.throwIfAborted();
  await authorizeMutation?.();
  signal.throwIfAborted();
  let publishedFilesystemIdentity: string;
  if (existingPublishedFilesystemIdentity === undefined) {
    publishedFilesystemIdentity = await publishDvdArchiveLink({
      archivePath,
      expectedFilesystemIdentity: rescueWorkspace.imageFilesystemIdentity,
      expectedSizeBytes: publishedSizeBytes,
      mismatchMessage:
        "Published corrected DVD archive changed before verification",
      removeSourceAfterLink: false,
      root,
      sourcePath: rescueWorkspace.imagePath,
      sync,
    });
  } else {
    const publishedArchive = await lstat(archivePath);
    publishedFilesystemIdentity = filesystemIdentity(publishedArchive);
    if (
      publishedFilesystemIdentity !== existingPublishedFilesystemIdentity ||
      !matchesRescueImageIdentity(
        publishedArchive,
        rescueWorkspace.imageFilesystemIdentity,
        publishedSizeBytes,
      )
    ) {
      throw new Error(
        "Existing corrected DVD archive conflicts with rescue state",
      );
    }
    await sync(root);
  }
  return {
    archivePath,
    archiveFilesystemIdentity: publishedFilesystemIdentity,
    correctedBoundaryEvidence,
    finalizePublication: () =>
      removeDvdRescueWorkspace(root, rescueWorkspace),
    integrityEvidence: createCleanReadArchiveIntegrityEvidence(
      DVD_RECOVERY_POLICY_VERSION,
    ),
    recovered: false,
    sizeBytes: publishedSizeBytes,
  };
}

export async function preserveDvdArchive({
  archiveRequestId,
  authorizeCopy,
  authorizeMutation,
  completenessProver,
  devicePath,
  fingerprint,
  expectedTitleMap,
  originalsLibraryPath,
  runner,
  salvageValidator,
  revalidateReadFailure,
  signal,
  sizeBytes,
  sync = syncPath,
  verifySource,
  onProgress,
}: PreserveDvdArchiveOptions): Promise<PreservedDvdArchive> {
  signal.throwIfAborted();
  onProgress({ phase: "preparing", progressPercent: 0 });
  const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
  const safeSizeBytes = requireDvdContentSize(sizeBytes);
  if (!isDvdFingerprint(fingerprint)) {
    throw new Error("Detected Disc fingerprint is invalid");
  }
  const root = await requireSafeArchiveRoot(originalsLibraryPath);
  const digest = dvdArchiveStem(fingerprint);
  const archivePath = join(root, `${digest}.iso`);
  const legacyPartialPath = join(root, `.${digest}.iso.rip-dvd-partial`);
  const attemptPartialPath = join(
    root,
    `.${digest}.${randomUUID()}.iso.rip-dvd-partial`,
  );
  const rescueIdentity: DvdRescueIdentity | undefined =
    archiveRequestId === undefined
      ? undefined
      : {
          archiveRequestId,
          fingerprint,
          sizeBytes: safeSizeBytes,
        };
  const rescuePaths =
    rescueIdentity === undefined
      ? undefined
      : dvdRescueWorkspacePaths(root, rescueIdentity.archiveRequestId);
  const boundaryRetentionMapPath =
    rescueIdentity === undefined
      ? undefined
      : dvdBoundaryRetentionMapPath(root, rescueIdentity.archiveRequestId);
  if (
    dirname(archivePath) !== root ||
    dirname(legacyPartialPath) !== root ||
    dirname(attemptPartialPath) !== root ||
    (rescuePaths !== undefined &&
      (dirname(rescuePaths.imagePath) !== root ||
        dirname(rescuePaths.mapPath) !== root)) ||
    (boundaryRetentionMapPath !== undefined &&
      dirname(boundaryRetentionMapPath) !== root) ||
    Buffer.byteLength(archivePath) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(legacyPartialPath) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(attemptPartialPath) > MAX_ARCHIVE_PATH_BYTES ||
    (rescuePaths !== undefined &&
      (Buffer.byteLength(rescuePaths.imagePath) > MAX_ARCHIVE_PATH_BYTES ||
        Buffer.byteLength(rescuePaths.mapPath) > MAX_ARCHIVE_PATH_BYTES)) ||
    (boundaryRetentionMapPath !== undefined &&
      Buffer.byteLength(boundaryRetentionMapPath) > MAX_ARCHIVE_PATH_BYTES) ||
    Buffer.byteLength(`${archivePath}.failed`) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(`${attemptPartialPath}.failed`) > MAX_ARCHIVE_PATH_BYTES
  ) {
    throw new Error("Archive path escaped the originals library");
  }
  await authorizeMutation?.();
  signal.throwIfAborted();
  if (rescuePaths !== undefined) {
    if (runner.isActive(safeDevicePath, rescuePaths.imagePath)) {
      throw new Error("DVD archive copy is still active");
    }
  }
  let rescueWorkspace =
    rescueIdentity === undefined
      ? null
      : await loadDvdRescueWorkspace(
          root,
          rescueIdentity,
          archivePath,
          authorizeMutation,
        );
  const recoveryPaths = [
    legacyPartialPath,
    ...discoverAttemptPartialPaths(root, digest),
  ];
  for (const recoveryPath of recoveryPaths) {
    if (runner.isActive(safeDevicePath, recoveryPath)) {
      throw new Error("DVD archive copy is still active");
    }
    requirePartialInactive(recoveryPath);
  }
  for (const recoveryPath of recoveryPaths) {
    await movePartialAside(recoveryPath, authorizeMutation);
  }

  const existingArchive = await optionalMetadata(archivePath);
  if (
    rescueWorkspace?.recoveryResult?.outcome === "damaged" &&
    existingArchive !== null
  ) {
    if (
      !matchesRescueImageIdentity(
        existingArchive,
        rescueWorkspace.imageFilesystemIdentity,
        safeSizeBytes,
      )
    ) {
      throw new Error("Existing DVD archive conflicts with rescue state");
    }
    await authorizeCopy?.();
    signal.throwIfAborted();
    await verifySource();
    signal.throwIfAborted();
    onProgress({ phase: "verifying", progressPercent: 99 });
    await sync(rescueWorkspace.imagePath);
    const salvageDecision = await evaluateDvdSalvage({
      expectedTitleMap,
      imagePath: rescueWorkspace.imagePath,
      recoveryResult: rescueWorkspace.recoveryResult,
      salvageValidator,
      signal,
    });
    if (salvageDecision.outcome === "reject") {
      await authorizeMutation?.();
      signal.throwIfAborted();
      await quarantinePublishedArchive(
        archivePath,
        rescueWorkspace.imageFilesystemIdentity,
        authorizeMutation,
      );
      throw salvageDecision.error;
    }
    await verifySource();
    signal.throwIfAborted();
    await authorizeMutation?.();
    signal.throwIfAborted();
    let revalidatedArchive;
    let revalidatedRescueImage;
    try {
      [revalidatedArchive, revalidatedRescueImage] = await Promise.all([
        lstat(archivePath),
        lstat(rescueWorkspace.imagePath),
      ]);
    } catch {
      await quarantinePublishedArchive(
        archivePath,
        rescueWorkspace.imageFilesystemIdentity,
        authorizeMutation,
      );
      throw new Error("Existing DVD archive conflicts with rescue state");
    }
    if (
      !matchesRescueImageIdentity(
        revalidatedArchive,
        rescueWorkspace.imageFilesystemIdentity,
        safeSizeBytes,
      ) ||
      !matchesRescueImageIdentity(
        revalidatedRescueImage,
        rescueWorkspace.imageFilesystemIdentity,
        safeSizeBytes,
      )
    ) {
      await quarantinePublishedArchive(
        archivePath,
        rescueWorkspace.imageFilesystemIdentity,
        authorizeMutation,
      );
      throw new Error("Existing DVD archive conflicts with rescue state");
    }
    onProgress({ phase: "finalizing", progressPercent: 99 });
    await sync(root);
    const committedWorkspace = rescueWorkspace;
    return {
      archivePath,
      archiveFilesystemIdentity: committedWorkspace.imageFilesystemIdentity,
      finalizePublication: () =>
        removeDvdRescueWorkspace(root, committedWorkspace),
      integrityEvidence: salvageDecision.integrityEvidence,
      recovered: false,
      sizeBytes: safeSizeBytes,
    };
  }
  if (rescueWorkspace?.recoveryResult?.outcome === "clean") {
    const validation = validateDvdRecoveryResult(
      rescueWorkspace.recoveryResult,
      safeSizeBytes,
    );
    if (validation.outcome !== "publish") {
      throw new Error("Completed DVD rescue state is invalid");
    }
    await authorizeCopy?.();
    signal.throwIfAborted();
    await verifySource();
    signal.throwIfAborted();
    await authorizeMutation?.();
    signal.throwIfAborted();
    onProgress({ phase: "finalizing", progressPercent: 99 });
    await sync(rescueWorkspace.imagePath);
    signal.throwIfAborted();
    await authorizeMutation?.();
    signal.throwIfAborted();
    let publishedByThisAttempt = false;
    let linkedArchiveFilesystemIdentity =
      rescueWorkspace.imageFilesystemIdentity;
    try {
      if (existingArchive === null) {
        await link(rescueWorkspace.imagePath, archivePath);
        publishedByThisAttempt = true;
      }
      const publishedArchive = await lstat(archivePath);
      linkedArchiveFilesystemIdentity = filesystemIdentity(publishedArchive);
      if (
        !matchesRescueImageIdentity(
          publishedArchive,
          rescueWorkspace.imageFilesystemIdentity,
          safeSizeBytes,
        )
      ) {
        throw new Error("Existing DVD archive conflicts with rescue state");
      }
      await sync(root);
    } catch (error) {
      if (publishedByThisAttempt) {
        await quarantinePublishedArchive(
          archivePath,
          linkedArchiveFilesystemIdentity,
        );
      }
      throw error;
    }
    const committedWorkspace = rescueWorkspace;
    return {
      archivePath,
      archiveFilesystemIdentity: linkedArchiveFilesystemIdentity,
      finalizePublication: () =>
        removeDvdRescueWorkspace(root, committedWorkspace),
      integrityEvidence: validation.integrityEvidence,
      recovered: false,
      sizeBytes: safeSizeBytes,
    };
  }
  if (existingArchive) {
    if (
      rescueWorkspace?.recoveryResult === null &&
      rescueWorkspace.boundaryFailure !== null &&
      isProvenDvdBoundaryCandidate(rescueWorkspace.boundaryFailure)
    ) {
      if (completenessProver === undefined || expectedTitleMap === undefined) {
        throw new Error("DVD corrected-boundary validation is unavailable");
      }
      const correctedSizeBytes =
        rescueWorkspace.boundaryFailure.firstFailingLba *
        DVD_SECTOR_SIZE_BYTES;
      if (
        !matchesRescueImageIdentity(
          existingArchive,
          rescueWorkspace.imageFilesystemIdentity,
          correctedSizeBytes,
        )
      ) {
        throw new Error(
          "Existing corrected DVD archive conflicts with rescue state",
        );
      }
      await authorizeCopy?.();
      signal.throwIfAborted();
      try {
        return await publishCorrectedDvdBoundary({
          archivePath,
          authorizeMutation,
          boundaryFailure: rescueWorkspace.boundaryFailure,
          completenessProver,
          existingPublishedFilesystemIdentity:
            rescueWorkspace.imageFilesystemIdentity,
          expectedTitleMap,
          onProgress,
          rescueWorkspace,
          root,
          signal,
          sync,
          verifySource,
        });
      } catch (error) {
        await quarantinePublishedArchive(
          archivePath,
          rescueWorkspace.imageFilesystemIdentity,
        );
        throw error;
      }
    }
    if (rescueWorkspace !== null) {
      throw new Error("Existing DVD archive conflicts with rescue state");
    }
    if (!existingArchive.isFile() || existingArchive.isSymbolicLink()) {
      throw new Error("Existing DVD archive path is not a regular file");
    }
    if (existingArchive.size !== safeSizeBytes) {
      throw new Error("Existing DVD archive does not match the Detected Disc");
    }
    const existingArchiveFilesystemIdentity =
      filesystemIdentity(existingArchive);
    if (archiveRequestId === undefined) {
      await verifySource();
      signal.throwIfAborted();
      onProgress({ phase: "finalizing", progressPercent: 99 });
      await sync(archivePath);
      signal.throwIfAborted();
      await sync(root);
      signal.throwIfAborted();
      return {
        archivePath,
        archiveFilesystemIdentity: existingArchiveFilesystemIdentity,
        integrityEvidence: createUnknownArchiveIntegrityEvidence(),
        recovered: true,
        sizeBytes: safeSizeBytes,
      };
    }
    await authorizeMutation?.();
    signal.throwIfAborted();
    await quarantinePublishedArchive(
      archivePath,
      existingArchiveFilesystemIdentity,
      authorizeMutation,
    );
  }

  let partialPath = rescueWorkspace?.imagePath ?? attemptPartialPath;
  if (runner.isActive(safeDevicePath, partialPath)) {
    throw new Error("DVD archive copy is still active");
  }
  if (rescueWorkspace === null) {
    await movePartialAside(partialPath, authorizeMutation);
  }
  let publishedArchiveFilesystemIdentity: string | undefined;
  let retainedForValidation = false;
  let validation: DvdValidationResult | undefined;
  const copyContinuation = dvdCopyContinuationFromWorkspace(rescueWorkspace);
  const readFailureStage: ArchiveReadFailureStage =
    copyContinuation === undefined ? "initial_copy" : "rescue_resume";
  try {
    onProgress({ phase: "copying", progressPercent: 0 });
    const recoveryResult = await runner.copy({
      authorizeProbe: revalidateReadFailure,
      authorizeStart: authorizeCopy,
      ...(copyContinuation === undefined
        ? {}
        : { continuation: copyContinuation }),
      devicePath: safeDevicePath,
      outputPath: partialPath,
      sizeBytes: safeSizeBytes,
      signal,
      onBytesCopied(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          return;
        }
        onProgress({
          phase: "copying",
          progressBytes: bytes,
          progressPercent: Math.min(
            99,
            Math.floor((bytes * 100) / safeSizeBytes),
          ),
        });
      },
    });
    validation =
      rescueWorkspace?.recoveryResult?.outcome === "damaged"
        ? validateResumedDvdRecoveryResult(
            recoveryResult,
            rescueWorkspace.recoveryResult,
            safeSizeBytes,
          )
        : validateDvdRecoveryResult(recoveryResult, safeSizeBytes);
    signal.throwIfAborted();
    const partialMetadata = await lstat(partialPath);
    if (
      !partialMetadata.isFile() ||
      partialMetadata.isSymbolicLink() ||
      partialMetadata.size !== safeSizeBytes
    ) {
      throw new Error("DVD archive copy did not produce the expected complete image");
    }
    await verifySource();
    signal.throwIfAborted();
    await authorizeMutation?.();
    signal.throwIfAborted();
    if (validation.outcome === "requires_validation") {
      onProgress({ phase: "verifying", progressPercent: 99 });
      await sync(partialPath);
      signal.throwIfAborted();
      await authorizeMutation?.();
      signal.throwIfAborted();
      if (rescueIdentity !== undefined) {
        rescueWorkspace =
          rescueWorkspace === null
            ? await commitDvdRescueWorkspace(
                root,
                rescueIdentity,
                partialPath,
                validation.recoveryResult,
                authorizeMutation,
              )
            : await updateDvdRescueWorkspace(
                root,
                rescueIdentity,
                rescueWorkspace,
                validation.recoveryResult,
                authorizeMutation,
              );
        partialPath = rescueWorkspace.imagePath;
        retainedForValidation = true;
      }
      const salvageDecision = await evaluateDvdSalvage({
        expectedTitleMap,
        imagePath: partialPath,
        recoveryResult: validation.recoveryResult,
        salvageValidator,
        signal,
      });
      if (salvageDecision.outcome === "publish") {
        validation = {
          outcome: "publish",
          integrityEvidence: salvageDecision.integrityEvidence,
        };
        await verifySource();
        signal.throwIfAborted();
        await authorizeMutation?.();
        signal.throwIfAborted();
      } else {
        if (rescueWorkspace === null) {
          await movePartialAside(partialPath, authorizeMutation);
          await sync(root);
        }
        retainedForValidation = true;
        throw salvageDecision.error;
      }
    }
    onProgress({ phase: "finalizing", progressPercent: 99 });
    await sync(partialPath);
    signal.throwIfAborted();
    await authorizeMutation?.();
    signal.throwIfAborted();
    if (rescueWorkspace !== null) {
      rescueWorkspace = await updateDvdRescueWorkspace(
        root,
        rescueIdentity!,
        rescueWorkspace,
        recoveryResult,
        authorizeMutation,
      );
    }
    await authorizeMutation?.();
    signal.throwIfAborted();
    const sourceFilesystemIdentity =
      rescueWorkspace?.imageFilesystemIdentity ??
      filesystemIdentity(partialMetadata);
    // A hard link publishes the fully-synced inode without the overwrite
    // behavior of POSIX rename. Both paths are in the same bounded directory.
    publishedArchiveFilesystemIdentity = await publishDvdArchiveLink({
      archivePath,
      expectedFilesystemIdentity: sourceFilesystemIdentity,
      expectedSizeBytes: safeSizeBytes,
      mismatchMessage: "Published DVD archive changed before verification",
      removeSourceAfterLink: rescueWorkspace === null,
      root,
      sourcePath: partialPath,
      sync,
    });
  } catch (error) {
    // A rejected operation is not proof that the helper exited. Do not return
    // control until OS-level closure releases the copy tombstone.
    await runner.waitForInactive(safeDevicePath, partialPath);
    const isReadFailure = error instanceof DvdReadFailureError;
    const isOutOfRangeFailure =
      isReadFailure && error.readFailure.category === "out_of_range";
    let retentionError: unknown = null;
    const recordRetentionError = (caughtRetentionError: unknown): void => {
      retentionError = retentionError === null
        ? caughtRetentionError
        : new AggregateError(
            [retentionError, caughtRetentionError],
            "DVD boundary evidence retention failed",
          );
    };
    if (isOutOfRangeFailure && rescueIdentity !== undefined) {
      await revalidateReadFailure?.();
      try {
        await sync(partialPath);
      } catch (caughtRetentionError) {
        recordRetentionError(caughtRetentionError);
      }
      signal.throwIfAborted();
      await revalidateReadFailure?.();
      if (retentionError === null) {
        let retentionFenceFailed = false;
        let retentionFenceError: unknown;
        const finalizeRetention = async (): Promise<void> => {
          try {
            await revalidateReadFailure?.();
          } catch (caughtRetentionFenceError) {
            retentionFenceFailed = true;
            retentionFenceError = caughtRetentionFenceError;
            throw caughtRetentionFenceError;
          }
        };
        try {
          rescueWorkspace = rescueWorkspace === null
            ? await commitDvdBoundaryRescueWorkspace(
                root,
                rescueIdentity,
                partialPath,
                error.readFailure,
                authorizeMutation,
                finalizeRetention,
              )
            : await recordDvdBoundaryFailure(
                root,
                rescueIdentity,
                rescueWorkspace,
                error.readFailure,
                authorizeMutation,
                finalizeRetention,
              );
          partialPath = rescueWorkspace.imagePath;
        } catch (caughtRetentionError) {
          if (retentionFenceFailed) {
            throw retentionFenceError;
          }
          recordRetentionError(caughtRetentionError);
        }
      }
    } else if (isReadFailure) {
      await revalidateReadFailure?.();
    }
    if (
      isOutOfRangeFailure &&
      retentionError === null &&
      rescueWorkspace !== null &&
      rescueWorkspace.recoveryResult === null &&
      isProvenDvdBoundaryCandidate(error.readFailure)
    ) {
      if (completenessProver === undefined || expectedTitleMap === undefined) {
        throw new Error("DVD corrected-boundary validation is unavailable");
      }
      return await publishCorrectedDvdBoundary({
        archivePath,
        authorizeMutation,
        boundaryFailure: error.readFailure,
        completenessProver,
        expectedTitleMap,
        onProgress,
        rescueWorkspace,
        root,
        signal,
        sync,
        verifySource,
      });
    }
    try {
      const hasRequestOwnedRescueState =
        rescueWorkspace !== null ||
        (rescuePaths !== undefined &&
          (await optionalMetadata(rescuePaths.mapPath)) !== null);
      if (
        !hasRequestOwnedRescueState &&
        !retainedForValidation &&
        !runner.isActive(safeDevicePath, partialPath)
      ) {
        await movePartialAside(partialPath);
      }
    } catch (cleanupError) {
      if (!isOutOfRangeFailure) {
        throw cleanupError;
      }
      recordRetentionError(cleanupError);
    }
    throw isReadFailure
      ? new DvdArchiveReadFailureError(
          readFailureStage,
          error.readFailure,
          retentionError,
        )
      : error;
  }
  if (validation === undefined) {
    throw new Error("DVD recovery result was not validated");
  }
  return {
    archivePath,
    archiveFilesystemIdentity: publishedArchiveFilesystemIdentity!,
    ...(rescueWorkspace === null
      ? {}
      : {
          finalizePublication: () =>
            removeDvdRescueWorkspace(root, rescueWorkspace!),
        }),
    integrityEvidence: validation.integrityEvidence,
    recovered: false,
    sizeBytes: safeSizeBytes,
  };
}
