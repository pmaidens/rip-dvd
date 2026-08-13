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

import {
  ENCODE_JOB_LEASE_DURATION_MS,
  type DataAccess,
  type DiscSelection,
  type EncodeJobPartialCleanup,
  type PublicationMutationRecoveryLock,
  type RunningEncodeJob,
} from "@rip-dvd/data-access";

import {
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  sameEncodeOutputAuthoritySnapshot,
  sameEncodeOutputInode,
  sameEncodeOutputMutationSnapshot,
} from "./encode-output-filesystem-identity.js";
import type { HandBrakeRunner } from "./handbrake-runner.js";
import { normalizeErrorMessage } from "./normalize-error-message.js";
import { createProgressParser } from "./progress-parser.js";

const MAX_PATH_BYTES = 4_096;
const ATOMIC_EXCHANGE_PATH = fileURLToPath(
  new URL("../dist/rip-dvd-atomic-exchange.node", import.meta.url),
);

class PendingPublicationRecoveryError extends Error {}
class EncodeCancellationRequestedError extends Error {}

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

function syncPathAtMutationBoundary(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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
): Promise<void> {
  if (cleanups.length === 0) {
    return;
  }
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const cleanup of cleanups) {
    let mutationLockHandle: number | null = null;
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
      options.log(
        `Pending Encode publication could not be reconciled: ${
          normalizeErrorMessage(error)
        }`,
      );
    } finally {
      if (mutationLockHandle !== null) {
        options.mutationLock.release(mutationLockHandle);
      }
    }
  }
}

async function recoverAbandonedPublicationMutations(
  options: EncodePublicationOptions,
): Promise<void> {
  const mutations =
    options.access.encodeJobs.listExpiredPublicationMutations();
  if (mutations.length === 0) {
    return;
  }
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
        continue;
      }
      try {
        options.access.encodeJobs.recoverExpiredPublicationMutation(
          mutation,
        );
      } finally {
        options.mutationLock.release(handle);
      }
    } catch (error) {
      options.log(
        `Encode publication mutation could not be recovered: ${
          normalizeErrorMessage(error)
        }`,
      );
    }
  }
}

async function recoverAbandonedCancellations(
  options: EncodePublicationOptions,
): Promise<void> {
  const claims = options.access.encodeJobs.listExpiredCancellationClaims();
  if (claims.length === 0) {
    return;
  }
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
      options.log(
        `Encode Job ${claim.id} cancellation recovery is waiting for process closure: ${
          normalizeErrorMessage(error)
        }`,
      );
    } finally {
      if (mutationLockHandle !== null) {
        options.mutationLock.release(mutationLockHandle);
      }
    }
  }
}

async function reconcileActivePublicationMutations(
  options: EncodePublicationOptions,
): Promise<void> {
  const mutations = options.access.encodeJobs.listPublicationMutations();
  if (mutations.length === 0) {
    return;
  }
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
      options.log(
        `Active Encode publication mutation could not be reconciled: ${
          normalizeErrorMessage(error)
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
    cleanupQuarantinePath = paths.cleanupQuarantinePath;
    mutationLockHandle = options.mutationLock.tryAcquire(
      paths.mutationLockPath,
    );
    if (mutationLockHandle === null) {
      throw new Error("Encode output ownership is already active");
    }
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
      const identity = encodeOutputFilesystemIdentity(existingFinal);
      if (
        claim.replacementOutputIdentity !== null &&
        !matchesEncodeOutputFilesystemIdentity(
          claim.replacementOutputIdentity,
          existingFinal,
        )
      ) {
        throw new Error("Encode Job prior final output changed before retry");
      }
      options.access.encodeJobs.recordReplacementOutputIdentity(
        claim,
        identity,
      );
    }
    replaceableFinal = existingFinal ?? undefined;
    await moveAside(paths.legacyPartialPath);
    await moveStalePartials(finalPath, options.runner);
    const parseProgress = createProgressParser((progress) => {
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
    renewClaim();
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
      !sameEncodeOutputMutationSnapshot(replaceableFinal, currentFinal)
    ) {
      throw new Error("Encode Job final output changed during encoding");
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
      );
    } else {
      linkSync(paths.partialPath, paths.finalPath);
      published = true;
    }
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
          normalizeErrorMessage(cleanupError)
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
          sameEncodeOutputAuthoritySnapshot(
            replaceableFinal,
            currentFinal,
          )
        ) {
          preserveReplacementAuthority = true;
        }
      } catch (cleanupError) {
        cleanupFailures.push(normalizeErrorMessage(cleanupError));
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
        cleanupFailures.push(normalizeErrorMessage(cleanupError));
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
        cleanupFailures.push(normalizeErrorMessage(cleanupError));
      }
      if (priorFinalFailedPath !== null) {
        try {
          await restoreMovedAsideOutput(priorFinalFailedPath, finalPath);
          preserveReplacementAuthority = true;
        } catch (cleanupError) {
          cleanupFailures.push(normalizeErrorMessage(cleanupError));
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
          cleanupFailures.push(normalizeErrorMessage(cleanupError));
        }
      } else if (pendingPartialCleanup === undefined) {
        try {
          await quarantinePartial(partialPath, options.runner, options.log);
        } catch (cleanupError) {
          cleanupFailures.push(normalizeErrorMessage(cleanupError));
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
          cleanupFailures.push(normalizeErrorMessage(cleanupError));
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
        );
      } catch (cleanupError) {
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
  await reconcileActivePublicationMutations(options);
  await recoverAbandonedPublicationMutations(options);
  options.access.encodeJobs.recoverExpiredClaims();
  await recoverAbandonedCancellations(options);
  await reconcilePendingPublications(
    options.access.encodeJobs.listPendingPartialCleanups(),
    options,
  );
}
