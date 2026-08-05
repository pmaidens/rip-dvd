import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  type Stats,
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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

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
  await mkdir(outputDirectory, { recursive: true, mode: 0o750 });
  const canonicalOutputDirectory = await realpath(outputDirectory);
  if (!isContained(mediaLibraryPath, canonicalOutputDirectory)) {
    throw new Error("Encode Job output directory escaped the media library");
  }
  const finalPath = join(canonicalOutputDirectory, basename(resolvedOutput));
  const safeToken = claimToken.replaceAll(/[^a-zA-Z0-9-]/g, "");
  if (safeToken.length === 0 || safeToken !== claimToken) {
    throw new Error("Encode Job claim token is unsafe");
  }
  const partialPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.${safeToken}.rip-dvd-partial`,
  );
  const legacyPartialPath = join(
    canonicalOutputDirectory,
    `.${basename(finalPath)}.rip-dvd-partial`,
  );
  const priorFinalPath = `${finalPath}.failed.${safeToken}`;
  for (const path of [
    finalPath,
    partialPath,
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
  return { finalPath, legacyPartialPath, partialPath, priorFinalPath };
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
): Promise<string | null> {
  const metadata = await optionalMetadata(path);
  if (metadata === null) {
    return null;
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
  await rename(path, failedPath);
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

function fileIdentity(metadata: Stats): string {
  return JSON.stringify([
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.birthtimeMs,
    metadata.mtimeMs,
    metadata.ctimeMs,
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
  options: PollEncodeWorkerOptions & { runner: HandBrakeRunner },
): Promise<void> {
  if (cleanups.length === 0) {
    return;
  }
  const mediaRoot = await requireLibraryRoot(options.mediaLibraryPath, {
    create: true,
  });
  for (const cleanup of cleanups) {
    try {
      const { finalPath, partialPath, priorFinalPath } = await requireOutputPaths(
        mediaRoot,
        cleanup.outputPath,
        cleanup.claimToken,
      );
      const [finalMetadata, partialMetadata, priorFinalMetadata] =
        await Promise.all([
          optionalMetadata(finalPath),
          optionalMetadata(partialPath),
          optionalMetadata(priorFinalPath),
        ]);
      for (const metadata of [
        finalMetadata,
        partialMetadata,
        priorFinalMetadata,
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
      if (finalMatchesPartial) {
        if (cleanup.publicationPending) {
          options.access.encodeJobs.completePublishedPartial(cleanup);
        } else {
          await moveAside(finalPath);
          if (priorFinalMetadata !== null) {
            await restoreMovedAsideOutput(priorFinalPath, finalPath);
          }
        }
        await unlink(partialPath);
        await syncPath(dirname(finalPath));
        options.access.encodeJobs.completePartialCleanup(cleanup);
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
  options: PollEncodeWorkerOptions & { runner: HandBrakeRunner },
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
  let replaceableFinal: Stats | undefined;
  let priorFinalFailedPath: string | null = null;
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
    if (replaceableFinal !== undefined) {
      const currentFinal = await optionalMetadata(finalPath);
      if (currentFinal !== null) {
        if (!sameFile(replaceableFinal, currentFinal)) {
          throw new Error("Encode Job final output changed during encoding");
        }
        priorFinalFailedPath = await moveAside(
          finalPath,
          paths.priorFinalPath,
        );
      }
    }
    try {
      await link(partialPath, finalPath);
    } catch (publishError) {
      if (priorFinalFailedPath !== null) {
        try {
          await restoreMovedAsideOutput(priorFinalFailedPath, finalPath);
        } catch (restoreError) {
          options.log(
            `Prior Encode Job output could not be restored: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
          );
        }
      }
      throw publishError;
    }
    published = true;
    await syncPath(dirname(finalPath));
    options.access.encodeJobs.complete(claim);
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
    const cleanupFailures: string[] = [];
    let preserveReplacementAuthority = false;
    if (
      !published &&
      finalPath !== undefined &&
      replaceableFinal !== undefined
    ) {
      try {
        const currentFinal = await optionalMetadata(finalPath);
        if (
          currentFinal !== null &&
          sameFile(replaceableFinal, currentFinal)
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
    if (published && finalPath !== undefined) {
      try {
        const currentFinal = await optionalMetadata(finalPath);
        if (
          currentFinal !== null &&
          publishedOutputMetadata !== undefined &&
          sameInode(publishedOutputMetadata, currentFinal)
        ) {
          await moveAside(finalPath);
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
    if (partialPath !== undefined && pendingPartialCleanup !== undefined) {
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
  options.access.encodeJobs.recoverExpiredClaims();
  await reconcilePendingPublications(
    options.access.encodeJobs.listPendingPartialCleanups(),
    { ...options, runner },
  );
  const runSlot = async () => {
    while (!options.signal.aborted) {
      const claim = options.access.encodeJobs.claimNext(
        options.workerId ?? "encode-worker",
      );
      if (!claim) {
        return;
      }
      await executeClaim(claim, { ...options, runner });
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
