import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isHandBrakePreset } from "@rip-dvd/config";
import {
  decodeArchivedDvdTitles,
  decodeDvdTitleMap,
  ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
  ENCODE_JOB_LEASE_DURATION_MS,
  type DataAccess,
  type DiscSelection,
  type EncodeJobFailureReportInput,
  type EncodeJobPartialCleanup,
  type EncodeWorkerIncidentRecoveryArea,
  type PublicationMutationRecoveryLock,
  type RunningEncodeJob,
} from "@rip-dvd/data-access";

import {
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  requireNonEmptyRegularEncodeOutput,
  sameEncodeOutputAuthoritySnapshot,
  sameEncodeOutputInode,
  sameEncodeOutputMutationSnapshot,
} from "./encode-output-filesystem-identity.js";
import type {
  EncodeOutputValidator,
  EncodeOutputVobSubExpectation,
} from "./encode-output-validator.js";
import { EncodeOutputValidationError } from "./encode-output-validator.js";
import {
  HandBrakeCommandError,
  type HandBrakeRunner,
  HandBrakeTimeoutError,
} from "./handbrake-runner.js";
import { normalizeErrorMessage } from "./normalize-error-message.js";
import { createProgressParser } from "./progress-parser.js";
import {
  recordEncodePublicationRecoveryIncident,
  resolveEncodePublicationRecoveryIncident,
} from "./worker-incidents.js";

const MAX_PATH_BYTES = 4_096;
const ATOMIC_EXCHANGE_PATH = fileURLToPath(
  new URL("../dist/rip-dvd-atomic-exchange.node", import.meta.url),
);

class PendingPublicationRecoveryError extends Error {}
class EncodeCancellationRequestedError extends Error {}
class ClassifiedEncodeFailureError extends Error {
  constructor(
    message: string,
    readonly reasonCode: EncodeJobFailureReportInput["reasonCode"],
    readonly phase: EncodeJobFailureReportInput["phase"],
    readonly evidence: EncodeJobFailureReportInput["evidence"] = {
      kind: "none",
    },
  ) {
    super(message);
    this.name = "ClassifiedEncodeFailureError";
  }
}

function encodeFailureReport(
  error: unknown,
  phase: EncodeJobFailureReportInput["phase"],
): EncodeJobFailureReportInput {
  if (error instanceof HandBrakeCommandError) {
    return {
      schemaVersion: 1,
      reasonCode: "command_failed",
      phase,
      retryability: "appropriate",
      diagnostic: error.diagnostic,
      evidence: error.evidence,
    };
  }
  if (error instanceof HandBrakeTimeoutError) {
    return {
      schemaVersion: 1,
      reasonCode: "command_timeout",
      phase,
      retryability: "appropriate",
      diagnostic: error.diagnostic,
      evidence: {
        kind: "timeout",
        timeoutSeconds: error.timeoutSeconds,
      },
    };
  }
  if (error instanceof EncodeOutputValidationError) {
    return {
      schemaVersion: 1,
      reasonCode: "output_validation_failed",
      phase: "validation",
      retryability: "after_action",
      diagnostic: error.message.slice(
        0,
        ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
      ),
      evidence: error.evidence,
    };
  }
  if (error instanceof ClassifiedEncodeFailureError) {
    return {
      schemaVersion: 1,
      reasonCode: error.reasonCode,
      phase: error.phase,
      retryability: "after_action",
      diagnostic: error.message.slice(
        0,
        ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
      ),
      evidence: error.evidence,
    };
  }
  return {
    schemaVersion: 1,
    reasonCode: "unknown_failure",
    phase,
    retryability: "after_action",
    diagnostic: normalizeErrorMessage(error).slice(
      0,
      ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
    ),
    evidence: { kind: "none" },
  };
}

export class EncodePublicationRecoveryError extends Error {
  constructor(error: unknown) {
    super(normalizeErrorMessage(error));
    this.name = "EncodePublicationRecoveryError";
  }
}

type PublicationRecoveryStepResult =
  | "completed"
  | "completed_with_failures"
  | "deferred";
type PublicationMutationFailureReports = Map<
  NonNullable<EncodeJobPartialCleanup["leaseToken"]>,
  EncodeJobFailureReportInput
>;

function createPublicationRecoveryStepTracker(
  options: EncodePublicationOptions,
  recoveryArea: EncodeWorkerIncidentRecoveryArea,
) {
  let result: PublicationRecoveryStepResult = "completed";
  return {
    markDeferred(): void {
      if (result === "completed") {
        result = "deferred";
      }
    },
    recordFailure(message: string, error: unknown): void {
      result = "completed_with_failures";
      options.log(`${message}: ${normalizeErrorMessage(error)}`);
      recordEncodePublicationRecoveryIncident(options, recoveryArea);
    },
    result(): PublicationRecoveryStepResult {
      return result;
    },
  };
}

async function runEncodePreparationStep<T>(
  operation: () => Promise<T>,
  reasonCode: "input_unavailable" | "unsafe_output_state",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ClassifiedEncodeFailureError(
      normalizeErrorMessage(error),
      reasonCode,
      "preparation",
    );
  }
}

async function requireRegularOutputForValidation(
  outputPath: string,
  errorMessage: string,
): Promise<Stats> {
  try {
    return await requireNonEmptyRegularEncodeOutput(outputPath, errorMessage);
  } catch (error) {
    throw new ClassifiedEncodeFailureError(
      normalizeErrorMessage(error),
      "output_validation_failed",
      "validation",
      { kind: "validation_check", check: "output_file" },
    );
  }
}

function boundedDiagnostic(error: unknown): string {
  return normalizeErrorMessage(error).slice(0, 500);
}

type OperationalFailureClassification = Pick<
  EncodeJobFailureReportInput,
  "reasonCode" | "phase" | "evidence"
> & {
  reasonCode:
    | "cleanup_failed"
    | "publication_failed"
    | "worker_interrupted"
    | "publication_recovery_failed";
};

function operationalFailureReport(
  error: unknown,
  classification: OperationalFailureClassification,
): EncodeJobFailureReportInput {
  return {
    schemaVersion: 1,
    retryability: "after_action",
    diagnostic: boundedDiagnostic(error),
    ...classification,
  };
}

function cleanupFailureReport(
  error: unknown,
  operation: Extract<
    EncodeJobFailureReportInput["evidence"],
    { kind: "cleanup" }
  >["operation"],
): EncodeJobFailureReportInput {
  return operationalFailureReport(error, {
    reasonCode: "cleanup_failed",
    phase: "cleanup",
    evidence: { kind: "cleanup", operation },
  });
}

function publicationFailureReport(
  error: unknown,
  operation: Extract<
    EncodeJobFailureReportInput["evidence"],
    { kind: "publication" }
  >["operation"],
): EncodeJobFailureReportInput {
  return operationalFailureReport(error, {
    reasonCode: "publication_failed",
    phase: "publication",
    evidence: { kind: "publication", operation },
  });
}

function interruptionFailureReport(
  error: unknown,
  phase: EncodeJobFailureReportInput["phase"],
): EncodeJobFailureReportInput {
  return operationalFailureReport(error, {
    reasonCode: "worker_interrupted",
    phase,
    evidence: { kind: "interruption", source: "worker_shutdown" },
  });
}

function publicationRecoveryFailureReport(
  error: unknown,
  publicationPending: boolean,
): EncodeJobFailureReportInput {
  return operationalFailureReport(error, {
    reasonCode: "publication_recovery_failed",
    phase: "recovery",
    evidence: {
      kind: "recovery",
      operation: publicationPending
        ? "publication_recovery"
        : "cleanup_recovery",
    },
  });
}

function recordCleanupFailure(
  cleanup: EncodeJobPartialCleanup,
  report: EncodeJobFailureReportInput,
  options: EncodePublicationOptions,
): void {
  try {
    options.access.encodeJobs.recordCleanupFailureReport(cleanup, report);
  } catch (error) {
    options.log(
      `Encode cleanup Failure Report could not be persisted: ${
        normalizeErrorMessage(error)
      }`,
    );
  }
}

function recordClaimFailure(
  claim: RunningEncodeJob,
  report: EncodeJobFailureReportInput,
  label: string,
  options: EncodePublicationOptions,
): void {
  try {
    options.access.encodeJobs.recordFailureReport(claim, report);
  } catch (error) {
    options.log(
      `${label} Failure Report could not be persisted: ${
        normalizeErrorMessage(error)
      }`,
    );
  }
}

export interface AtomicPathExchange {
  exchange(firstPath: string, secondPath: string): void;
}

interface AtomicPathExchangeBinding {
  exchangePaths(firstPath: string, secondPath: string): void;
  tryAcquireLock(path: string): number | null;
  releaseLock(handle: number): void;
}

