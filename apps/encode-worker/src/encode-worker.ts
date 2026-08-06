import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
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
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  ENCODE_JOB_LEASE_DURATION_MS,
  type DataAccess,
  type DiscSelection,
  type EncodeJobPartialCleanup,
  type EncodeJobProgress,
  type RunningEncodeJob,
} from "@rip-dvd/data-access";

const HANDBRAKE_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 65_536;
const MAX_PATH_BYTES = 4_096;
const ATOMIC_EXCHANGE_PATH = fileURLToPath(
  new URL("../dist/rip-dvd-atomic-exchange.node", import.meta.url),
);

class PendingPublicationRecoveryError extends Error {}

export interface HandBrakeRunRequest {
  arguments_: readonly string[];
  onOutput(text: string): void;
  outputPath: string;
  signal: AbortSignal;
}

export interface HandBrakeRunner {
  run(request: HandBrakeRunRequest): Promise<void>;
  isActive?(outputPath: string): boolean;
  whenInactive?(outputPath: string): Promise<void>;
}

export interface AtomicPathExchange {
  exchange(firstPath: string, secondPath: string): void;
}

interface AtomicPathExchangeBinding {
  exchangePaths(firstPath: string, secondPath: string): void;
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

export const nodeAtomicPathExchange = createNodeAtomicPathExchange();

interface HandBrakeChildProcess {
  stderr: Readable;
  stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

type SpawnHandBrake = (
  executable: string,
  arguments_: readonly string[],
  options: { shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => HandBrakeChildProcess;

function boundedDiagnostic(value: string): string {
  return Buffer.from(value)
    .subarray(-MAX_DIAGNOSTIC_BYTES)
    .toString("utf8")
    .trim();
}

export function createNodeHandBrakeRunner({
  spawnProcess = spawn as SpawnHandBrake,
  timeoutMs = HANDBRAKE_TIMEOUT_MS,
}: {
  spawnProcess?: SpawnHandBrake;
  timeoutMs?: number;
} = {}): HandBrakeRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("HandBrake timeout is invalid");
  }
  const activeOutputs = new Set<string>();
  const inactiveWaiters = new Map<
    string,
    { promise: Promise<void>; resolve(): void }
  >();
  const activateOutput = (outputPath: string) => {
    let resolveInactive!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveInactive = resolve;
    });
    activeOutputs.add(outputPath);
    inactiveWaiters.set(outputPath, {
      promise,
      resolve: resolveInactive,
    });
  };
  const releaseOutput = (outputPath: string) => {
    activeOutputs.delete(outputPath);
    const waiter = inactiveWaiters.get(outputPath);
    inactiveWaiters.delete(outputPath);
    waiter?.resolve();
  };
  return {
    isActive(outputPath) {
      return activeOutputs.has(outputPath);
    },
    whenInactive(outputPath) {
      return inactiveWaiters.get(outputPath)?.promise ?? Promise.resolve();
    },
    run({ arguments_, onOutput, outputPath, signal }) {
      signal.throwIfAborted();
      if (activeOutputs.has(outputPath)) {
        return Promise.reject(new Error("HandBrake output is still active"));
      }
      activateOutput(outputPath);
      return new Promise<void>((resolveRun, rejectRun) => {
        let child: HandBrakeChildProcess;
        try {
          child = spawnProcess(
            "nice",
            [
              "-n",
              "19",
              "ionice",
              "-c",
              "3",
              "HandBrakeCLI",
              ...arguments_,
            ],
            { shell: false, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (error) {
          releaseOutput(outputPath);
          rejectRun(error);
          return;
        }
        let settled = false;
        let diagnostics = "";
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          error === undefined ? resolveRun() : rejectRun(error);
        };
        const cancel = (error: unknown) => {
          if (settled) {
            return;
          }
          try {
            child.kill("SIGKILL");
          } catch {
            // The original timeout, abort, or parser error remains authoritative.
          }
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(error);
        };
        const capture = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          diagnostics = boundedDiagnostic(`${diagnostics}${text}`);
          try {
            onOutput(text);
          } catch (error) {
            cancel(error);
          }
        };
        const abort = () => {
          cancel(signal.reason ?? new Error("HandBrake was interrupted"));
        };
        const timeout = setTimeout(() => {
          cancel(new Error("HandBrake timed out"));
        }, timeoutMs);
        timeout.unref();
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("error", (error) => finish(error));
        child.once("close", (code, closeSignal) => {
          releaseOutput(outputPath);
          if (settled) {
            return;
          }
          if (code === 0) {
            finish();
            return;
          }
          const detail = boundedDiagnostic(diagnostics).slice(0, 500);
          finish(
            new Error(
              `HandBrake failed${detail ? `: ${detail}` : ` with ${closeSignal ?? `status ${code}`}`}`,
            ),
          );
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    },
  };
}

export const nodeHandBrakeRunner = createNodeHandBrakeRunner();

export interface PollEncodeWorkerOptions {
  access: DataAccess;
  atomicPathExchange?: AtomicPathExchange;
  concurrency: number;
  log(message: string): void;
  mediaLibraryPath: string;
  originalsLibraryPath: string;
  runner?: HandBrakeRunner;
  signal: AbortSignal;
  workerId?: string;
}

export interface RunEncodeWorkerOptions extends PollEncodeWorkerOptions {
  pollIntervalMs: number;
  waitForNextPoll?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
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
  if (create) {
    await mkdir(resolved, { recursive: true, mode: 0o750 });
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Library path must be a real directory");
  }
  return realpath(resolved);
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
  await mkdir(outputDirectory, {
    recursive: true,
    mode: 0o750,
  });
  const canonicalOutputDirectory = await realpath(outputDirectory);
  if (!isContained(mediaLibraryPath, canonicalOutputDirectory)) {
    throw new Error("Encode Job output directory escaped the media library");
  }
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
  const legacyPartialPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.rip-dvd-partial`,
  );
  const priorFinalPath = `${finalPath}.failed.${safeToken}`;
  for (const path of [
    finalPath,
    partialPath,
    replacementPath,
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
    finalPath,
    legacyPartialPath,
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
  if (expectedMetadata !== undefined && !sameFile(expectedMetadata, metadata)) {
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
  if (!sameInode(metadata, quarantinedMetadata)) {
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
  if (!sameFile(expectedMetadata, metadata)) {
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
  renameSync(path, failedPath);
  const quarantinedMetadata = lstatSync(failedPath);
  if (!sameInode(metadata, quarantinedMetadata)) {
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

function syncPathAtMutationBoundary(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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
): void {
  const finalMetadata = lstatSync(finalPath);
  if (!sameFile(expectedFinal, finalMetadata)) {
    throw new Error("Encode output changed before atomic replacement");
  }
  if (!finalMetadata.isFile() || finalMetadata.isSymbolicLink()) {
    throw new Error("Encode output path is not a regular file");
  }
  linkSync(finalPath, priorFinalPath);
  const priorFinalMetadata = lstatSync(priorFinalPath);
  if (!sameInode(expectedFinal, priorFinalMetadata)) {
    throw new Error("Encode output changed while retaining recovery");
  }
  linkSync(partialPath, replacementPath);
  syncPathAtMutationBoundary(dirname(finalPath));
  const currentFinalMetadata = lstatSync(finalPath);
  if (!sameInode(expectedFinal, currentFinalMetadata)) {
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
    exchangeError = error instanceof Error ? error : new Error(String(error));
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
      !sameInode(partialMetadata, publishedFinalMetadata) ||
      !displacedFinalMetadata.isFile() ||
      displacedFinalMetadata.isSymbolicLink() ||
      !sameInode(expectedFinal, displacedFinalMetadata)
    ) {
      displacedFinalError = new Error(
        "Encode output changed during atomic replacement",
      );
    }
  } catch (error) {
    displacedFinalError =
      error instanceof Error ? error : new Error(String(error));
  }
  if (exchangeError !== null && displacedFinalError !== null) {
    const exchangeDidNotOccur =
      publishedFinalMetadata !== null &&
      displacedFinalMetadata !== null &&
      sameInode(expectedFinal, publishedFinalMetadata) &&
      sameInode(partialMetadata, displacedFinalMetadata);
    if (exchangeDidNotOccur) {
      throw exchangeError;
    }
    throw new PendingPublicationRecoveryError(
      `${exchangeError.message}; atomic exchange endpoints require reconciliation`,
    );
  }
  if (displacedFinalError !== null) {
    const canRestoreDisplacedFinal =
      publishedFinalMetadata !== null &&
      sameInode(partialMetadata, publishedFinalMetadata) &&
      displacedFinalMetadata !== null &&
      displacedFinalMetadata.isFile() &&
      !displacedFinalMetadata.isSymbolicLink();
    if (!canRestoreDisplacedFinal) {
      throw new PendingPublicationRecoveryError(
        `${displacedFinalError.message}; atomic exchange endpoints changed before inspection`,
      );
    }
    try {
      exchangePathsAtMutationBoundary(
        atomicPathExchange,
        replacementPath,
        finalPath,
      );
      syncPathAtMutationBoundary(dirname(finalPath));
    } catch (rollbackError) {
      throw new PendingPublicationRecoveryError(
        `${displacedFinalError.message}; atomic exchange rollback requires reconciliation: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
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
    sameInode(expectedMetadata, metadata)
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

function sameFile(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

function sameInode(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
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
      sameFile(finalMetadata, partialMetadata)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function fileIdentity(metadata: Stats): string {
  return JSON.stringify([
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.birthtimeMs,
    metadata.mtimeMs,
  ]);
}

async function quarantinePartial(
  partialPath: string,
  runner: HandBrakeRunner,
  log: (message: string) => void,
  onQuarantined?: () => unknown | Promise<unknown>,
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
      .catch((error: unknown) => {
        log(
          `Encode partial cleanup after HandBrake close failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
  return null;
}

async function reconcilePendingPublications(
  cleanups: readonly EncodeJobPartialCleanup[],
  options: PollEncodeWorkerOptions & {
    atomicPathExchange: AtomicPathExchange;
    runner: HandBrakeRunner;
  },
): Promise<void> {
  if (cleanups.length === 0) {
    return;
  }
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const cleanup of cleanups) {
    try {
      let authorizedCleanup = cleanup;
      const { finalPath, partialPath, priorFinalPath, replacementPath } =
        await requireOutputPaths(
          mediaRoot,
          cleanup.outputPath,
          cleanup.claimToken,
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
      for (const metadata of [
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
      const finalMatchesPartial =
        finalMetadata !== null &&
        partialMetadata !== null &&
        partialMetadata.size > 0 &&
        sameFile(finalMetadata, partialMetadata);
      if (
        finalMatchesPartial &&
        replacementMetadata !== null &&
        partialMetadata !== null &&
        !sameInode(partialMetadata, replacementMetadata) &&
        (priorFinalMetadata === null ||
          !sameInode(priorFinalMetadata, replacementMetadata))
      ) {
        let displacedFinalRestored = false;
        try {
          options.access.encodeJobs.completePublishedPartial(cleanup, () => {
            const currentFinalMetadata = lstatSync(finalPath);
            const currentReplacementMetadata = lstatSync(replacementPath);
            if (
              !sameFile(finalMetadata, currentFinalMetadata) ||
              !sameFile(replacementMetadata, currentReplacementMetadata)
            ) {
              return false;
            }
            exchangePathsAtMutationBoundary(
              options.atomicPathExchange,
              replacementPath,
              finalPath,
            );
            const restoredFinalMetadata = lstatSync(finalPath);
            const stagedWorkerMetadata = lstatSync(replacementPath);
            if (
              !sameInode(replacementMetadata, restoredFinalMetadata) ||
              !sameInode(finalMetadata, stagedWorkerMetadata)
            ) {
              throw new PendingPublicationRecoveryError(
                "Displaced Encode output exchange requires reconciliation",
              );
            }
            syncPathAtMutationBoundary(dirname(finalPath));
            displacedFinalRestored = true;
            return false;
          });
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
          () => options.access.encodeJobs.completePartialCleanup(cleanup),
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
          options.access.encodeJobs.completePublishedPartial(
            cleanup,
            () => publicationMatches(finalPath, partialPath),
          );
        } else {
          const rollbackPath = `${finalPath}.failed.${randomUUID()}`;
          authorizedCleanup =
            options.access.encodeJobs.withPartialCleanupMutationFence(
              cleanup,
              () => {
                moveAsideAtMutationBoundary(
                  finalPath,
                  rollbackPath,
                  finalMetadata,
                );
              },
            );
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
      if (finalMetadata === null && priorFinalMetadata !== null) {
        await restoreMovedAsideOutput(priorFinalPath, finalPath);
      }
      await quarantinePartial(
        partialPath,
        options.runner,
        options.log,
        () => options.access.encodeJobs.completePartialCleanup(cleanup),
      );
    } catch (error) {
      options.log(
        `Pending Encode publication could not be reconciled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
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
  if (selection.kind === "main_feature") {
    return ["--main-feature"];
  }
  if (selection.kind === "dvd_title") {
    return ["--title", String(selection.titleNumber)];
  }
  return [
    "--title",
    String(selection.titleNumber),
    "--chapters",
    `${selection.chapterStart}-${selection.chapterEnd}`,
  ];
}

function progressFromSegment(segment: string): EncodeJobProgress | null {
  const encoding =
    /Encoding:\s+task\s+\d+\s+of\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%/.exec(
      segment,
    );
  if (encoding) {
    const eta = /ETA\s+([0-9]+)h([0-9]+)m([0-9]+)s/.exec(segment);
    return {
      phase: "encoding",
      progressPercent: Math.min(100, Math.floor(Number(encoding[1]))),
      etaSeconds: eta
        ? Number(eta[1]) * 3_600 + Number(eta[2]) * 60 + Number(eta[3])
        : null,
    };
  }
  const preview =
    /Scanning title\s+\d+\s+of\s+\d+,\s+preview\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%/.exec(
      segment,
    );
  if (preview) {
    return {
      phase: "previewing",
      progressPercent: Math.min(100, Math.floor(Number(preview[1]))),
      etaSeconds: null,
    };
  }
  const scanning =
    /Scanning title\s+\d+\s+of\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%/.exec(
      segment,
    );
  return scanning
    ? {
        phase: "scanning",
        progressPercent: Math.min(100, Math.floor(Number(scanning[1]))),
        etaSeconds: null,
      }
    : null;
}

function createProgressParser(onProgress: (progress: EncodeJobProgress) => void) {
  let buffer = "";
  return (text: string, flush = false) => {
    buffer = `${buffer}${text}`.slice(-MAX_DIAGNOSTIC_BYTES);
    const segments = buffer.split(/[\r\n]/);
    buffer = flush ? "" : (segments.pop() ?? "");
    for (const segment of segments) {
      const progress = progressFromSegment(segment);
      if (progress) {
        onProgress(progress);
      }
    }
    if (flush && buffer.trim() !== "") {
      const progress = progressFromSegment(buffer);
      if (progress) {
        onProgress(progress);
      }
      buffer = "";
    }
  };
}

function resolveClaimInput(access: DataAccess, claim: RunningEncodeJob) {
  return access.readConsistentSnapshot((snapshot) => {
    const selection = snapshot.catalog.listDiscSelections({
      ids: [claim.discSelectionId],
      encodeEligibleOnly: true,
    })[0];
    if (!selection) {
      throw new Error("Encode Job Disc Selection is unavailable");
    }
    const archive = snapshot.catalog.listOriginalDiscArchives({
      ids: [selection.originalDiscArchiveId],
    })[0];
    if (!archive || archive.discKind !== "dvd" || archive.archiveFormat !== "iso") {
      throw new Error("Encode Job requires a DVD ISO Original Disc Archive");
    }
    const profile = snapshot.encodingProfiles.list({
      ids: [claim.encodingProfileId],
    })[0];
    const preset = profile?.settings.preset;
    if (
      !profile ||
      profile.mediaDomain !== "dvd_video" ||
      typeof preset !== "string" ||
      preset.trim() === "" ||
      (profile.settings.container !== undefined &&
        profile.settings.container !== "mkv")
    ) {
      throw new Error("Encode Job has invalid DVD video profile settings");
    }
    return { archive, preset: preset.trim(), selection };
  });
}

async function executeClaim(
  claim: RunningEncodeJob,
  options: PollEncodeWorkerOptions & {
    atomicPathExchange: AtomicPathExchange;
    runner: HandBrakeRunner;
  },
): Promise<void> {
  const claimController = new AbortController();
  const signal = AbortSignal.any([options.signal, claimController.signal]);
  const heartbeat = setInterval(() => {
    try {
      options.access.encodeJobs.renewClaim(claim);
    } catch (error) {
      claimController.abort(error);
    }
  }, Math.floor(ENCODE_JOB_LEASE_DURATION_MS / 3));
  heartbeat.unref();
  let finalPath: string | undefined;
  let partialPath: string | undefined;
  let replacementPath: string | undefined;
  let replaceableFinal: Stats | undefined;
  let priorFinalFailedPath: string | null = null;
  let priorFinalRestored = false;
  let publishedOutputMetadata: Stats | undefined;
  let pendingPartialCleanup: EncodeJobPartialCleanup | undefined;
  let published = false;
  try {
    const input = resolveClaimInput(options.access, claim);
    const originalsRoot = await requireLibraryRoot(
      options.originalsLibraryPath,
      { create: false },
    );
    const mediaRoot = await requireLibraryRoot(
      options.mediaLibraryPath,
      { create: true },
    );
    const sourcePath = await requireSourcePath(
      originalsRoot,
      input.archive.archivePath,
    );
    const paths = await requireOutputPaths(
      mediaRoot,
      claim.outputPath,
      claim.claimToken,
    );
    finalPath = paths.finalPath;
    partialPath = paths.partialPath;
    replacementPath = paths.replacementPath;
    const existingFinal = await optionalMetadata(finalPath);
    if (
      existingFinal !== null &&
      (!existingFinal.isFile() || existingFinal.isSymbolicLink())
    ) {
      throw new Error("Encode Job final output is not a regular file");
    }
    if (existingFinal !== null && !claim.replaceExistingOutput) {
      throw new Error("Encode Job final output already exists");
    }
    if (existingFinal !== null && claim.replaceExistingOutput) {
      const identity = fileIdentity(existingFinal);
      if (claim.replacementOutputIdentity === null) {
        options.access.encodeJobs.recordReplacementOutputIdentity(
          claim,
          identity,
        );
      } else if (claim.replacementOutputIdentity !== identity) {
        throw new Error("Encode Job prior final output changed before retry");
      }
    }
    replaceableFinal = existingFinal ?? undefined;
    await moveAside(paths.legacyPartialPath);
    await moveStalePartials(finalPath, options.runner);
    const parseProgress = createProgressParser((progress) => {
      options.access.encodeJobs.updateProgress(claim, progress);
    });
    const arguments_ = [
      ...buildSelectionArguments(input.selection),
      "-i",
      sourcePath,
      "-o",
      partialPath,
      "--format",
      "av_mkv",
      "--preset",
      input.preset,
    ];
    await options.runner.run({
      arguments_,
      onOutput: parseProgress,
      outputPath: partialPath,
      signal,
    });
    parseProgress("", true);
    signal.throwIfAborted();
    const partialMetadata = await lstat(partialPath);
    if (
      !partialMetadata.isFile() ||
      partialMetadata.isSymbolicLink() ||
      partialMetadata.size <= 0
    ) {
      throw new Error("HandBrake did not produce a complete regular output file");
    }
    await syncPath(partialPath);
    publishedOutputMetadata = partialMetadata;
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
      !sameFile(replaceableFinal, currentFinal)
    ) {
      throw new Error("Encode Job final output changed during encoding");
    }
    options.access.encodeJobs.renewClaim(claim);
    signal.throwIfAborted();
    options.access.encodeJobs.withClaimMutationFence(claim, () => {
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
        );
      } else {
        linkSync(paths.partialPath, paths.finalPath);
        published = true;
      }
    });
    await syncPath(dirname(finalPath));
    let publicationChangedBeforeCompletion = false;
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
      );
    } catch (error) {
      if (publicationChangedBeforeCompletion) {
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
      options.log(
        `Completed Encode publication cleanup failed: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      );
    }
  } catch (error) {
    if (error instanceof PendingPublicationRecoveryError) {
      options.log(
        `Encode publication mutation requires reconciliation: ${error.message}`,
      );
      return;
    }
    const cleanupFailures: string[] = [];
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
            authorityError instanceof Error
              ? authorityError.message
              : String(authorityError)
          }`,
        );
        if (options.signal.aborted) {
          throw error;
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
          fileIdentity(replaceableFinal) === fileIdentity(currentFinal)
        ) {
          preserveReplacementAuthority = true;
        }
      } catch (cleanupError) {
        cleanupFailures.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
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
        cleanupFailures.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
    }
    if (published && finalPath !== undefined) {
      try {
        const rollbackFinalPath = finalPath;
        let rolledBack = false;
        options.access.encodeJobs.withClaimMutationFence(claim, () => {
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
            sameInode(publishedOutputMetadata, currentFinal)
          ) {
            moveAsideAtMutationBoundary(
              rollbackFinalPath,
              `${rollbackFinalPath}.failed.${randomUUID()}`,
              currentFinal,
            );
            rolledBack = true;
          }
        });
        if (rolledBack) {
          await syncPath(dirname(finalPath));
        }
      } catch (cleanupError) {
        cleanupFailures.push(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
      if (priorFinalFailedPath !== null) {
        try {
          await restoreMovedAsideOutput(priorFinalFailedPath, finalPath);
          preserveReplacementAuthority = true;
        } catch (cleanupError) {
          cleanupFailures.push(
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
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
          cleanupFailures.push(
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        }
      } else if (pendingPartialCleanup === undefined) {
        try {
          await quarantinePartial(partialPath, options.runner, options.log);
        } catch (cleanupError) {
          cleanupFailures.push(
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        }
      }
    }
    const failureMessage = signal.aborted
      ? "Encode interrupted"
      : error instanceof Error
        ? error.message
        : String(error);
    const message = `${failureMessage}${
      cleanupFailures.length > 0
        ? `; cleanup failed: ${cleanupFailures.join("; ")}`
        : ""
    }`.slice(0, 500);
    try {
      options.access.encodeJobs.fail(claim, message, {
        preserveReplacementAuthority,
      });
    } catch (failureError) {
      const failureMessage =
        failureError instanceof Error
          ? failureError.message
          : String(failureError);
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
        );
      } catch (cleanupError) {
        options.log(
          `Deferred Encode partial cleanup could not start: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    }
    if (options.signal.aborted) {
      throw error;
    }
    options.log(`Encode Job ${claim.id} failed: ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function pollEncodeWorker(
  options: PollEncodeWorkerOptions,
): Promise<void> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("Encode worker concurrency is invalid");
  }
  const runner = options.runner ?? nodeHandBrakeRunner;
  const atomicPathExchange =
    options.atomicPathExchange ?? nodeAtomicPathExchange;
  options.access.encodeJobs.recoverExpiredClaims();
  await reconcilePendingPublications(
    options.access.encodeJobs.listPendingPartialCleanups(),
    { ...options, atomicPathExchange, runner },
  );
  const runSlot = async () => {
    while (!options.signal.aborted) {
      const claim = options.access.encodeJobs.claimNext(
        options.workerId ?? "encode-worker",
      );
      if (!claim) {
        return;
      }
      await executeClaim(claim, { ...options, atomicPathExchange, runner });
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: options.concurrency }, () => runSlot()),
  );
  options.signal.throwIfAborted();
  const failedSlot = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedSlot) {
    throw failedSlot.reason;
  }
}

async function waitForNextPoll(
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(intervalMs, undefined, { signal });
}

export async function runEncodeWorker({
  pollIntervalMs,
  waitForNextPoll: wait = waitForNextPoll,
  ...pollOptions
}: RunEncodeWorkerOptions): Promise<void> {
  while (!pollOptions.signal.aborted) {
    try {
      await pollEncodeWorker(pollOptions);
    } catch (error) {
      if (pollOptions.signal.aborted) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      pollOptions.log(`Encode worker poll failed: ${message}`);
    }
    if (pollOptions.signal.aborted) {
      break;
    }
    try {
      await wait(pollIntervalMs, pollOptions.signal);
    } catch (error) {
      if (!pollOptions.signal.aborted) {
        throw error;
      }
    }
  }
}