export interface PublicationMutationLock {
  tryAcquire(path: string): number | null;
  release(handle: number): void;
}

export function createNodeAtomicPathExchange(): AtomicPathExchange {
  const require = createRequire(import.meta.url);
  const binding = require(ATOMIC_EXCHANGE_PATH) as AtomicPathExchangeBinding;
  return {
    exchange(firstPath, secondPath) {
      binding.exchangePaths(firstPath, secondPath);
    },
  };
}

export function createNodePublicationMutationLock(): PublicationMutationLock {
  const require = createRequire(import.meta.url);
  const binding = require(ATOMIC_EXCHANGE_PATH) as AtomicPathExchangeBinding;
  return {
    tryAcquire(path) {
      return binding.tryAcquireLock(path);
    },
    release(handle) {
      binding.releaseLock(handle);
    },
  };
}

export const nodeAtomicPathExchange = createNodeAtomicPathExchange();
export const nodePublicationMutationLock =
  createNodePublicationMutationLock();

export function createEncodePublicationMutationRecoveryLock(
  mediaLibraryPath: string,
  mutationLock: PublicationMutationLock = nodePublicationMutationLock,
): PublicationMutationRecoveryLock {
  const resolvedMediaRoot = resolve(mediaLibraryPath);
  if (Buffer.byteLength(resolvedMediaRoot) > MAX_PATH_BYTES) {
    throw new Error("Library path exceeds the safety limit");
  }
  return {
    tryAcquire(outputPath) {
      const mediaRoot = realpathSync(resolvedMediaRoot);
      const mediaRootMetadata = lstatSync(mediaRoot);
      if (
        !mediaRootMetadata.isDirectory() ||
        mediaRootMetadata.isSymbolicLink()
      ) {
        throw new Error("Library path must be a real directory");
      }
      const resolvedOutput = resolve(outputPath);
      if (
        !outputPath.startsWith(sep) ||
        Buffer.byteLength(resolvedOutput) > MAX_PATH_BYTES ||
        !resolvedOutput.toLowerCase().endsWith(".mkv") ||
        resolvedOutput === mediaRoot
      ) {
        throw new Error("Encode Job output path escaped the media library");
      }
      const canonicalOutputDirectory = realpathSync(dirname(resolvedOutput));
      if (!isContained(mediaRoot, canonicalOutputDirectory)) {
        throw new Error("Encode Job output directory escaped the media library");
      }
      const mutationLockPath = join(
        canonicalOutputDirectory,
        `.${basename(resolvedOutput)}.rip-dvd-mutation-lock`,
      );
      if (
        Buffer.byteLength(mutationLockPath) > MAX_PATH_BYTES ||
        dirname(mutationLockPath) !== canonicalOutputDirectory
      ) {
        throw new Error("Encode Job output path is unsafe");
      }
      const handle = mutationLock.tryAcquire(mutationLockPath);
      return handle === null
        ? null
        : { release: () => mutationLock.release(handle) };
    },
  };
}

export interface EncodePublicationOptions {
  access: DataAccess;
  atomicPathExchange: AtomicPathExchange;
  log(message: string): void;
  mediaLibraryPath: string;
  mutationLock: PublicationMutationLock;
  originalsLibraryPath: string;
  outputValidator: EncodeOutputValidator;
  runner: HandBrakeRunner;
  signal: AbortSignal;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

async function syncOutputDirectoryHierarchy(
  mediaLibraryPath: string,
  outputDirectory: string,
): Promise<void> {
  if (!isContained(mediaLibraryPath, outputDirectory)) {
    throw new Error("Encode output directory hierarchy is invalid");
  }
  const relativeOutputDirectory = relative(mediaLibraryPath, outputDirectory);
  const hierarchy =
    relativeOutputDirectory.length === 0
      ? []
      : relativeOutputDirectory.split(sep);
  let currentDirectory = mediaLibraryPath;
  await syncPath(currentDirectory);
  for (const segment of hierarchy) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error("Encode output directory hierarchy is invalid");
    }
    currentDirectory = join(currentDirectory, segment);
    await syncPath(currentDirectory);
  }
}

async function requireLibraryRoot(
  path: string,
  { create }: { create: boolean },
): Promise<string> {
  const resolved = resolve(path);
  if (Buffer.byteLength(resolved) > MAX_PATH_BYTES) {
    throw new Error("Library path exceeds the safety limit");
  }
  const firstCreatedDirectory = create
    ? await mkdir(resolved, { recursive: true, mode: 0o750 })
    : undefined;
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Library path must be a real directory");
  }
  const canonical = await realpath(resolved);
  if (firstCreatedDirectory !== undefined) {
    await syncOutputDirectoryHierarchy(
      dirname(firstCreatedDirectory),
      resolved,
    );
  }
  return canonical;
}

async function requireSourcePath(
  originalsLibraryPath: string,
  sourcePath: string,
): Promise<string> {
  const resolved = resolve(sourcePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Original Disc Archive path is not a regular file");
  }
  const canonical = await realpath(resolved);
  if (
    Buffer.byteLength(canonical) > MAX_PATH_BYTES ||
    !isContained(originalsLibraryPath, canonical)
  ) {
    throw new Error("Original Disc Archive path escaped the originals library");
  }
  return canonical;
}

async function requireOutputDirectory(
  mediaLibraryPath: string,
  outputDirectory: string,
): Promise<string> {
  const missingSegments: string[] = [];
  let existingAncestor = outputDirectory;
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parentDirectory = dirname(existingAncestor);
      if (parentDirectory === existingAncestor) {
        throw new Error("Encode Job output directory is ambiguous");
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parentDirectory;
    }
  }
  let currentDirectory: string;
  try {
    currentDirectory = await realpath(existingAncestor);
  } catch {
    throw new Error("Encode Job output directory is ambiguous");
  }
  const ancestorMetadata = await lstat(currentDirectory);
  if (
    !ancestorMetadata.isDirectory() ||
    ancestorMetadata.isSymbolicLink()
  ) {
    throw new Error("Encode Job output directory is ambiguous");
  }
  if (!isContained(mediaLibraryPath, currentDirectory)) {
    throw new Error("Encode Job output directory escaped the media library");
  }
  for (const segment of missingSegments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error("Encode Job output directory is ambiguous");
    }
    const candidateDirectory = join(currentDirectory, segment);
    try {
      await mkdir(candidateDirectory, { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(candidateDirectory);
    } catch {
      throw new Error("Encode Job output directory is ambiguous");
    }
    const metadata = await lstat(canonicalDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Encode Job output directory is ambiguous");
    }
    if (!isContained(mediaLibraryPath, canonicalDirectory)) {
      throw new Error(
        "Encode Job output directory escaped the media library",
      );
    }
    currentDirectory = canonicalDirectory;
  }
  return currentDirectory;
}

async function requireOutputPaths(
  mediaLibraryPath: string,
  outputPath: string,
  claimToken: string,
) {
  const resolvedOutput = resolve(outputPath);
  if (
    !outputPath.startsWith(sep) ||
    Buffer.byteLength(resolvedOutput) > MAX_PATH_BYTES ||
    !resolvedOutput.toLowerCase().endsWith(".mkv") ||
    resolvedOutput === mediaLibraryPath
  ) {
    throw new Error("Encode Job output path escaped the media library");
  }
  const outputDirectory = dirname(resolvedOutput);
  const canonicalOutputDirectory = await requireOutputDirectory(
    mediaLibraryPath,
    outputDirectory,
  );
  await syncOutputDirectoryHierarchy(
    mediaLibraryPath,
    canonicalOutputDirectory,
  );
  const finalPath = join(canonicalOutputDirectory, basename(resolvedOutput));
  const safeToken = claimToken.replaceAll(/[^a-zA-Z0-9-]/g, "");
  if (safeToken.length === 0 || safeToken !== claimToken) {
    throw new Error("Encode Job claim token is unsafe");
  }
  const partialPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.${safeToken}.rip-dvd-partial`,
  );
  const replacementPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.${safeToken}.rip-dvd-publish`,
  );
  const mutationLockPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.rip-dvd-mutation-lock`,
  );
  const legacyPartialPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.rip-dvd-partial`,
  );
  const priorFinalPath = `${finalPath}.failed.${safeToken}`;
  const cleanupQuarantinePath =
    `${finalPath}.failed.${safeToken}.publication-rollback`;
  for (const path of [
    cleanupQuarantinePath,
    finalPath,
    partialPath,
    replacementPath,
    mutationLockPath,
    legacyPartialPath,
    priorFinalPath,
  ]) {
    if (
      Buffer.byteLength(path) > MAX_PATH_BYTES ||
      dirname(path) !== canonicalOutputDirectory
    ) {
      throw new Error("Encode Job output path is unsafe");
    }
  }
  return {
    cleanupQuarantinePath,
    finalPath,
    legacyPartialPath,
    mutationLockPath,
    partialPath,
    priorFinalPath,
    replacementPath,
  };
}

async function optionalMetadata(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function retainedOutputProvenance(path: string, metadata: Stats | null) {
  if (metadata === null) {
    return undefined;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Retained Encode output is not a regular file");
  }
  return {
    retainedOutputPath: path,
    retainedOutputIdentity: encodeOutputFilesystemIdentity(metadata),
  };
}

function correctedRetainedOutputProvenance(
  access: DataAccess,
  jobId: RunningEncodeJob["id"],
  path: string,
  metadata: Stats | null,
) {
  const job = access.encodeJobs
    .listCorrectionLinks([jobId])
    .find((candidate) => candidate.id === jobId);
  return job?.predecessorEncodeJobId === null || job === undefined
    ? undefined
    : retainedOutputProvenance(path, metadata);
}

async function moveAside(
  path: string,
  reservedQuarantinePath?: string,
  expectedMetadata?: Stats,
  authorizeRename?: () => void,
): Promise<string | null> {
  const metadata = await optionalMetadata(path);
  if (metadata === null) {
    return null;
  }
  if (
    expectedMetadata !== undefined &&
    !sameEncodeOutputMutationSnapshot(expectedMetadata, metadata)
  ) {
    throw new Error("Encode output changed before it could be quarantined");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Encode output path is not a regular file");
  }
  const failedPath =
    reservedQuarantinePath ?? `${path}.failed.${randomUUID()}`;
  if (
    Buffer.byteLength(failedPath) > MAX_PATH_BYTES ||
    dirname(failedPath) !== dirname(path)
  ) {
    throw new Error("Encode failure path is unsafe");
  }
  if (authorizeRename) {
    authorizeRename();
    renameSync(path, failedPath);
  } else {
    await rename(path, failedPath);
  }
  const quarantinedMetadata = await lstat(failedPath);
  if (!sameEncodeOutputInode(metadata, quarantinedMetadata)) {
    try {
      await restoreMovedAsideOutput(failedPath, path);
    } catch {
      // The quarantined file remains recoverable if another final now exists.
    }
    throw new Error("Encode output changed while it was being quarantined");
  }
  await syncPath(dirname(path));
  return failedPath;
}

function moveAsideAtMutationBoundary(
  path: string,
  failedPath: string,
  expectedMetadata: Stats,
): string {
  const metadata = lstatSync(path);
  if (!sameEncodeOutputMutationSnapshot(expectedMetadata, metadata)) {
    throw new Error("Encode output changed before it could be quarantined");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Encode output path is not a regular file");
  }
  if (
    Buffer.byteLength(failedPath) > MAX_PATH_BYTES ||
    dirname(failedPath) !== dirname(path)
  ) {
    throw new Error("Encode failure path is unsafe");
  }
  try {
    lstatSync(failedPath);
    throw new PendingPublicationRecoveryError(
      "Encode output quarantine already requires reconciliation",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  renameSync(path, failedPath);
  const quarantinedMetadata = lstatSync(failedPath);
  if (!sameEncodeOutputInode(metadata, quarantinedMetadata)) {
    try {
      linkSync(failedPath, path);
    } catch {
      // Durable provenance lets reconciliation recover the quarantined file.
    }
    throw new Error("Encode output changed while it was being quarantined");
  }
  return failedPath;
}

function exchangePathsAtMutationBoundary(
  atomicPathExchange: AtomicPathExchange,
  firstPath: string,
  secondPath: string,
): void {
  atomicPathExchange.exchange(firstPath, secondPath);
}

function atomicExchangeIsUnsupported(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP"
  );
}

function syncPathAtMutationBoundary(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishReplacementWithRenameAtMutationBoundary(
  finalPath: string,
  priorFinalPath: string,
  replacementPath: string,
  partialPath: string,
  retainedFinalMetadata: Stats,
  partialMetadata: Stats,
  onPublished: () => void,
): void {
  const finalBefore = lstatSync(finalPath);
  const priorFinalBefore = lstatSync(priorFinalPath);
  const replacementBefore = lstatSync(replacementPath);
  const partialBefore = lstatSync(partialPath);
  if (
    !sameEncodeOutputMutationSnapshot(retainedFinalMetadata, finalBefore) ||
    !sameEncodeOutputInode(retainedFinalMetadata, priorFinalBefore) ||
    !sameEncodeOutputInode(partialMetadata, replacementBefore) ||
    !sameEncodeOutputInode(partialMetadata, partialBefore)
  ) {
    throw new PendingPublicationRecoveryError(
      "Encode replacement changed before the compatible rename",
    );
  }

  renameSync(replacementPath, finalPath);
  onPublished();

  let finalAfter: Stats;
  let priorFinalAfter: Stats;
  let partialAfter: Stats;
  try {
    finalAfter = lstatSync(finalPath);
    priorFinalAfter = lstatSync(priorFinalPath);
    partialAfter = lstatSync(partialPath);
  } catch (error) {
    throw new PendingPublicationRecoveryError(
      `Compatible Encode replacement requires reconciliation: ${
        normalizeErrorMessage(error)
      }`,
    );
  }
  if (
    !sameEncodeOutputInode(partialMetadata, finalAfter) ||
    !sameEncodeOutputInode(partialMetadata, partialAfter) ||
    !sameEncodeOutputInode(retainedFinalMetadata, priorFinalAfter)
  ) {
    throw new PendingPublicationRecoveryError(
      "Compatible Encode replacement requires reconciliation",
    );
  }
  syncPathAtMutationBoundary(dirname(finalPath));
}

function restoreHiddenFinalAtMutationBoundary(
  atomicPathExchange: AtomicPathExchange,
  finalPath: string,
  replacementPath: string,
  workerMetadata: Stats,
): boolean {
  for (;;) {
    const publicBefore = lstatSync(finalPath);
    const hiddenBefore = lstatSync(replacementPath);
    if (
      !publicBefore.isFile() ||
      publicBefore.isSymbolicLink() ||
      !hiddenBefore.isFile() ||
      hiddenBefore.isSymbolicLink()
    ) {
      throw new PendingPublicationRecoveryError(
        "Atomic exchange endpoints are not regular files",
      );
    }
    exchangePathsAtMutationBoundary(
      atomicPathExchange,
      replacementPath,
      finalPath,
    );
    const publicAfter = lstatSync(finalPath);
    const hiddenAfter = lstatSync(replacementPath);
    syncPathAtMutationBoundary(dirname(finalPath));
    if (sameEncodeOutputInode(workerMetadata, hiddenAfter)) {
      return true;
    }
    if (
      sameEncodeOutputAuthoritySnapshot(hiddenBefore, publicAfter) &&
      sameEncodeOutputAuthoritySnapshot(publicBefore, hiddenAfter)
    ) {
      if (sameEncodeOutputInode(workerMetadata, publicAfter)) {
        continue;
      }
      return false;
    }
  }
}

function publishReplacementAtMutationBoundary(
  atomicPathExchange: AtomicPathExchange,
  finalPath: string,
  priorFinalPath: string,
  replacementPath: string,
  partialPath: string,
  expectedFinal: Stats,
  onPublished: () => void,
  log: (message: string) => void,
): void {
  const finalMetadata = lstatSync(finalPath);
  if (!sameEncodeOutputMutationSnapshot(expectedFinal, finalMetadata)) {
    throw new Error("Encode output changed before atomic replacement");
  }
  if (!finalMetadata.isFile() || finalMetadata.isSymbolicLink()) {
    throw new Error("Encode output path is not a regular file");
  }
  linkSync(finalPath, priorFinalPath);
  const retainedFinalMetadata = lstatSync(finalPath);
  const priorFinalMetadata = lstatSync(priorFinalPath);
  if (
    !sameEncodeOutputInode(expectedFinal, retainedFinalMetadata) ||
    !sameEncodeOutputInode(retainedFinalMetadata, priorFinalMetadata)
  ) {
    throw new Error("Encode output changed while retaining recovery");
  }
  linkSync(partialPath, replacementPath);
  syncPathAtMutationBoundary(dirname(finalPath));
  const currentFinalMetadata = lstatSync(finalPath);
  if (
    !sameEncodeOutputMutationSnapshot(
      retainedFinalMetadata,
      currentFinalMetadata,
    )
  ) {
    throw new Error("Encode output changed before atomic replacement");
  }
  let exchangeError: Error | null = null;
  try {
    exchangePathsAtMutationBoundary(
      atomicPathExchange,
      replacementPath,
      finalPath,
    );
  } catch (error) {
    exchangeError =
      error instanceof Error ? error : new Error(normalizeErrorMessage(error));
  }
  const partialMetadata = lstatSync(partialPath);
  let publishedFinalMetadata: Stats | null = null;
  let displacedFinalMetadata: Stats | null = null;
  let displacedFinalError: Error | null = null;
  try {
    publishedFinalMetadata = lstatSync(finalPath);
    displacedFinalMetadata = lstatSync(replacementPath);
    if (
      !publishedFinalMetadata.isFile() ||
      publishedFinalMetadata.isSymbolicLink() ||
      !sameEncodeOutputInode(partialMetadata, publishedFinalMetadata) ||
      !displacedFinalMetadata.isFile() ||
      displacedFinalMetadata.isSymbolicLink() ||
      !sameEncodeOutputAuthoritySnapshot(
        retainedFinalMetadata,
        displacedFinalMetadata,
      )
    ) {
      displacedFinalError = new Error(
        "Encode output changed during atomic replacement",
      );
    }
  } catch (error) {
    displacedFinalError =
      error instanceof Error ? error : new Error(normalizeErrorMessage(error));
  }
  if (exchangeError !== null && displacedFinalError !== null) {
    const exchangeDidNotOccur =
      publishedFinalMetadata !== null &&
      displacedFinalMetadata !== null &&
      sameEncodeOutputAuthoritySnapshot(
        retainedFinalMetadata,
        publishedFinalMetadata,
      ) &&
      sameEncodeOutputInode(partialMetadata, displacedFinalMetadata);
    if (exchangeDidNotOccur) {
      if (atomicExchangeIsUnsupported(exchangeError)) {
        log(
          `Encode replacement atomic exchange is unsupported: ${
            normalizeErrorMessage(exchangeError)
          }; using compatible rename`,
        );
        publishReplacementWithRenameAtMutationBoundary(
          finalPath,
          priorFinalPath,
          replacementPath,
          partialPath,
          retainedFinalMetadata,
          partialMetadata,
          onPublished,
        );
        return;
      }
      throw exchangeError;
    }
    throw new PendingPublicationRecoveryError(
      `${exchangeError.message}; atomic exchange endpoints require reconciliation`,
    );
  }
  if (displacedFinalError !== null) {
    if (
      publishedFinalMetadata === null ||
      !sameEncodeOutputInode(partialMetadata, publishedFinalMetadata) ||
      displacedFinalMetadata === null ||
      !displacedFinalMetadata.isFile() ||
      displacedFinalMetadata.isSymbolicLink()
    ) {
      throw new PendingPublicationRecoveryError(
        `${displacedFinalError.message}; atomic exchange endpoints changed before inspection`,
      );
    }
    try {
      const workerReturnedToReplacement =
        restoreHiddenFinalAtMutationBoundary(
          atomicPathExchange,
          finalPath,
          replacementPath,
          partialMetadata,
        );
      if (!workerReturnedToReplacement) {
        throw new PendingPublicationRecoveryError(
          "A newer Encode output was restored after atomic exchange",
        );
      }
    } catch (rollbackError) {
      if (rollbackError instanceof PendingPublicationRecoveryError) {
        throw rollbackError;
      }
      throw new PendingPublicationRecoveryError(
        `${displacedFinalError.message}; atomic exchange rollback requires reconciliation: ${
          normalizeErrorMessage(rollbackError)
        }`,
      );
    }
    throw displacedFinalError;
  }
  onPublished();
  unlinkSync(replacementPath);
  syncPathAtMutationBoundary(dirname(finalPath));
}

async function cleanupReplacementLink(
  replacementPath: string,
  expectedMetadata?: Stats,
): Promise<void> {
  const metadata = await optionalMetadata(replacementPath);
  if (metadata === null) {
    return;
  }
  if (
    expectedMetadata !== undefined &&
    sameEncodeOutputInode(expectedMetadata, metadata)
  ) {
    await unlink(replacementPath);
    await syncPath(dirname(replacementPath));
    return;
  }
  await moveAside(replacementPath);
}

async function moveStalePartials(
  finalPath: string,
  runner: HandBrakeRunner,
): Promise<void> {
  const directory = dirname(finalPath);
  const prefix = `.${basename(finalPath)}.`;
  const suffix = ".rip-dvd-partial";
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
      continue;
    }
    const path = join(directory, name);
    if (dirname(path) !== directory || (runner.isActive?.(path) ?? false)) {
      continue;
    }
    await moveAside(path);
  }
}

async function restoreMovedAsideOutput(
  failedPath: string,
  finalPath: string,
): Promise<void> {
  await link(failedPath, finalPath);
  await syncPath(dirname(finalPath));
}

function publicationMatches(
  finalPath: string,
  partialPath: string,
): boolean {
  try {
    const finalMetadata = lstatSync(finalPath);
    const partialMetadata = lstatSync(partialPath);
    return (
      finalMetadata.isFile() &&
      !finalMetadata.isSymbolicLink() &&
      partialMetadata.isFile() &&
      !partialMetadata.isSymbolicLink() &&
      partialMetadata.size > 0 &&
      sameEncodeOutputMutationSnapshot(finalMetadata, partialMetadata)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function quarantinePartial(
  partialPath: string,
  runner: HandBrakeRunner,
  log: (message: string) => void,
  onQuarantined?: () => unknown | Promise<unknown>,
  onFailure?: (error: unknown) => unknown | Promise<unknown>,
): Promise<string | null> {
  if (!(runner.isActive?.(partialPath) ?? false)) {
    const failedPath = await moveAside(partialPath);
    await onQuarantined?.();
    return failedPath;
  }
  const inactive = runner.whenInactive?.(partialPath);
  if (inactive) {
    void inactive
      .then(async () => {
        await moveAside(partialPath);
        await onQuarantined?.();
      })
      .catch(async (error: unknown) => {
        try {
          await onFailure?.(error);
        } catch (reportError) {
          log(
            `Encode partial cleanup Failure Report could not be persisted: ${
              normalizeErrorMessage(reportError)
            }`,
          );
        }
        log(
          `Encode partial cleanup after HandBrake close failed: ${
            normalizeErrorMessage(error)
          }`,
        );
      });
  }
  return null;
}

async function reconcilePendingPublications(
  cleanups: readonly EncodeJobPartialCleanup[],
  options: EncodePublicationOptions,
): Promise<PublicationRecoveryStepResult> {
  if (cleanups.length === 0) {
    return "completed";
  }
  const recovery = createPublicationRecoveryStepTracker(
    options,
    "pending_partial_cleanup",
  );
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const cleanup of cleanups) {
    let mutationLockHandle: number | null = null;
    let reportingCleanup = cleanup;
    try {
      let authorizedCleanup = cleanup;
      const {
        cleanupQuarantinePath,
        finalPath,
        mutationLockPath,
        partialPath,
        priorFinalPath,
        replacementPath,
      } = await requireOutputPaths(
        mediaRoot,
        cleanup.outputPath,
        cleanup.claimToken,
      );
      let [
        quarantineMetadata,
        finalMetadata,
        partialMetadata,
        priorFinalMetadata,
        replacementMetadata,
      ] =
        await Promise.all([
          optionalMetadata(cleanupQuarantinePath),
          optionalMetadata(finalPath),
          optionalMetadata(partialPath),
          optionalMetadata(priorFinalPath),
          optionalMetadata(replacementPath),
        ]);
      for (const metadata of [
        quarantineMetadata,
        finalMetadata,
        partialMetadata,
        priorFinalMetadata,
        replacementMetadata,
      ]) {
        if (
          metadata !== null &&
          (!metadata.isFile() || metadata.isSymbolicLink())
        ) {
          throw new Error("Pending Encode publication is not a regular file");
        }
      }
      mutationLockHandle = options.mutationLock.tryAcquire(mutationLockPath);
      if (mutationLockHandle === null) {
        recovery.markDeferred();
        continue;
      }
      quarantineMetadata = await optionalMetadata(cleanupQuarantinePath);
      if (quarantineMetadata !== null) {
        const currentPartialMetadata = await optionalMetadata(partialPath);
        const currentFinalMetadata = await optionalMetadata(finalPath);
        if (quarantineMetadata !== null) {
          if (
            currentFinalMetadata !== null &&
            sameEncodeOutputInode(
              currentFinalMetadata,
              quarantineMetadata,
            )
          ) {
            await unlink(cleanupQuarantinePath);
            await syncPath(dirname(finalPath));
            quarantineMetadata = null;
          } else if (
            currentPartialMetadata !== null &&
            sameEncodeOutputInode(
              currentPartialMetadata,
              quarantineMetadata,
            )
          ) {
            await unlink(cleanupQuarantinePath);
            await syncPath(dirname(finalPath));
            quarantineMetadata = null;
          } else if (currentFinalMetadata === null) {
            try {
              linkSync(cleanupQuarantinePath, finalPath);
            } catch (error) {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "EEXIST"
              ) {
                throw new PendingPublicationRecoveryError(
                  "A newer Encode output appeared during quarantine recovery",
                );
              }
              throw error;
            }
            await syncPath(dirname(finalPath));
            await unlink(cleanupQuarantinePath);
            await syncPath(dirname(finalPath));
            finalMetadata = lstatSync(finalPath);
            quarantineMetadata = null;
          } else {
            throw new PendingPublicationRecoveryError(
              "A quarantined external Encode output requires reconciliation",
            );
          }
        }
      }
      const reconciledFinalMetadata = finalMetadata;
      const finalMatchesPartial =
        reconciledFinalMetadata !== null &&
        partialMetadata !== null &&
        partialMetadata.size > 0 &&
        sameEncodeOutputMutationSnapshot(
          reconciledFinalMetadata,
          partialMetadata,
        );
      if (
        finalMatchesPartial &&
        replacementMetadata !== null &&
        partialMetadata !== null &&
        !sameEncodeOutputInode(partialMetadata, replacementMetadata) &&
        (priorFinalMetadata === null ||
          !sameEncodeOutputInode(
            priorFinalMetadata,
            replacementMetadata,
          ))
      ) {
        let displacedFinalRestored = false;
        try {
          authorizedCleanup =
            options.access.encodeJobs.renewPublishedPartial(
              cleanup,
              () => {
                const currentFinalMetadata = lstatSync(finalPath);
                const currentReplacementMetadata = lstatSync(replacementPath);
                return (
                  sameEncodeOutputMutationSnapshot(
                    reconciledFinalMetadata,
                    currentFinalMetadata,
                  ) &&
                  sameEncodeOutputMutationSnapshot(
                    replacementMetadata,
                    currentReplacementMetadata,
                  )
                );
              },
            );
          reportingCleanup = authorizedCleanup;
          const currentFinalMetadata = lstatSync(finalPath);
          const currentReplacementMetadata = lstatSync(replacementPath);
          if (
            !sameEncodeOutputMutationSnapshot(
              reconciledFinalMetadata,
              currentFinalMetadata,
            ) ||
            !sameEncodeOutputMutationSnapshot(
              replacementMetadata,
              currentReplacementMetadata,
            )
          ) {
            throw new PendingPublicationRecoveryError(
              "Displaced Encode output changed after recovery authorization",
            );
          }
          const workerReturnedToReplacement =
            restoreHiddenFinalAtMutationBoundary(
              options.atomicPathExchange,
              finalPath,
              replacementPath,
              partialMetadata,
            );
          if (!workerReturnedToReplacement) {
            throw new PendingPublicationRecoveryError(
              "A newer Encode output was restored during recovery",
            );
          }
          const restoredFinalMetadata = lstatSync(finalPath);
          const stagedWorkerMetadata = lstatSync(replacementPath);
          if (
            !sameEncodeOutputInode(
              replacementMetadata,
              restoredFinalMetadata,
            ) ||
            !sameEncodeOutputInode(
              reconciledFinalMetadata,
              stagedWorkerMetadata,
            )
          ) {
            throw new PendingPublicationRecoveryError(
              "Displaced Encode output exchange requires reconciliation",
            );
          }
          await syncPath(dirname(finalPath));
          displacedFinalRestored = true;
        } catch (error) {
          if (!displacedFinalRestored) {
            throw error;
          }
        }
        await cleanupReplacementLink(replacementPath, partialMetadata);
        await quarantinePartial(
          partialPath,
          options.runner,
          options.log,
          () =>
            options.access.encodeJobs.completePartialCleanup(
              authorizedCleanup,
            ),
        );
        continue;
      }
      if (replacementMetadata !== null) {
        await cleanupReplacementLink(
          replacementPath,
          finalMatchesPartial && priorFinalMetadata !== null
            ? priorFinalMetadata
            : partialMetadata ?? undefined,
        );
      }
      if (finalMatchesPartial) {
        if (cleanup.publicationPending) {
          await syncPath(dirname(finalPath));
          const completion =
            options.access.encodeJobs.completePublishedPartial(
              cleanup,
              () => publicationMatches(finalPath, partialPath),
              correctedRetainedOutputProvenance(
                options.access,
                cleanup.jobId,
                priorFinalPath,
                priorFinalMetadata,
              ),
            );
          authorizedCleanup = completion.cleanup;
          reportingCleanup = authorizedCleanup;
        } else {
          authorizedCleanup =
            options.access.encodeJobs.withPartialCleanupMutationFence(
              cleanup,
              () => {
                moveAsideAtMutationBoundary(
                  finalPath,
                  cleanupQuarantinePath,
                  reconciledFinalMetadata,
                );
              },
            );
          reportingCleanup = authorizedCleanup;
          await syncPath(dirname(finalPath));
          if (priorFinalMetadata !== null) {
            await restoreMovedAsideOutput(priorFinalPath, finalPath);
          }
        }
        await unlink(partialPath);
        await syncPath(dirname(finalPath));
        options.access.encodeJobs.completePartialCleanup(authorizedCleanup);
        continue;
      }
      if (reconciledFinalMetadata === null && priorFinalMetadata !== null) {
        await restoreMovedAsideOutput(priorFinalPath, finalPath);
      }
      await quarantinePartial(
        partialPath,
        options.runner,
        options.log,
        () => options.access.encodeJobs.completePartialCleanup(cleanup),
      );
    } catch (error) {
      recordCleanupFailure(
        reportingCleanup,
        publicationRecoveryFailureReport(
          error,
          reportingCleanup.publicationPending,
        ),
        options,
      );
      recovery.recordFailure(
        "Pending Encode publication could not be reconciled",
        error,
      );
    } finally {
      if (mutationLockHandle !== null) {
        options.mutationLock.release(mutationLockHandle);
      }
    }
  }
  return recovery.result();
}

async function recoverAbandonedPublicationMutations(
  options: EncodePublicationOptions,
  failureReports: PublicationMutationFailureReports,
): Promise<PublicationRecoveryStepResult> {
  const mutations =
    options.access.encodeJobs.listExpiredPublicationMutations();
  if (mutations.length === 0) {
    return "completed";
  }
  const recovery = createPublicationRecoveryStepTracker(
    options,
    "expired_publication_mutation",
  );
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const mutation of mutations) {
    try {
      const { mutationLockPath } = await requireOutputPaths(
        mediaRoot,
        mutation.outputPath,
        mutation.claimToken,
      );
      const handle = options.mutationLock.tryAcquire(mutationLockPath);
      if (handle === null) {
        recovery.markDeferred();
        continue;
      }
      try {
        options.access.encodeJobs.recoverExpiredPublicationMutation(
          mutation,
          mutation.leaseToken === null
            ? undefined
            : failureReports.get(mutation.leaseToken),
        );
      } finally {
        options.mutationLock.release(handle);
      }
    } catch (error) {
      recovery.recordFailure(
        "Encode publication mutation could not be recovered",
        error,
      );
    }
  }
  return recovery.result();
}

async function recoverAbandonedCancellations(
  options: EncodePublicationOptions,
): Promise<PublicationRecoveryStepResult> {
  const claims = options.access.encodeJobs.listExpiredCancellationClaims();
  if (claims.length === 0) {
    return "completed";
  }
  const recovery = createPublicationRecoveryStepTracker(
    options,
    "expired_cancellation",
  );
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const claim of claims) {
    let mutationLockHandle: number | null = null;
    try {
      const { mutationLockPath, partialPath } = await requireOutputPaths(
        mediaRoot,
        claim.outputPath,
        claim.claimToken,
      );
      mutationLockHandle = options.mutationLock.tryAcquire(mutationLockPath);
      if (mutationLockHandle === null) {
        recovery.markDeferred();
        continue;
      }
      if (options.runner.requireInactive === undefined) {
        throw new Error("HandBrake process closure cannot be confirmed");
      }
      options.access.encodeJobs.completeExpiredCancellation(
        claim,
        () => options.runner.requireInactive?.(partialPath),
      );
    } catch (error) {
      recovery.recordFailure(
        `Encode Job ${claim.id} cancellation recovery is waiting for process closure`,
        error,
      );
    } finally {
      if (mutationLockHandle !== null) {
        options.mutationLock.release(mutationLockHandle);
      }
    }
  }
  return recovery.result();
}

async function reconcileActivePublicationMutations(
  options: EncodePublicationOptions,
  failureReports: PublicationMutationFailureReports,
): Promise<PublicationRecoveryStepResult> {
  const mutations = options.access.encodeJobs.listPublicationMutations();
  if (mutations.length === 0) {
    return "completed";
  }
  const recovery = createPublicationRecoveryStepTracker(
    options,
    "active_publication",
  );
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const mutation of mutations) {
    try {
      const { finalPath, partialPath, priorFinalPath, replacementPath } =
        await requireOutputPaths(
        mediaRoot,
        mutation.outputPath,
        mutation.claimToken,
      );
      const [
        finalMetadata,
        partialMetadata,
        priorFinalMetadata,
        replacementMetadata,
      ] =
        await Promise.all([
          optionalMetadata(finalPath),
          optionalMetadata(partialPath),
          optionalMetadata(priorFinalPath),
          optionalMetadata(replacementPath),
        ]);
      if (
        finalMetadata === null ||
        partialMetadata === null ||
        replacementMetadata !== null ||
        partialMetadata.size <= 0 ||
        !sameEncodeOutputMutationSnapshot(finalMetadata, partialMetadata)
      ) {
        continue;
      }
      await syncPath(dirname(finalPath));
      options.access.encodeJobs.completePublishedMutation(
        mutation,
        () => publicationMatches(finalPath, partialPath),
        correctedRetainedOutputProvenance(
          options.access,
          mutation.jobId,
          priorFinalPath,
          priorFinalMetadata,
        ),
      );
      await unlink(partialPath);
      await syncPath(dirname(finalPath));
      options.access.encodeJobs.completePartialCleanup(mutation);
    } catch (error) {
      const failureReport = publicationRecoveryFailureReport(
        error,
        mutation.publicationPending,
      );
      recordCleanupFailure(
        mutation,
        failureReport,
        options,
      );
      if (mutation.leaseToken !== null) {
        failureReports.set(mutation.leaseToken, failureReport);
      }
      recovery.recordFailure(
        "Active Encode publication mutation could not be reconciled",
        error,
      );
    }
  }
  return recovery.result();
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function buildSelectionArguments(selection: DiscSelection): string[] {
  const sourceIdentity = selection.sourceIdentity;
  if (sourceIdentity.kind === "main_feature") {
    return ["--main-feature"];
  }
  if (sourceIdentity.kind === "dvd_title") {
    return ["--title", String(sourceIdentity.titleNumber)];
  }
  return [
    "--title",
    String(sourceIdentity.titleNumber),
    "--chapters",
    `${sourceIdentity.chapterStart}-${sourceIdentity.chapterEnd}`,
  ];
}

function resolveClaimInput(access: DataAccess, claim: RunningEncodeJob) {
  return access.readConsistentSnapshot((snapshot) => {
    const selection = snapshot.catalog.listDiscSelections({
      ids: [claim.discSelectionId],
      encodeEligibleOnly: true,
    })[0];
    if (!selection) {
      throw new ClassifiedEncodeFailureError(
        "Encode Job Disc Selection is unavailable",
        "input_unavailable",
        "preparation",
      );
    }
    const archive = snapshot.catalog.listOriginalDiscArchives({
      ids: [selection.originalDiscArchiveId],
    })[0];
    if (!archive || archive.discKind !== "dvd" || archive.archiveFormat !== "iso") {
      throw new ClassifiedEncodeFailureError(
        "Encode Job requires a DVD ISO Original Disc Archive",
        "input_unavailable",
        "preparation",
      );
    }
    const profile = snapshot.encodingProfiles.list({
      ids: [claim.encodingProfileId],
    })[0];
    const preset = profile?.settings.preset;
    if (
      !profile ||
      profile.mediaDomain !== "dvd_video" ||
      typeof preset !== "string" ||
      !isHandBrakePreset(preset) ||
      (profile.settings.container !== undefined &&
        profile.settings.container !== "mkv")
    ) {
      throw new ClassifiedEncodeFailureError(
        "Encode Job has invalid DVD video profile settings",
        "invalid_configuration",
        "preparation",
      );
    }
    const sourceIdentity = selection.sourceIdentity;
    const detectedDisc = snapshot.catalog.listDetectedDiscs(undefined, {
      ids: [archive.detectedDiscId],
    })[0];
    const archivedTitles = decodeArchivedDvdTitles(detectedDisc?.scanData);
    let expectedDurationSeconds: number | undefined;
    let expectedVobSubStreams:
      | readonly EncodeOutputVobSubExpectation[]
      | undefined;
    if (sourceIdentity.kind === "main_feature") {
      expectedDurationSeconds = archivedTitles?.reduce(
        (longest, title) => Math.max(longest, title.durationSeconds),
        0,
      );
      if (!expectedDurationSeconds) {
        throw new ClassifiedEncodeFailureError(
          "Encode Job DVD title metadata is unavailable",
          "input_unavailable",
          "preparation",
        );
      }
    } else {
      const selectedTitle = archivedTitles?.find(
        (title) => title.number === sourceIdentity.titleNumber,
      );
      if (selectedTitle === undefined) {
        throw new ClassifiedEncodeFailureError(
          "Encode Job DVD title metadata is unavailable",
          "input_unavailable",
          "preparation",
        );
      }
      if (sourceIdentity.kind === "dvd_title") {
        expectedDurationSeconds = selectedTitle.durationSeconds;
        if (!expectedDurationSeconds) {
          throw new ClassifiedEncodeFailureError(
            "Encode Job DVD title duration is unavailable",
            "input_unavailable",
            "preparation",
          );
        }
      }
      const selectedCurrentTitle = decodeDvdTitleMap(
        detectedDisc?.scanData,
      )?.titles.find((title) => title.number === sourceIdentity.titleNumber);
      expectedVobSubStreams =
        selectedCurrentTitle === undefined
          ? selectedTitle.subtitles.map(() => ({}))
          : selectedCurrentTitle.subtitles.map((subtitle) => ({
              ...(subtitle.content === undefined
                ? {}
                : { contentLabel: subtitle.content }),
              languageCode: subtitle.languageCode ?? "und",
            }));
    }
    return {
      archive,
      expectedDurationSeconds,
      expectedVobSubStreams,
      preset: preset.trim(),
      selection,
    };
  });
}

export async function executeEncodeClaim(
  claim: RunningEncodeJob,
  options: EncodePublicationOptions,
): Promise<void> {
  const claimController = new AbortController();
  const signal = AbortSignal.any([options.signal, claimController.signal]);
  const renewClaim = () => {
    const renewed = options.access.encodeJobs.renewClaim(claim);
    if (renewed.status === "cancellation_requested") {
      const cancellation = new EncodeCancellationRequestedError(
        "Encode Job cancellation was requested",
      );
      claimController.abort(cancellation);
      throw cancellation;
    }
    return renewed;
  };
  const heartbeat = setInterval(() => {
    try {
      renewClaim();
    } catch (error) {
      claimController.abort(error);
    }
  }, Math.floor(ENCODE_JOB_LEASE_DURATION_MS / 3));
  heartbeat.unref();
  let finalPath: string | undefined;
  let partialPath: string | undefined;
  let replacementPath: string | undefined;
  let cleanupQuarantinePath: string | undefined;
  let replaceableFinal: Stats | undefined;
  let priorFinalFailedPath: string | null = null;
  let priorFinalRestored = false;
  let publishedOutputMetadata: Stats | undefined;
  let pendingPartialCleanup: EncodeJobPartialCleanup | undefined;
  let published = false;
  let mutationLockHandle: number | null = null;
  let failurePhase: EncodeJobFailureReportInput["phase"] = "preparation";
  let publicationOperation: Extract<
    EncodeJobFailureReportInput["evidence"],
    { kind: "publication" }
  >["operation"] = "publication_mutation";
  try {
    const input = resolveClaimInput(options.access, claim);
    const originalsRoot = await runEncodePreparationStep(
      () =>
        requireLibraryRoot(options.originalsLibraryPath, {
          create: false,
        }),
      "input_unavailable",
    );
    const mediaRoot = await runEncodePreparationStep(
      () =>
        requireLibraryRoot(options.mediaLibraryPath, {
          create: true,
        }),
      "unsafe_output_state",
    );
    const sourcePath = await runEncodePreparationStep(
      () =>
        requireSourcePath(
          originalsRoot,
          input.archive.archivePath,
        ),
      "input_unavailable",
    );
    const paths = await runEncodePreparationStep(
      () =>
        requireOutputPaths(
          mediaRoot,
          claim.outputPath,
          claim.claimToken,
        ),
      "unsafe_output_state",
    );
    finalPath = paths.finalPath;
    partialPath = paths.partialPath;
    replacementPath = paths.replacementPath;
    cleanupQuarantinePath = paths.cleanupQuarantinePath;
    mutationLockHandle = options.mutationLock.tryAcquire(
      paths.mutationLockPath,
    );
    if (mutationLockHandle === null) {
      throw new ClassifiedEncodeFailureError(
        "Encode output ownership is already active",
        "output_conflict",
        "preparation",
      );
    }
    const existingFinal = await optionalMetadata(finalPath);
    if (
      existingFinal !== null &&
      (!existingFinal.isFile() || existingFinal.isSymbolicLink())
    ) {
      throw new ClassifiedEncodeFailureError(
        "Encode Job final output is not a regular file",
        "unsafe_output_state",
        "preparation",
      );
    }
    if (existingFinal !== null && !claim.replaceExistingOutput) {
      throw new ClassifiedEncodeFailureError(
        "Encode Job final output already exists",
        "output_conflict",
        "preparation",
      );
    }
    if (existingFinal !== null && claim.replaceExistingOutput) {
      const identity = encodeOutputFilesystemIdentity(existingFinal);
      if (
        claim.replacementOutputIdentity !== null &&
        !matchesEncodeOutputFilesystemIdentity(
          claim.replacementOutputIdentity,
          existingFinal,
        )
      ) {
        throw new ClassifiedEncodeFailureError(
          "Encode Job prior final output changed before retry",
          "output_conflict",
          "preparation",
        );
      }
      options.access.encodeJobs.recordReplacementOutputIdentity(
        claim,
        identity,
      );
    }
    replaceableFinal = existingFinal ?? undefined;
    try {
      await moveAside(paths.legacyPartialPath);
      await moveStalePartials(finalPath, options.runner);
    } catch (error) {
      throw new ClassifiedEncodeFailureError(
        normalizeErrorMessage(error),
        "unsafe_output_state",
        "preparation",
      );
    }
    const parseProgress = createProgressParser((progress) => {
      failurePhase = progress.phase;
      try {
        options.access.encodeJobs.updateProgress(claim, progress);
      } catch (error) {
        try {
          renewClaim();
        } catch (renewalError) {
          if (renewalError instanceof EncodeCancellationRequestedError) {
            return;
          }
        }
        throw error;
      }
    });
    const arguments_ = [
      "--no-dvdnav",
      ...buildSelectionArguments(input.selection),
      "-i",
      sourcePath,
      "-o",
      partialPath,
      "--format",
      "av_mkv",
      "--preset",
      input.preset,
      "--all-subtitles",
      "--subtitle-burned=none",
    ];
    failurePhase = "encoding";
    renewClaim();
    failurePhase = "encoding";
    await options.runner.run({
      arguments_,
      onOutput: parseProgress,
      outputPath: partialPath,
      signal,
    });
    parseProgress("", true);
    signal.throwIfAborted();
    failurePhase = "validation";
    await requireRegularOutputForValidation(
      partialPath,
      "HandBrake did not produce a complete regular output file",
    );
    failurePhase = "validation";
    await options.outputValidator.prepareAndValidate(partialPath, signal, {
      ...(input.expectedDurationSeconds === undefined
        ? {}
        : { expectedDurationSeconds: input.expectedDurationSeconds }),
      ...(input.expectedVobSubStreams === undefined
        ? {}
        : { expectedVobSubStreams: input.expectedVobSubStreams }),
    });
    signal.throwIfAborted();
    const validatedPartialMetadata = await requireRegularOutputForValidation(
      partialPath,
      "Encode output validation did not retain a regular output file",
    );
    await syncPath(partialPath);
    failurePhase = "publication";
    publishedOutputMetadata = validatedPartialMetadata;
    pendingPartialCleanup =
      options.access.encodeJobs.registerPartialCleanup(claim, {
        publicationPending: true,
      });
    const currentFinal =
      replaceableFinal === undefined
        ? null
        : await optionalMetadata(finalPath);
    if (
      replaceableFinal !== undefined &&
      currentFinal !== null &&
      !sameEncodeOutputMutationSnapshot(replaceableFinal, currentFinal)
    ) {
      throw new ClassifiedEncodeFailureError(
        "Encode Job final output changed during encoding",
        "output_conflict",
        "publication",
      );
    }
    renewClaim();
    signal.throwIfAborted();
    pendingPartialCleanup =
      options.access.encodeJobs.beginPublicationMutation(
        claim,
        pendingPartialCleanup,
        claim.predecessorEncodeJobId === null || replaceableFinal === undefined
          ? undefined
          : paths.priorFinalPath,
      );
    signal.throwIfAborted();
    if (currentFinal !== null) {
      priorFinalFailedPath = paths.priorFinalPath;
      publishReplacementAtMutationBoundary(
        options.atomicPathExchange,
        paths.finalPath,
        paths.priorFinalPath,
        paths.replacementPath,
        paths.partialPath,
        currentFinal,
        () => {
          published = true;
        },
        options.log,
      );
    } else {
      try {
        linkSync(paths.partialPath, paths.finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ClassifiedEncodeFailureError(
            "Encode Job final output appeared before publication",
            "output_conflict",
            "publication",
          );
        }
        throw error;
      }
      published = true;
    }
    await syncPath(dirname(finalPath));
    let publicationChangedBeforeCompletion = false;
    publicationOperation = "publication_completion";
    try {
      options.access.encodeJobs.completePublishedClaim(
        claim,
        pendingPartialCleanup,
        () => {
          const matches = publicationMatches(
            paths.finalPath,
            paths.partialPath,
          );
          publicationChangedBeforeCompletion = !matches;
          return matches;
        },
        claim.predecessorEncodeJobId === null ||
            priorFinalFailedPath === null ||
            replaceableFinal === undefined
          ? undefined
          : retainedOutputProvenance(
              priorFinalFailedPath,
              replaceableFinal,
            ),
      );
    } catch (error) {
      if (publicationChangedBeforeCompletion) {
        recordCleanupFailure(
          pendingPartialCleanup,
          publicationFailureReport(error, "publication_completion"),
          options,
        );
        options.log(
          "Encode publication changed before completion; retained for reconciliation",
        );
        return;
      }
      throw error;
    }
    try {
      await unlink(partialPath);
      await syncPath(dirname(finalPath));
      options.access.encodeJobs.completePartialCleanup(pendingPartialCleanup);
    } catch (cleanupError) {
      recordCleanupFailure(
        pendingPartialCleanup,
        cleanupFailureReport(cleanupError, "publication_completion"),
        options,
      );
      options.log(
        `Completed Encode publication cleanup failed: ${
          normalizeErrorMessage(cleanupError)
        }`,
      );
    }
  } catch (error) {
    if (error instanceof PendingPublicationRecoveryError) {
      recordClaimFailure(
        claim,
        publicationFailureReport(error, publicationOperation),
        "Encode publication",
        options,
      );
      options.log(
        `Encode publication mutation requires reconciliation: ${error.message}`,
      );
      return;
    }
    let cancellationRequested =
      claimController.signal.reason instanceof EncodeCancellationRequestedError;
    if (!cancellationRequested && !options.signal.aborted) {
      try {
        cancellationRequested =
          options.access.encodeJobs.renewClaim(claim).status ===
            "cancellation_requested";
      } catch {
        // A competing terminal transition remains authoritative.
      }
    }
    if (cancellationRequested && partialPath !== undefined) {
      await options.runner.whenInactive?.(partialPath);
      if (options.runner.isActive?.(partialPath) ?? false) {
        options.log(
          `Encode Job ${claim.id} cancellation is waiting for HandBrake closure`,
        );
        return;
      }
    }
    const cleanupFailures: string[] = [];
    const cleanupFailureReports: EncodeJobFailureReportInput[] = [];
    const rememberCleanupFailure = (
      cleanupError: unknown,
      operation: Extract<
        EncodeJobFailureReportInput["evidence"],
        { kind: "cleanup" }
      >["operation"],
    ) => {
      cleanupFailures.push(normalizeErrorMessage(cleanupError));
      if (!cancellationRequested) {
        cleanupFailureReports.push(
          cleanupFailureReport(cleanupError, operation),
        );
      }
    };
    let replacementCleanupFailed = false;
    let preserveReplacementAuthority = priorFinalRestored;
    if (published) {
      try {
        if (pendingPartialCleanup === undefined) {
          throw new Error("Encode publication provenance is unavailable");
        }
        pendingPartialCleanup =
          options.access.encodeJobs.revokePublication(
            claim,
            pendingPartialCleanup,
          );
      } catch (authorityError) {
        options.log(
          `Stale Encode publisher left publication recovery to reconciliation: ${
            normalizeErrorMessage(authorityError)
          }`,
        );
        if (options.signal.aborted) {
          recordClaimFailure(
            claim,
            interruptionFailureReport(error, failurePhase),
            "Encode interruption",
            options,
          );
          throw error;
        }
        if (pendingPartialCleanup !== undefined) {
          recordCleanupFailure(
            pendingPartialCleanup,
            publicationFailureReport(error, publicationOperation),
            options,
          );
        }
        return;
      }
    }
    if (
      !published &&
      finalPath !== undefined &&
      replaceableFinal !== undefined
    ) {
      try {
        const currentFinal = await optionalMetadata(finalPath);
        if (
          currentFinal !== null &&
          sameEncodeOutputAuthoritySnapshot(
            replaceableFinal,
            currentFinal,
          )
        ) {
          preserveReplacementAuthority = true;
        }
      } catch (cleanupError) {
        rememberCleanupFailure(cleanupError, "published_output");
      }
    }
    if (!published && replacementPath !== undefined) {
      try {
        await cleanupReplacementLink(
          replacementPath,
          publishedOutputMetadata,
        );
      } catch (cleanupError) {
        replacementCleanupFailed = true;
        rememberCleanupFailure(cleanupError, "replacement_artifact");
      }
    }
    if (published && finalPath !== undefined) {
      try {
        const rollbackFinalPath = finalPath;
        let rolledBack = false;
        let currentFinal: Stats | null;
        try {
          currentFinal = lstatSync(rollbackFinalPath);
        } catch (metadataError) {
          if ((metadataError as NodeJS.ErrnoException).code === "ENOENT") {
            currentFinal = null;
          } else {
            throw metadataError;
          }
        }
        if (
          currentFinal !== null &&
          publishedOutputMetadata !== undefined &&
          sameEncodeOutputInode(publishedOutputMetadata, currentFinal)
        ) {
          if (cleanupQuarantinePath === undefined) {
            throw new Error("Encode output quarantine path is unavailable");
          }
          moveAsideAtMutationBoundary(
            rollbackFinalPath,
            cleanupQuarantinePath,
            currentFinal,
          );
          rolledBack = true;
        }
        if (rolledBack) {
          await syncPath(dirname(finalPath));
        }
      } catch (cleanupError) {
        rememberCleanupFailure(cleanupError, "published_output");
      }
      if (priorFinalFailedPath !== null) {
        try {
          await restoreMovedAsideOutput(priorFinalFailedPath, finalPath);
          preserveReplacementAuthority = true;
        } catch (cleanupError) {
          rememberCleanupFailure(cleanupError, "published_output");
        }
      }
    }
    if (partialPath !== undefined) {
      if (
        pendingPartialCleanup === undefined &&
        (options.runner.isActive?.(partialPath) ?? false)
      ) {
        try {
          pendingPartialCleanup =
            options.access.encodeJobs.registerPartialCleanup(claim);
        } catch (cleanupError) {
          rememberCleanupFailure(cleanupError, "partial_output");
        }
      } else if (pendingPartialCleanup === undefined) {
        try {
          await quarantinePartial(partialPath, options.runner, options.log);
        } catch (cleanupError) {
          rememberCleanupFailure(cleanupError, "partial_output");
        }
      }
    }
    if (cancellationRequested) {
      if (
        partialPath !== undefined &&
        pendingPartialCleanup !== undefined &&
        !replacementCleanupFailed
      ) {
        const cleanup = pendingPartialCleanup;
        try {
          await quarantinePartial(
            partialPath,
            options.runner,
            options.log,
            () => options.access.encodeJobs.completePartialCleanup(cleanup),
          );
        } catch (cleanupError) {
          rememberCleanupFailure(cleanupError, "partial_output");
        }
      }
      if (cleanupFailures.length > 0) {
        options.log(
          `Encode Job ${claim.id} cancellation cleanup failed: ${
            cleanupFailures.join("; ")
          }`,
        );
        return;
      }
      try {
        options.access.encodeJobs.completeCancellation(claim);
        options.log(`Encode Job ${claim.id} cancelled`);
      } catch (cancellationError) {
        options.log(
          `Encode Job cancellation state could not be persisted: ${
            normalizeErrorMessage(cancellationError)
          }`,
        );
      }
      return;
    }
    const failureMessage = signal.aborted
      ? "Encode interrupted"
      : normalizeErrorMessage(error);
    let message = failureMessage.slice(0, 500);
    try {
      const classifiedReport = encodeFailureReport(error, failurePhase);
      const primaryReport = options.signal.aborted
        ? interruptionFailureReport(error, failurePhase)
        : classifiedReport.reasonCode === "unknown_failure" &&
            failurePhase === "publication"
          ? publicationFailureReport(error, publicationOperation)
          : classifiedReport;
      if (primaryReport.reasonCode === "command_timeout") {
        message = "HandBrake command timed out";
      } else if (primaryReport.reasonCode === "command_failed") {
        message = "HandBrake command failed";
      }
      const reports = [
        primaryReport,
        ...cleanupFailureReports,
      ];
      if (cleanupFailureReports.length === 0) {
        options.access.encodeJobs.failWithReport(claim, primaryReport, {
          preserveReplacementAuthority,
        });
      } else {
        options.access.encodeJobs.failWithReports(
          claim,
          message,
          reports,
          { preserveReplacementAuthority },
        );
      }
    } catch (failureError) {
      const failureMessage = normalizeErrorMessage(failureError);
      options.log(
        `Encode Job failure state could not be persisted: ${failureMessage}`,
      );
    }
    if (
      partialPath !== undefined &&
      pendingPartialCleanup !== undefined &&
      !replacementCleanupFailed
    ) {
      const cleanup = pendingPartialCleanup;
      try {
        await quarantinePartial(
          partialPath,
          options.runner,
          options.log,
          () =>
            options.access.encodeJobs.completePartialCleanup(cleanup),
          (cleanupError) =>
            recordCleanupFailure(
              cleanup,
              cleanupFailureReport(cleanupError, "partial_output"),
              options,
            ),
        );
      } catch (cleanupError) {
        recordCleanupFailure(
          cleanup,
          cleanupFailureReport(cleanupError, "partial_output"),
          options,
        );
        options.log(
          `Deferred Encode partial cleanup could not start: ${
            normalizeErrorMessage(cleanupError)
          }`,
        );
      }
    }
    if (options.signal.aborted) {
      throw error;
    }
    options.log(`Encode Job ${claim.id} failed: ${message}`);
  } finally {
    if (mutationLockHandle !== null) {
      options.mutationLock.release(mutationLockHandle);
    }
    clearInterval(heartbeat);
  }
}

export async function reconcileEncodePublications(
  options: EncodePublicationOptions,
): Promise<void> {
  const publicationMutationFailureReports: PublicationMutationFailureReports =
    new Map();
  const runPublicationRecoveryStep = async (
    recoveryArea: EncodeWorkerIncidentRecoveryArea,
    failureMessage: string,
    recover: () =>
      | PublicationRecoveryStepResult
      | Promise<PublicationRecoveryStepResult>,
  ) => {
    try {
      const result = await recover();
      if (result === "completed") {
        resolveEncodePublicationRecoveryIncident(options, recoveryArea);
      }
    } catch (error) {
      options.log(`${failureMessage}: ${normalizeErrorMessage(error)}`);
      recordEncodePublicationRecoveryIncident(options, recoveryArea);
      throw new EncodePublicationRecoveryError(error);
    }
  };

  await runPublicationRecoveryStep(
    "active_publication",
    "Active Encode publications could not be listed for reconciliation",
    () =>
      reconcileActivePublicationMutations(
        options,
        publicationMutationFailureReports,
      ),
  );
  await runPublicationRecoveryStep(
    "expired_publication_mutation",
    "Expired Encode publication mutations could not be listed for recovery",
    () =>
      recoverAbandonedPublicationMutations(
        options,
        publicationMutationFailureReports,
      ),
  );
  await runPublicationRecoveryStep(
    "expired_encode_job_claim",
    "Expired Encode Job claims could not be recovered",
    () => {
      options.access.encodeJobs.recoverExpiredClaims();
      return "completed";
    },
  );
  await runPublicationRecoveryStep(
    "expired_cancellation",
    "Expired Encode Job cancellations could not be listed for recovery",
    () => recoverAbandonedCancellations(options),
  );
  await runPublicationRecoveryStep(
    "pending_partial_cleanup",
    "Pending Encode publications could not be listed for reconciliation",
    () => reconcilePendingPublications(
      options.access.encodeJobs.listPendingPartialCleanups(),
      options,
    ),
  );
}
