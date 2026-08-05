import {
  spawn as spawnProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  ENCODE_JOB_LEASE_DURATION_MS,
  type DataAccess,
} from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNodeHandBrakeRunner,
  pollEncodeWorker,
  type HandBrakeRunner,
} from "./encode-worker.js";

const quarantineRace = vi.hoisted(() => ({
  armed: false,
  competingPath: "",
  finalPath: "",
  observed: [] as string[],
  raced: false,
}));

const preQuarantineRace = vi.hoisted(() => ({
  armed: false,
  competingPath: "",
  finalPath: "",
  finalReads: 0,
  raced: false,
}));

const publicationRace = vi.hoisted(() => ({
  armed: false,
  finalPath: "",
  linked: false,
  paused: false,
  reached: undefined as (() => void) | undefined,
  resume: undefined as (() => void) | undefined,
}));

const replacementLinkFailure = vi.hoisted(() => ({
  armed: false,
  finalPath: "",
  failed: false,
}));

const cleanupRollbackRace = vi.hoisted(() => ({
  armed: false,
  paused: false,
  priorFinalPath: "",
  reached: undefined as (() => void) | undefined,
  resume: undefined as (() => void) | undefined,
}));

const staleCleanupRenameCrash = vi.hoisted(() => ({
  armed: false,
  finalPath: "",
  triggered: false,
}));

const matchingCompletionRace = vi.hoisted(() => ({
  armed: false,
  competingPath: "",
  finalPath: "",
  raced: false,
}));

const recoveryDirectorySyncFailure = vi.hoisted(() => ({
  armed: false,
  finalPath: "",
  triggered: false,
}));

const postLinkCommitFailure = vi.hoisted(() => ({
  armed: false,
  finalPath: "",
  linked: false,
  triggered: false,
}));

const lateCutoverRace = vi.hoisted(() => ({
  armed: false,
  competingPath: "",
  finalPath: "",
  raced: false,
  replacementPath: "",
}));

const stagedDirectoryDurability = vi.hoisted(() => ({
  armed: false,
  directoryDescriptors: new Set<number>(),
  failNextSync: false,
  finalPath: "",
  observations: [] as Array<{
    final: string;
    priorExists: boolean;
    replacementExists: boolean;
  }>,
  priorPath: "",
  replacementPath: "",
  triggered: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...arguments_: unknown[]) => {
      const paths = arguments_[1];
      if (
        lateCutoverRace.armed &&
        !lateCutoverRace.raced &&
        Array.isArray(paths) &&
        paths[0] === lateCutoverRace.replacementPath &&
        paths[1] === lateCutoverRace.finalPath
      ) {
        renameSync(
          lateCutoverRace.competingPath,
          lateCutoverRace.finalPath,
        );
        lateCutoverRace.raced = true;
      }
      const result = Reflect.apply(actual.spawnSync, actual, arguments_);
      if (Array.isArray(paths) && result.status === 0) {
        if (paths[1] === postLinkCommitFailure.finalPath) {
          postLinkCommitFailure.linked = true;
        }
        if (paths[1] === publicationRace.finalPath) {
          publicationRace.linked = true;
        }
      }
      return result;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (descriptor: number) => {
      stagedDirectoryDurability.directoryDescriptors.delete(descriptor);
      actual.closeSync(descriptor);
    },
    fsyncSync: (descriptor: number) => {
      if (
        stagedDirectoryDurability.armed &&
        stagedDirectoryDurability.directoryDescriptors.has(descriptor)
      ) {
        const replacementExists = actual.existsSync(
          stagedDirectoryDurability.replacementPath,
        );
        const priorExists = actual.existsSync(
          stagedDirectoryDurability.priorPath,
        );
        stagedDirectoryDurability.observations.push({
          final: actual.readFileSync(
            stagedDirectoryDurability.finalPath,
            "utf8",
          ),
          priorExists,
          replacementExists,
        });
        if (stagedDirectoryDurability.failNextSync) {
          if (replacementExists) {
            actual.unlinkSync(stagedDirectoryDurability.replacementPath);
          }
          if (priorExists) {
            actual.unlinkSync(stagedDirectoryDurability.priorPath);
          }
          stagedDirectoryDurability.failNextSync = false;
          stagedDirectoryDurability.triggered = true;
          throw Object.assign(
            new Error("simulated staged directory durability loss"),
            { code: "EIO" },
          );
        }
      }
      actual.fsyncSync(descriptor);
    },
    lstatSync: (path: string) => {
      if (preQuarantineRace.armed && path === preQuarantineRace.finalPath) {
        preQuarantineRace.finalReads += 1;
        if (
          !preQuarantineRace.raced &&
          preQuarantineRace.finalReads === 2
        ) {
          actual.renameSync(
            preQuarantineRace.competingPath,
            preQuarantineRace.finalPath,
          );
          preQuarantineRace.raced = true;
        }
      }
      return actual.lstatSync(path);
    },
    linkSync: (sourcePath: string, destinationPath: string) => {
      if (
        replacementLinkFailure.armed &&
        !replacementLinkFailure.failed &&
        dirname(destinationPath) ===
          dirname(replacementLinkFailure.finalPath) &&
        sourcePath.endsWith(".rip-dvd-partial")
      ) {
        replacementLinkFailure.failed = true;
        throw Object.assign(new Error("simulated replacement link failure"), {
          code: "EIO",
        });
      }
      actual.linkSync(sourcePath, destinationPath);
      if (
        quarantineRace.armed &&
        !quarantineRace.raced &&
        sourcePath === quarantineRace.finalPath &&
        destinationPath.startsWith(`${quarantineRace.finalPath}.failed.`)
      ) {
        quarantineRace.observed.push(
          `${sourcePath} -> ${destinationPath}`,
        );
        actual.renameSync(
          quarantineRace.competingPath,
          quarantineRace.finalPath,
        );
        quarantineRace.raced = true;
      }
      if (
        postLinkCommitFailure.armed &&
        destinationPath === postLinkCommitFailure.finalPath
      ) {
        postLinkCommitFailure.linked = true;
      }
      if (
        publicationRace.armed &&
        destinationPath === publicationRace.finalPath
      ) {
        publicationRace.linked = true;
      }
    },
    openSync: (path: string, flags: number) => {
      const descriptor = actual.openSync(path, flags);
      if (
        stagedDirectoryDurability.armed &&
        path === dirname(stagedDirectoryDurability.finalPath)
      ) {
        stagedDirectoryDurability.directoryDescriptors.add(descriptor);
      }
      return descriptor;
    },
    renameSync: (sourcePath: string, destinationPath: string) => {
      if (
        lateCutoverRace.armed &&
        !lateCutoverRace.raced &&
        sourcePath === lateCutoverRace.replacementPath &&
        destinationPath === lateCutoverRace.finalPath
      ) {
        actual.renameSync(
          lateCutoverRace.competingPath,
          lateCutoverRace.finalPath,
        );
        lateCutoverRace.raced = true;
      }
      actual.renameSync(sourcePath, destinationPath);
      if (
        sourcePath.endsWith(".rip-dvd-publish") &&
        postLinkCommitFailure.armed &&
        destinationPath === postLinkCommitFailure.finalPath
      ) {
        postLinkCommitFailure.linked = true;
      }
      if (
        sourcePath.endsWith(".rip-dvd-publish") &&
        publicationRace.armed &&
        destinationPath === publicationRace.finalPath
      ) {
        publicationRace.linked = true;
      }
      quarantineRace.observed.push(`${sourcePath} -> ${destinationPath}`);
      if (
        quarantineRace.armed &&
        !quarantineRace.raced &&
        sourcePath === quarantineRace.finalPath &&
        destinationPath.startsWith(`${quarantineRace.finalPath}.failed`)
      ) {
        actual.renameSync(
          quarantineRace.competingPath,
          quarantineRace.finalPath,
        );
        quarantineRace.raced = true;
      }
      if (
        staleCleanupRenameCrash.armed &&
        sourcePath === staleCleanupRenameCrash.finalPath &&
        destinationPath.startsWith(`${staleCleanupRenameCrash.finalPath}.failed`)
      ) {
        staleCleanupRenameCrash.triggered = true;
        throw new Error("simulated stale cleanup crash after rename");
      }
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const publishCompetitorAfterQuarantine = async (
    sourcePath: string,
    quarantinePath: string,
  ) => {
    quarantineRace.observed.push(`${sourcePath} -> ${quarantinePath}`);
    if (
      quarantineRace.armed &&
      !quarantineRace.raced &&
      sourcePath === quarantineRace.finalPath &&
      quarantinePath.startsWith(`${quarantineRace.finalPath}.failed`)
    ) {
      await actual.rename(
        quarantineRace.competingPath,
        quarantineRace.finalPath,
      );
      quarantineRace.raced = true;
    }
  };
  return {
    ...actual,
    open: async (path: string, flags: number) => {
      const recoveryFinalDirectory = recoveryDirectorySyncFailure.finalPath.slice(
        0,
        recoveryDirectorySyncFailure.finalPath.lastIndexOf("/"),
      );
      if (
        recoveryDirectorySyncFailure.armed &&
        !recoveryDirectorySyncFailure.triggered &&
        path === recoveryFinalDirectory
      ) {
        await actual.unlink(recoveryDirectorySyncFailure.finalPath);
        recoveryDirectorySyncFailure.triggered = true;
        throw Object.assign(
          new Error("simulated final directory sync failure"),
          { code: "EIO" },
        );
      }
      const handle = await actual.open(path, flags);
      const finalDirectory = publicationRace.finalPath.slice(
        0,
        publicationRace.finalPath.lastIndexOf("/"),
      );
      if (
        publicationRace.armed &&
        publicationRace.linked &&
        !publicationRace.paused &&
        path === finalDirectory
      ) {
        publicationRace.paused = true;
        publicationRace.reached?.();
        await new Promise<void>((resolve) => {
          publicationRace.resume = resolve;
        });
      }
      return handle;
    },
    lstat: async (path: string) => {
      if (preQuarantineRace.armed && path === preQuarantineRace.finalPath) {
        preQuarantineRace.finalReads += 1;
        if (
          !preQuarantineRace.raced &&
          preQuarantineRace.finalReads === 2
        ) {
          await actual.rename(
            preQuarantineRace.competingPath,
            preQuarantineRace.finalPath,
          );
          preQuarantineRace.raced = true;
        }
      }
      const metadata = await actual.lstat(path);
      if (
        matchingCompletionRace.armed &&
        !matchingCompletionRace.raced &&
        path === matchingCompletionRace.finalPath
      ) {
        await actual.rename(
          matchingCompletionRace.competingPath,
          matchingCompletionRace.finalPath,
        );
        matchingCompletionRace.raced = true;
      }
      if (
        cleanupRollbackRace.armed &&
        !cleanupRollbackRace.paused &&
        path === cleanupRollbackRace.priorFinalPath
      ) {
        cleanupRollbackRace.paused = true;
        cleanupRollbackRace.reached?.();
        await new Promise<void>((resolve) => {
          cleanupRollbackRace.resume = resolve;
        });
      }
      return metadata;
    },
    link: async (sourcePath: string, destinationPath: string) => {
      if (
        replacementLinkFailure.armed &&
        !replacementLinkFailure.failed &&
        destinationPath === replacementLinkFailure.finalPath &&
        sourcePath.endsWith(".rip-dvd-partial")
      ) {
        replacementLinkFailure.failed = true;
        throw Object.assign(new Error("simulated replacement link failure"), {
          code: "EIO",
        });
      }
      await actual.link(sourcePath, destinationPath);
      if (
        publicationRace.armed &&
        destinationPath === publicationRace.finalPath
      ) {
        publicationRace.reached?.();
        await new Promise<void>((resolve) => {
          publicationRace.resume = resolve;
        });
      }
      await publishCompetitorAfterQuarantine(sourcePath, destinationPath);
    },
    rename: async (sourcePath: string, destinationPath: string) => {
      await actual.rename(sourcePath, destinationPath);
      if (
        staleCleanupRenameCrash.armed &&
        sourcePath === staleCleanupRenameCrash.finalPath &&
        destinationPath.startsWith(`${staleCleanupRenameCrash.finalPath}.failed`)
      ) {
        staleCleanupRenameCrash.triggered = true;
        throw new Error("simulated stale cleanup crash after rename");
      }
      await publishCompetitorAfterQuarantine(sourcePath, destinationPath);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanupRollbackRace.resume?.();
  cleanupRollbackRace.armed = false;
  cleanupRollbackRace.paused = false;
  cleanupRollbackRace.priorFinalPath = "";
  cleanupRollbackRace.reached = undefined;
  cleanupRollbackRace.resume = undefined;
  staleCleanupRenameCrash.armed = false;
  staleCleanupRenameCrash.finalPath = "";
  staleCleanupRenameCrash.triggered = false;
  matchingCompletionRace.armed = false;
  matchingCompletionRace.competingPath = "";
  matchingCompletionRace.finalPath = "";
  matchingCompletionRace.raced = false;
  recoveryDirectorySyncFailure.armed = false;
  recoveryDirectorySyncFailure.finalPath = "";
  recoveryDirectorySyncFailure.triggered = false;
  postLinkCommitFailure.armed = false;
  postLinkCommitFailure.finalPath = "";
  postLinkCommitFailure.linked = false;
  postLinkCommitFailure.triggered = false;
  lateCutoverRace.armed = false;
  lateCutoverRace.competingPath = "";
  lateCutoverRace.finalPath = "";
  lateCutoverRace.raced = false;
  lateCutoverRace.replacementPath = "";
  stagedDirectoryDurability.armed = false;
  stagedDirectoryDurability.directoryDescriptors.clear();
  stagedDirectoryDurability.failNextSync = false;
  stagedDirectoryDurability.finalPath = "";
  stagedDirectoryDurability.observations = [];
  stagedDirectoryDurability.priorPath = "";
  stagedDirectoryDurability.replacementPath = "";
  stagedDirectoryDurability.triggered = false;
  publicationRace.resume?.();
  publicationRace.armed = false;
  publicationRace.finalPath = "";
  publicationRace.linked = false;
  publicationRace.paused = false;
  publicationRace.reached = undefined;
  publicationRace.resume = undefined;
  replacementLinkFailure.armed = false;
  replacementLinkFailure.finalPath = "";
  replacementLinkFailure.failed = false;
  preQuarantineRace.armed = false;
  preQuarantineRace.competingPath = "";
  preQuarantineRace.finalPath = "";
  preQuarantineRace.finalReads = 0;
  preQuarantineRace.raced = false;
  quarantineRace.armed = false;
  quarantineRace.competingPath = "";
  quarantineRace.finalPath = "";
  quarantineRace.observed = [];
  quarantineRace.raced = false;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

type TestSelection =
  | { kind: "main_feature" }
  | { kind: "dvd_title"; titleNumber: number }
  | {
      kind: "dvd_chapters";
      titleNumber: number;
      chapterStart: number;
      chapterEnd: number;
    };

function createQueuedJob(
  selectionInput: TestSelection = { kind: "main_feature" },
) {
  const root = mkdtempSync(join(tmpdir(), "rip-dvd-encode-worker-"));
  temporaryDirectories.push(root);
  const originalsLibraryPath = join(root, "originals");
  const mediaLibraryPath = join(root, "media");
  const sourcePath = join(originalsLibraryPath, "Example.iso");
  const outputPath = join(mediaLibraryPath, "Example.mkv");
  const databasePath = join(root, "rip-dvd.sqlite");
  const access = createLegacySidecarDataAccess({ databasePath });
  mkdirSync(originalsLibraryPath, { recursive: true });
  writeFileSync(sourcePath, "original dvd", { flag: "wx" });
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    isPresent: true,
  });
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    scanData: {
      schemaVersion: 2,
      contentId: fingerprint,
      titles: [
        {
          number: 4,
          durationSeconds: 3_600,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        },
      ],
    },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: sourcePath,
    fingerprint,
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title: "Example",
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    ...selectionInput,
  });
  access.catalog.completeCatalogReview(archive.id);
  const profile = access.encodingProfiles.create({
    key: "dvd-library",
    displayName: "DVD library",
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30", container: "mkv" },
  });
  const job = access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath,
  });
  return {
    access,
    archive,
    databasePath,
    job,
    mediaLibraryPath,
    originalsLibraryPath,
    outputPath,
    profile,
    sourcePath,
  };
}

function addQueuedJob(
  fixture: ReturnType<typeof createQueuedJob>,
  selectionInput: Exclude<TestSelection, { kind: "main_feature" }>,
  title: string,
) {
  const item = fixture.access.catalog.createMediaItem({ kind: "movie", title });
  const selection = fixture.access.catalog.createDiscSelection({
    originalDiscArchiveId: fixture.archive.id,
    mediaItemId: item.id,
    ...selectionInput,
  });
  fixture.access.catalog.completeCatalogReview(fixture.archive.id);
  return fixture.access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: fixture.profile.id,
    outputPath: join(fixture.mediaLibraryPath, `${title}.mkv`),
  });
}

function quarantinedContents(path: string): string[] {
  const prefix = `${basename(path)}.failed.`;
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix))
    .map((name) => readFileSync(join(dirname(path), name), "utf8"));
}

function claimPartialPath(outputPath: string, claimToken: string): string {
  return join(
    dirname(outputPath),
    `.${basename(outputPath)}.${claimToken}.rip-dvd-partial`,
  );
}

function claimReplacementPath(outputPath: string, claimToken: string): string {
  return join(
    dirname(outputPath),
    `.${basename(outputPath)}.${claimToken}.rip-dvd-publish`,
  );
}

function priorFinalPath(outputPath: string, claimToken: string): string {
  return `${outputPath}.failed.${claimToken}`;
}

function failPublicationFenceCommit(finalPath: string): void {
  postLinkCommitFailure.armed = true;
  postLinkCommitFailure.finalPath = finalPath;
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (
      postLinkCommitFailure.armed &&
      postLinkCommitFailure.linked &&
      !postLinkCommitFailure.triggered &&
      sql.trim().toLowerCase() === "commit"
    ) {
      return new Proxy(statement, {
        get(target, property) {
          if (property === "run") {
            return () => {
              postLinkCommitFailure.triggered = true;
              postLinkCommitFailure.armed = false;
              throw Object.assign(
                new Error("simulated publication fence COMMIT failure"),
                { code: "SQLITE_IOERR" },
              );
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as StatementSync;
    }
    return statement;
  });
}

async function waitForChildLine(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  child.stdout.setEncoding("utf8");
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new Error(
          `Child exited before ${expected}: ${String(code)} ${String(signal)}`,
        ),
      );
    };
    const onData = (chunk: string) => {
      output += chunk;
      if (output.split("\n").includes(expected)) {
        child.stdout.off("data", onData);
        child.off("error", reject);
        child.off("exit", onExit);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", onExit);
  });
}

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill("SIGKILL");
  await once(child, "exit");
}

describe("encode worker polling", () => {
  it("claims a main-feature job, persists HandBrake progress, and publishes only after success", async () => {
    const fixture = createQueuedJob();
    const observedProgress: unknown[] = [];
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ arguments_, onOutput }) => {
        const outputPath = arguments_[arguments_.indexOf("-o") + 1];
        expect(existsSync(fixture.outputPath)).toBe(false);
        onOutput(
          "Encoding: task 1 of 1, 42.50 % (128.00 fps, avg 90.00 fps, ETA 0h12m03s)\r",
        );
        observedProgress.push(fixture.access.encodeJobs.list()[0]);
        writeFileSync(outputPath!, "complete encode", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      workerId: "encode-worker-test",
    });

    expect(
      runner.run,
      JSON.stringify(fixture.access.encodeJobs.list()),
    ).toHaveBeenCalledOnce();
    const request = vi.mocked(runner.run).mock.calls[0]![0];
    expect(request.arguments_).toEqual([
      "--main-feature",
      "-i",
      realpathSync(fixture.sourcePath),
      "-o",
      request.outputPath,
      "--format",
      "av_mkv",
      "--preset",
      "Fast 480p30",
    ]);
    expect(observedProgress).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        status: "running",
        progressPhase: "encoding",
        progressPercent: 42,
        progressEtaSeconds: 723,
      }),
    ]);
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        status: "completed",
        progressPercent: 100,
      }),
    ]);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("complete encode");
    expect(existsSync(request.outputPath)).toBe(false);
    fixture.access.close();
  });

  it.each([
    {
      name: "a DVD title",
      selection: { kind: "dvd_title", titleNumber: 4 } as const,
      selectionArguments: ["--title", "4"],
    },
    {
      name: "a chapter-bounded DVD title",
      selection: {
        kind: "dvd_chapters",
        titleNumber: 4,
        chapterStart: 3,
        chapterEnd: 5,
      } as const,
      selectionArguments: ["--title", "4", "--chapters", "3-5"],
    },
  ])("builds the HandBrake command for $name", async ({
    selection,
    selectionArguments,
  }) => {
    const fixture = createQueuedJob(selection);
    const progressSnapshots: unknown[] = [];
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ arguments_, onOutput }) => {
        const outputPath = arguments_[arguments_.indexOf("-o") + 1]!;
        onOutput("Scanning title 1 of 8, 25.00 %\r");
        progressSnapshots.push(fixture.access.encodeJobs.list()[0]);
        onOutput("Scanning title 1 of 8, preview 3, 60.00 %\r");
        progressSnapshots.push(fixture.access.encodeJobs.list()[0]);
        writeFileSync(outputPath, "selected encode", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });

    const request = vi.mocked(runner.run).mock.calls[0]![0];
    expect(request.arguments_.slice(0, selectionArguments.length)).toEqual(
      selectionArguments,
    );
    expect(progressSnapshots).toEqual([
      expect.objectContaining({
        progressPhase: "scanning",
        progressPercent: 25,
        progressEtaSeconds: null,
      }),
      expect.objectContaining({
        progressPhase: "previewing",
        progressPercent: 60,
        progressEtaSeconds: null,
      }),
    ]);
    fixture.access.close();
  });

  it("moves stale and failed partials aside and retries the same logical job", async () => {
    const fixture = createQueuedJob();
    mkdirSync(dirname(fixture.outputPath), { recursive: true });
    const legacyPartialPath = join(
      dirname(fixture.outputPath),
      `.${basename(fixture.outputPath)}.rip-dvd-partial`,
    );
    writeFileSync(`${legacyPartialPath}.failed`, "earlier failure", {
      flag: "wx",
    });
    writeFileSync(legacyPartialPath, "stale partial", { flag: "wx" });
    let failedAttemptPath = "";
    const failingRunner: HandBrakeRunner = {
      run: vi.fn(async ({ arguments_, onOutput }) => {
        failedAttemptPath = arguments_[arguments_.indexOf("-o") + 1]!;
        expect(quarantinedContents(legacyPartialPath)).toContain(
          "stale partial",
        );
        expect(readFileSync(`${legacyPartialPath}.failed`, "utf8")).toBe(
          "earlier failure",
        );
        onOutput("Encoding: task 1 of 1, 18.00 %\r");
        writeFileSync(failedAttemptPath, "failed attempt", { flag: "wx" });
        throw new Error("HandBrake encoder failed");
      }),
    };

    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: failingRunner,
      signal: new AbortController().signal,
    });

    expect(existsSync(fixture.outputPath)).toBe(false);
    expect(quarantinedContents(failedAttemptPath)).toContain("failed attempt");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        status: "failed",
        progressPhase: "encoding",
        progressPercent: 18,
        progressEtaSeconds: null,
        errorMessage: "HandBrake encoder failed",
      }),
    ]);

    const requeued = fixture.access.encodeJobs.requeue(fixture.job.id);
    expect(requeued).toMatchObject({
      id: fixture.job.id,
      status: "queued",
      progressPhase: null,
      progressPercent: 0,
      progressEtaSeconds: null,
    });
    const succeedingRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, "retry complete", { flag: "wx" });
      }),
    };
    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: succeedingRunner,
      signal: new AbortController().signal,
    });

    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        status: "completed",
      }),
    ]);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("retry complete");
    expect(
      readdirSync(dirname(fixture.outputPath)).filter((name) =>
        name.endsWith(".rip-dvd-partial"),
      ),
    ).toEqual([]);
    fixture.access.close();
  });

  it("does not run one claimed job in two competing workers", async () => {
    const fixture = createQueuedJob();
    const competingAccess = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    let releaseFirstRunner!: () => void;
    const firstRunnerGate = new Promise<void>((resolve) => {
      releaseFirstRunner = resolve;
    });
    const firstRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        await firstRunnerGate;
        writeFileSync(outputPath, "single winner", { flag: "wx" });
      }),
    };
    const secondRunner: HandBrakeRunner = { run: vi.fn() };
    const firstPoll = pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: firstRunner,
      signal: new AbortController().signal,
      workerId: "encode-worker-first",
    });
    await vi.waitFor(() => expect(firstRunner.run).toHaveBeenCalledOnce());

    await pollEncodeWorker({
      access: competingAccess,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: secondRunner,
      signal: new AbortController().signal,
      workerId: "encode-worker-second",
    });

    expect(secondRunner.run).not.toHaveBeenCalled();
    expect(competingAccess.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        claimedBy: "encode-worker-first",
        status: "running",
      }),
    ]);
    releaseFirstRunner();
    await firstPoll;
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    competingAccess.close();
    fixture.access.close();
  });

  it("does not reconcile publication provenance owned by a healthy competing claim", async () => {
    const fixture = createQueuedJob();
    const competingAccess = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const claim = fixture.access.encodeJobs.claimNext("publishing-worker");
    if (!claim) {
      throw new Error("Expected the Encode Job to be claimed");
    }
    mkdirSync(dirname(fixture.outputPath), { recursive: true });
    const partialPath = claimPartialPath(
      fixture.outputPath,
      claim.claimToken,
    );
    writeFileSync(partialPath, "healthy publication in progress", {
      flag: "wx",
    });
    const cleanup = fixture.access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });

    await pollEncodeWorker({
      access: competingAccess,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: { run: vi.fn() },
      signal: new AbortController().signal,
      workerId: "observing-worker",
    });

    expect(readFileSync(partialPath, "utf8")).toBe(
      "healthy publication in progress",
    );
    expect(competingAccess.encodeJobs.listPendingPartialCleanups()).toEqual([]);
    expect(competingAccess.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        claimedBy: "publishing-worker",
        partialCleanupClaimToken: cleanup.claimToken,
        partialCleanupOutputPath: cleanup.outputPath,
        publicationPending: true,
        status: "running",
      }),
    ]);
    competingAccess.close();
    fixture.access.close();
  });

  it("refuses to start HandBrake when catalog review reopens after claim", async () => {
    const fixture = createQueuedJob();
    const claimNext = fixture.access.encodeJobs.claimNext.bind(
      fixture.access.encodeJobs,
    );
    const access: DataAccess = {
      ...fixture.access,
      encodeJobs: {
        ...fixture.access.encodeJobs,
        claimNext(workerId) {
          const claim = claimNext(workerId);
          if (claim) {
            const item = fixture.access.catalog.createMediaItem({
              kind: "movie",
              title: "Review reopened",
            });
            fixture.access.catalog.createDiscSelection({
              originalDiscArchiveId: fixture.archive.id,
              mediaItemId: item.id,
              kind: "dvd_title",
              titleNumber: 4,
            });
          }
          return claim;
        },
      },
    };
    const runner: HandBrakeRunner = { run: vi.fn() };

    await pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        status: "failed",
        errorMessage: "Encode Job Disc Selection is unavailable",
      }),
    ]);
    fixture.access.close();
  });

  it("keeps every configured encode slot busy while queued work remains", async () => {
    const fixture = createQueuedJob();
    addQueuedJob(
      fixture,
      { kind: "dvd_title", titleNumber: 4 },
      "Second encode",
    );
    addQueuedJob(
      fixture,
      {
        kind: "dvd_chapters",
        titleNumber: 4,
        chapterStart: 1,
        chapterEnd: 2,
      },
      "Third encode",
    );
    let releaseLongEncode!: () => void;
    const longEncode = new Promise<void>((resolve) => {
      releaseLongEncode = resolve;
    });
    let callCount = 0;
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        callCount += 1;
        if (callCount === 1) {
          await longEncode;
        }
        writeFileSync(outputPath, `encode ${callCount}`, { flag: "wx" });
      }),
    };

    const polling = pollEncodeWorker({
      access: fixture.access,
      concurrency: 2,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(3));
    releaseLongEncode();
    await polling;

    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    fixture.access.close();
  });

  it("never overwrites a final output that appears during encoding", async () => {
    const fixture = createQueuedJob();
    let partialPath = "";
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, "new encode", { flag: "wx" });
        writeFileSync(fixture.outputPath, "competing output", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("competing output");
    expect(quarantinedContents(partialPath)).toContain("new encode");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        status: "failed",
        errorMessage: expect.stringContaining("EEXIST"),
      }),
    ]);

    fixture.access.encodeJobs.requeue(fixture.job.id);
    const retryRunner: HandBrakeRunner = { run: vi.fn() };
    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: retryRunner,
      signal: new AbortController().signal,
    });
    expect(retryRunner.run).not.toHaveBeenCalled();
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("competing output");
    fixture.access.close();
  });

  it("preserves and replaces the prior output when a completed job is re-encoded", async () => {
    const fixture = createQueuedJob();
    const firstRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, "old encode", { flag: "wx" });
      }),
    };
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({ ...options, runner: firstRunner });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const replacementRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        expect(readFileSync(fixture.outputPath, "utf8")).toBe("old encode");
        writeFileSync(outputPath, "new encode", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({ ...options, runner: replacementRunner });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("new encode");
    expect(quarantinedContents(fixture.outputPath)).toContain("old encode");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    fixture.access.close();
  });

  it("restores the prior final when replacement publication cannot be completed in SQLite", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    vi.spyOn(fixture.access.encodeJobs, "complete").mockImplementationOnce(
      () => {
        throw new Error("database completion failed");
      },
    );

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "uncommitted replacement", { flag: "wx" });
        }),
      },
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("known good encode");
    expect(quarantinedContents(fixture.outputPath)).toContain(
      "uncommitted replacement",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        replaceExistingOutput: true,
        status: "failed",
      }),
    ]);
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const retryRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, "committed replacement", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({ ...options, runner: retryRunner });

    expect(retryRunner.run).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "committed replacement",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        replaceExistingOutput: false,
        replacementOutputIdentity: null,
        status: "completed",
      }),
    ]);
    fixture.access.close();
  });

  it("retains retry authority after restoring a failed replacement link", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    replacementLinkFailure.finalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "failed replacement", { flag: "wx" });
          replacementLinkFailure.armed = true;
        }),
      },
    });

    expect(replacementLinkFailure.failed).toBe(true);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("known good encode");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        partialCleanupOutputPath: null,
        publicationPending: false,
        replacementOutputIdentity: expect.any(String),
        replaceExistingOutput: true,
        status: "failed",
      }),
    ]);
    replacementLinkFailure.armed = false;
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const retryRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, "successful retry", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({ ...options, runner: retryRunner });

    expect(retryRunner.run).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("successful retry");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        replacementOutputIdentity: null,
        replaceExistingOutput: false,
        status: "completed",
      }),
    ]);
    fixture.access.close();
  });

  it("does not roll back a final accepted while its expired publisher is paused", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const reconcilingAccess = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    let finalLinked!: () => void;
    const finalWasLinked = new Promise<void>((resolve) => {
      finalLinked = resolve;
    });
    mkdirSync(fixture.mediaLibraryPath, { recursive: true });
    publicationRace.armed = true;
    publicationRace.finalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    publicationRace.reached = finalLinked;
    const stalePublisherAccess: DataAccess = {
      ...fixture.access,
      encodeJobs: {
        ...fixture.access.encodeJobs,
        renewClaim(claim) {
          return claim;
        },
      },
    };
    const options = {
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    const stalePoll = pollEncodeWorker({
      ...options,
      access: stalePublisherAccess,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "accepted encode", { flag: "wx" });
        }),
      },
      workerId: "paused-publisher",
    });
    await finalWasLinked;
    await vi.advanceTimersByTimeAsync(ENCODE_JOB_LEASE_DURATION_MS + 1);

    await pollEncodeWorker({
      ...options,
      access: reconcilingAccess,
      runner: { run: vi.fn() },
      workerId: "reconciling-worker",
    });
    expect(reconcilingAccess.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        publicationPending: false,
        status: "completed",
      }),
    ]);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("accepted encode");

    publicationRace.armed = false;
    publicationRace.resume?.();
    await stalePoll;

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("accepted encode");
    expect(reconcilingAccess.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    reconcilingAccess.close();
    fixture.access.close();
  });

  it("does not move a known-good final after publication provenance becomes stale", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const options = {
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      access: fixture.access,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const reconcilingAccess = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const registerPartialCleanup =
      fixture.access.encodeJobs.registerPartialCleanup.bind(
        fixture.access.encodeJobs,
      );
    const renewClaim = fixture.access.encodeJobs.renewClaim.bind(
      fixture.access.encodeJobs,
    );
    let publicationRegistered = false;
    const stalePublisherAccess: DataAccess = {
      ...fixture.access,
      encodeJobs: {
        ...fixture.access.encodeJobs,
        renewClaim(claim) {
          return publicationRegistered ? renewClaim(claim) : claim;
        },
        registerPartialCleanup(claim, cleanupOptions) {
          const cleanup = registerPartialCleanup(claim, cleanupOptions);
          vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
          expect(reconcilingAccess.encodeJobs.recoverExpiredClaims()).toEqual([
            expect.objectContaining({ id: claim.id, status: "failed" }),
          ]);
          expect(
            reconcilingAccess.encodeJobs.listPendingPartialCleanups(),
          ).toEqual([cleanup]);
          publicationRegistered = true;
          return cleanup;
        },
      },
    };

    await pollEncodeWorker({
      ...options,
      access: stalePublisherAccess,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "stale replacement", { flag: "wx" });
        }),
      },
      workerId: "stale-reencode-publisher",
    });
    await pollEncodeWorker({
      ...options,
      access: reconcilingAccess,
      runner: { run: vi.fn() },
      workerId: "reconciling-worker",
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "known good encode",
    );
    expect(reconcilingAccess.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        partialCleanupOutputPath: null,
        replaceExistingOutput: true,
        status: "failed",
      }),
    ]);
    reconcilingAccess.close();
    fixture.access.close();
  });

  it("re-fences a renewed publisher invalidated before mutation", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const reconcilingAccess = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const options = {
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      access: fixture.access,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const renewClaim = fixture.access.encodeJobs.renewClaim.bind(
      fixture.access.encodeJobs,
    );
    const withClaimMutationFence =
      fixture.access.encodeJobs.withClaimMutationFence.bind(
        fixture.access.encodeJobs,
      );
    let firstRenewalCompleted = false;
    let invalidatedBeforeFence = false;
    const stalePublisherAccess: DataAccess = {
      ...fixture.access,
      encodeJobs: {
        ...fixture.access.encodeJobs,
        renewClaim(claim) {
          if (!firstRenewalCompleted) {
            const renewed = renewClaim(claim);
            firstRenewalCompleted = true;
            return renewed;
          }
          return claim;
        },
        withClaimMutationFence(claim, mutation) {
          vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
          expect(reconcilingAccess.encodeJobs.recoverExpiredClaims()).toEqual([
            expect.objectContaining({ id: claim.id, status: "failed" }),
          ]);
          invalidatedBeforeFence = true;
          return withClaimMutationFence(claim, mutation);
        },
      },
    };

    await pollEncodeWorker({
      ...options,
      access: stalePublisherAccess,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "stale replacement", { flag: "wx" });
        }),
      },
      workerId: "renewed-stale-publisher",
    });
    expect(firstRenewalCompleted).toBe(true);
    expect(invalidatedBeforeFence).toBe(true);
    await pollEncodeWorker({
      ...options,
      access: reconcilingAccess,
      runner: { run: vi.fn() },
      workerId: "reconciling-worker",
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "known good encode",
    );
    expect(reconcilingAccess.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        replaceExistingOutput: true,
        status: "failed",
      }),
    ]);
    reconcilingAccess.close();
    fixture.access.close();
  });

  it("does not roll back a new publication from a stale cleanup snapshot", async () => {
    const fixture = createQueuedJob();
    const options = {
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      access: fixture.access,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const claim = fixture.access.encodeJobs.claimNext("revoked-publisher");
    if (!claim) {
      throw new Error("Expected the re-encode to be claimed");
    }
    const canonicalFinalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    const partialPath = claimPartialPath(
      canonicalFinalPath,
      claim.claimToken,
    );
    const knownGoodRecoveryPath = priorFinalPath(
      canonicalFinalPath,
      claim.claimToken,
    );
    writeFileSync(partialPath, "revoked replacement", { flag: "wx" });
    const publication = fixture.access.encodeJobs.registerPartialCleanup(
      claim,
      { publicationPending: true },
    );
    renameSync(canonicalFinalPath, knownGoodRecoveryPath);
    linkSync(partialPath, canonicalFinalPath);
    const revoked = fixture.access.encodeJobs.revokePublication(
      claim,
      publication,
    );
    expect(fixture.access.encodeJobs.fail(claim, "publication revoked", {
      preserveReplacementAuthority: true,
    })).toMatchObject({ status: "failed" });
    expect(revoked).toMatchObject({ publicationPending: false });

    const firstReconciler = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const secondReconciler = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    let staleSnapshotRead!: () => void;
    const staleSnapshotWasRead = new Promise<void>((resolve) => {
      staleSnapshotRead = resolve;
    });
    cleanupRollbackRace.armed = true;
    cleanupRollbackRace.priorFinalPath = knownGoodRecoveryPath;
    cleanupRollbackRace.reached = staleSnapshotRead;
    const firstPoll = pollEncodeWorker({
      ...options,
      access: firstReconciler,
      runner: { run: vi.fn() },
      workerId: "first-reconciler",
    });
    await staleSnapshotWasRead;

    await pollEncodeWorker({
      ...options,
      access: secondReconciler,
      runner: { run: vi.fn() },
      workerId: "second-reconciler",
    });
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "known good encode",
    );
    expect(secondReconciler.encodeJobs.requeue(fixture.job.id)).toMatchObject({
      status: "queued",
    });
    await pollEncodeWorker({
      ...options,
      access: secondReconciler,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "accepted retry", { flag: "wx" });
        }),
      },
      workerId: "retry-publisher",
    });
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("accepted retry");

    cleanupRollbackRace.armed = false;
    cleanupRollbackRace.resume?.();
    await firstPoll;

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("accepted retry");
    expect(secondReconciler.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    secondReconciler.close();
    firstReconciler.close();
    fixture.access.close();
  });

  it("fences an expired cleanup owner before it can rename an accepted retry", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const options = {
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      access: fixture.access,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const revokedClaim = fixture.access.encodeJobs.claimNext("revoked-publisher");
    if (!revokedClaim) {
      throw new Error("Expected the re-encode to be claimed");
    }
    const canonicalFinalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    const revokedPartialPath = claimPartialPath(
      canonicalFinalPath,
      revokedClaim.claimToken,
    );
    const knownGoodRecoveryPath = priorFinalPath(
      canonicalFinalPath,
      revokedClaim.claimToken,
    );
    writeFileSync(revokedPartialPath, "revoked replacement", { flag: "wx" });
    const publication = fixture.access.encodeJobs.registerPartialCleanup(
      revokedClaim,
      { publicationPending: true },
    );
    renameSync(canonicalFinalPath, knownGoodRecoveryPath);
    linkSync(revokedPartialPath, canonicalFinalPath);
    const revoked = fixture.access.encodeJobs.revokePublication(
      revokedClaim,
      publication,
    );
    fixture.access.encodeJobs.fail(revokedClaim, "publication revoked", {
      preserveReplacementAuthority: true,
    });

    const firstReconciler = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const secondReconciler = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const withPartialCleanupMutationFence =
      firstReconciler.encodeJobs.withPartialCleanupMutationFence.bind(
        firstReconciler.encodeJobs,
      );
    let interleavingCompleted = false;
    const staleReconcilerAccess: DataAccess = {
      ...firstReconciler,
      encodeJobs: {
        ...firstReconciler.encodeJobs,
        withPartialCleanupMutationFence(cleanup, mutation) {
          const currentCleanup =
            secondReconciler.encodeJobs.claimPartialCleanup(cleanup);
          renameSync(
            canonicalFinalPath,
            `${canonicalFinalPath}.failed.second-reconciler`,
          );
          linkSync(knownGoodRecoveryPath, canonicalFinalPath);
          rmSync(revokedPartialPath);
          secondReconciler.encodeJobs.completePartialCleanup(currentCleanup);
          secondReconciler.encodeJobs.requeue(fixture.job.id);
          const retryClaim =
            secondReconciler.encodeJobs.claimNext("accepted-retry-publisher");
          if (!retryClaim) {
            throw new Error("Expected the accepted retry to be claimed");
          }
          const retryPartialPath = claimPartialPath(
            canonicalFinalPath,
            retryClaim.claimToken,
          );
          const retryPriorPath = priorFinalPath(
            canonicalFinalPath,
            retryClaim.claimToken,
          );
          writeFileSync(retryPartialPath, "accepted retry", { flag: "wx" });
          const retryPublication =
            secondReconciler.encodeJobs.registerPartialCleanup(retryClaim, {
              publicationPending: true,
            });
          renameSync(canonicalFinalPath, retryPriorPath);
          linkSync(retryPartialPath, canonicalFinalPath);
          secondReconciler.encodeJobs.complete(retryClaim);
          rmSync(retryPartialPath);
          secondReconciler.encodeJobs.completePartialCleanup(retryPublication);
          staleCleanupRenameCrash.armed = true;
          staleCleanupRenameCrash.finalPath = canonicalFinalPath;
          interleavingCompleted = true;
          return withPartialCleanupMutationFence(cleanup, mutation);
        },
      },
    };

    await pollEncodeWorker({
      ...options,
      access: staleReconcilerAccess,
      runner: { run: vi.fn() },
      workerId: "stale-first-reconciler",
    });

    expect(interleavingCompleted).toBe(true);
    expect(staleCleanupRenameCrash.triggered).toBe(false);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("accepted retry");
    expect(secondReconciler.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    secondReconciler.close();
    firstReconciler.close();
    fixture.access.close();
  });

  it("never unlinks a competing atomic publisher while quarantining a prior final", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    quarantineRace.finalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    quarantineRace.competingPath = join(
      fixture.mediaLibraryPath,
      ".competing-publisher.mkv",
    );

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "worker replacement", { flag: "wx" });
          writeFileSync(
            quarantineRace.competingPath,
            "competing atomic publication",
            { flag: "wx" },
          );
          quarantineRace.armed = true;
        }),
      },
    });

    expect(quarantineRace.raced, quarantineRace.observed.join("\n")).toBe(
      true,
    );
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "competing atomic publication",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "failed" }),
    ]);
    fixture.access.close();
  });

  it("leaves a competing final untouched when it arrives before quarantine", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    preQuarantineRace.finalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    preQuarantineRace.competingPath = join(
      fixture.mediaLibraryPath,
      ".late-competing-publisher.mkv",
    );

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "worker replacement", { flag: "wx" });
          writeFileSync(
            preQuarantineRace.competingPath,
            "late competing publication",
            { flag: "wx" },
          );
          preQuarantineRace.armed = true;
        }),
      },
    });

    expect(preQuarantineRace.raced).toBe(true);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "late competing publication",
    );
    expect(quarantinedContents(fixture.outputPath)).not.toContain(
      "late competing publication",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "failed" }),
    ]);
    fixture.access.close();
  });

  it("retains a competing final published after the last cutover check", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    lateCutoverRace.finalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    lateCutoverRace.competingPath = join(
      fixture.mediaLibraryPath,
      ".post-check-competing-publisher.mkv",
    );

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "worker replacement", { flag: "wx" });
          const claimToken = basename(outputPath).slice(
            `.${basename(lateCutoverRace.finalPath)}.`.length,
            -".rip-dvd-partial".length,
          );
          lateCutoverRace.replacementPath = claimReplacementPath(
            lateCutoverRace.finalPath,
            claimToken,
          );
          writeFileSync(
            lateCutoverRace.competingPath,
            "post-check competing publication",
            { flag: "wx" },
          );
          lateCutoverRace.armed = true;
        }),
      },
    });

    expect(lateCutoverRace.raced).toBe(true);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "post-check competing publication",
    );
    expect(quarantinedContents(fixture.outputPath)).not.toContain(
      "post-check competing publication",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "failed" }),
    ]);
    fixture.access.close();
  });

  it("syncs retained links before cutover and replays a staging durability fault", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    stagedDirectoryDurability.finalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    stagedDirectoryDurability.armed = true;
    stagedDirectoryDurability.failNextSync = true;

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "lost durability attempt", { flag: "wx" });
          const claimToken = basename(outputPath).slice(
            `.${basename(stagedDirectoryDurability.finalPath)}.`.length,
            -".rip-dvd-partial".length,
          );
          stagedDirectoryDurability.priorPath = priorFinalPath(
            stagedDirectoryDurability.finalPath,
            claimToken,
          );
          stagedDirectoryDurability.replacementPath = claimReplacementPath(
            stagedDirectoryDurability.finalPath,
            claimToken,
          );
        }),
      },
    });

    expect(stagedDirectoryDurability.triggered).toBe(true);
    expect(stagedDirectoryDurability.observations).toEqual([
      {
        final: "known good encode",
        priorExists: true,
        replacementExists: true,
      },
    ]);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("known good encode");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "failed" }),
    ]);

    fixture.access.encodeJobs.requeue(fixture.job.id);
    stagedDirectoryDurability.observations = [];
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "durable retry", { flag: "wx" });
          const claimToken = basename(outputPath).slice(
            `.${basename(stagedDirectoryDurability.finalPath)}.`.length,
            -".rip-dvd-partial".length,
          );
          stagedDirectoryDurability.priorPath = priorFinalPath(
            stagedDirectoryDurability.finalPath,
            claimToken,
          );
          stagedDirectoryDurability.replacementPath = claimReplacementPath(
            stagedDirectoryDurability.finalPath,
            claimToken,
          );
        }),
      },
    });

    expect(stagedDirectoryDurability.observations).toEqual([
      {
        final: "known good encode",
        priorExists: true,
        replacementExists: true,
      },
      {
        final: "durable retry",
        priorExists: true,
        replacementExists: false,
      },
    ]);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("durable retry");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    fixture.access.close();
  });

  it("keeps a prior final visible through a failed re-encode and replaces it on retry", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async () => {
          expect(readFileSync(fixture.outputPath, "utf8")).toBe(
            "known good encode",
          );
          throw new Error("replacement failed");
        }),
      },
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("known good encode");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        replacementOutputIdentity: expect.any(String),
        replaceExistingOutput: true,
        status: "failed",
      }),
    ]);
    fixture.access.encodeJobs.requeue(fixture.job.id);
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "successful replacement", { flag: "wx" });
        }),
      },
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "successful replacement",
    );
    expect(quarantinedContents(fixture.outputPath)).toContain(
      "known good encode",
    );
    fixture.access.close();
  });

  it("revokes re-encode authority when the prior final changes between retries", async () => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "owned final", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async () => {
          throw new Error("replacement failed");
        }),
      },
    });
    rmSync(fixture.outputPath);
    writeFileSync(fixture.outputPath, "competing final", { flag: "wx" });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const retryRunner: HandBrakeRunner = { run: vi.fn() };

    await pollEncodeWorker({ ...options, runner: retryRunner });

    expect(retryRunner.run).not.toHaveBeenCalled();
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("competing final");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        replacementOutputIdentity: null,
        replaceExistingOutput: false,
        status: "failed",
      }),
    ]);
    fixture.access.close();
  });

  it("quarantines a crashed claim-scoped partial before retrying", async () => {
    const fixture = createQueuedJob();
    mkdirSync(dirname(fixture.outputPath), { recursive: true });
    const stalePartial = join(
      dirname(fixture.outputPath),
      `.${basename(fixture.outputPath)}.abandoned-claim.rip-dvd-partial`,
    );
    writeFileSync(stalePartial, "crashed encode", { flag: "wx" });
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        expect(quarantinedContents(stalePartial)).toContain("crashed encode");
        writeFileSync(outputPath, "recovered encode", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });

    expect(readFileSync(fixture.outputPath, "utf8")).toBe("recovered encode");
    fixture.access.close();
  });

  it("quarantines a timed-out partial only after HandBrake releases it", async () => {
    const fixture = createQueuedJob();
    let partialPath = "";
    let active = true;
    let releaseOutput!: () => void;
    const outputReleased = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    const runner: HandBrakeRunner = {
      isActive: (outputPath) => active && outputPath === partialPath,
      whenInactive: async () => outputReleased,
      run: vi.fn(async ({ outputPath }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, "still being written", { flag: "wx" });
        throw new Error("HandBrake timed out");
      }),
    };

    await pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });

    expect(readFileSync(partialPath, "utf8")).toBe("still being written");
    expect(quarantinedContents(partialPath)).toEqual([]);
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: expect.any(String),
        partialCleanupOutputPath: fixture.outputPath,
        status: "failed",
        errorMessage: "HandBrake timed out",
      }),
    ]);
    active = false;
    releaseOutput();
    await vi.waitFor(() => expect(existsSync(partialPath)).toBe(false));
    await vi.waitFor(() =>
      expect(fixture.access.encodeJobs.listPendingPartialCleanups()).toEqual(
        [],
      ),
    );
    expect(quarantinedContents(partialPath)).toContain("still being written");
    fixture.access.close();
  });

  it("durably cleans an expired claim partial after a crash and path change", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const abandoned = fixture.access.encodeJobs.claimNext("crashed-worker");
    expect(abandoned).not.toBeNull();
    if (!abandoned) {
      throw new Error("Expected the crashed worker claim");
    }
    mkdirSync(dirname(fixture.outputPath), { recursive: true });
    const abandonedPartial = join(
      dirname(fixture.outputPath),
      `.${basename(fixture.outputPath)}.${abandoned.claimToken}.rip-dvd-partial`,
    );
    writeFileSync(abandonedPartial, "abandoned process output", { flag: "wx" });
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
    expect(fixture.access.encodeJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    const replacementOutputPath = join(
      fixture.mediaLibraryPath,
      "Recovered Elsewhere.mkv",
    );
    expect(() =>
      fixture.access.encodeJobs.enqueue({
        discSelectionId: fixture.job.discSelectionId,
        encodingProfileId: fixture.job.encodingProfileId,
        outputPath: replacementOutputPath,
      }),
    ).toThrow(/failed.*queued/i);
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    const cleanupRunner: HandBrakeRunner = { run: vi.fn() };

    await pollEncodeWorker({ ...options, runner: cleanupRunner });

    expect(cleanupRunner.run).not.toHaveBeenCalled();
    fixture.access.encodeJobs.enqueue({
      discSelectionId: fixture.job.discSelectionId,
      encodingProfileId: fixture.job.encodingProfileId,
      outputPath: replacementOutputPath,
    });
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        expect(quarantinedContents(abandonedPartial)).toContain(
          "abandoned process output",
        );
        writeFileSync(outputPath, "recovered encode", { flag: "wx" });
      }),
    };

    await pollEncodeWorker({ ...options, runner });

    expect(runner.run).toHaveBeenCalledOnce();
    expect(quarantinedContents(abandonedPartial)).toContain(
      "abandoned process output",
    );
    expect(readFileSync(replacementOutputPath, "utf8")).toBe(
      "recovered encode",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        partialCleanupOutputPath: null,
        status: "completed",
      }),
    ]);
    vi.useRealTimers();
    fixture.access.close();
  });

  it("rejects requeue until an expired publication is reconciled, then retries", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const claim = fixture.access.encodeJobs.claimNext("expired-publisher");
    if (!claim) {
      throw new Error("Expected the Encode Job to be claimed");
    }
    mkdirSync(dirname(fixture.outputPath), { recursive: true });
    const partialPath = claimPartialPath(
      fixture.outputPath,
      claim.claimToken,
    );
    writeFileSync(partialPath, "published before lease expiry", { flag: "wx" });
    fixture.access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });
    linkSync(partialPath, fixture.outputPath);
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
    expect(fixture.access.encodeJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "failed" }),
    ]);

    expect(() => fixture.access.encodeJobs.requeue(fixture.job.id)).toThrow(
      /failed.*queued/i,
    );

    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    const reconciliationRunner: HandBrakeRunner = { run: vi.fn() };
    await pollEncodeWorker({ ...options, runner: reconciliationRunner });
    expect(reconciliationRunner.run).not.toHaveBeenCalled();
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "published before lease expiry",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        partialCleanupOutputPath: null,
        publicationPending: false,
        status: "completed",
      }),
    ]);

    expect(fixture.access.encodeJobs.requeue(fixture.job.id)).toMatchObject({
      id: fixture.job.id,
      status: "queued",
    });
    const retryRunner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, "retry after reconciliation", { flag: "wx" });
      }),
    };
    await pollEncodeWorker({ ...options, runner: retryRunner });

    expect(retryRunner.run).toHaveBeenCalledOnce();
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "retry after reconciliation",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    fixture.access.close();
  });

  it("does not accept a matching publication replaced after its snapshot", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const claim = fixture.access.encodeJobs.claimNext("crashed-publisher");
    if (!claim) {
      throw new Error("Expected the Encode Job to be claimed");
    }
    mkdirSync(fixture.mediaLibraryPath, { recursive: true });
    const canonicalFinalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    const partialPath = claimPartialPath(
      canonicalFinalPath,
      claim.claimToken,
    );
    writeFileSync(partialPath, "worker publication", { flag: "wx" });
    fixture.access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });
    linkSync(partialPath, canonicalFinalPath);
    matchingCompletionRace.competingPath = join(
      fixture.mediaLibraryPath,
      ".matching-completion-competitor.mkv",
    );
    matchingCompletionRace.finalPath = canonicalFinalPath;
    writeFileSync(
      matchingCompletionRace.competingPath,
      "competing publication",
      { flag: "wx" },
    );
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
    fixture.access.encodeJobs.recoverExpiredClaims();
    matchingCompletionRace.armed = true;
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: { run: vi.fn() },
      signal: new AbortController().signal,
    };

    await pollEncodeWorker(options);

    expect(matchingCompletionRace.raced).toBe(true);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe(
      "competing publication",
    );
    expect(readFileSync(partialPath, "utf8")).toBe("worker publication");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: claim.claimToken,
        publicationPending: true,
        status: "failed",
      }),
    ]);

    matchingCompletionRace.armed = false;
    await pollEncodeWorker(options);

    expect(existsSync(partialPath)).toBe(false);
    expect(quarantinedContents(partialPath)).toContain("worker publication");
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        publicationPending: false,
        status: "failed",
      }),
    ]);
    fixture.access.close();
  });

  it("restores a displaced competitor after a crash at the exchange boundary", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "known good encode", { flag: "wx" });
        }),
      },
    });
    fixture.access.encodeJobs.requeue(fixture.job.id);
    const claim = fixture.access.encodeJobs.claimNext("crashed-exchange");
    if (!claim) {
      throw new Error("Expected the crashed exchange claim");
    }
    const canonicalFinalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    const partialPath = claimPartialPath(
      canonicalFinalPath,
      claim.claimToken,
    );
    const priorPath = priorFinalPath(canonicalFinalPath, claim.claimToken);
    const replacementPath = claimReplacementPath(
      canonicalFinalPath,
      claim.claimToken,
    );
    const competingPath = join(
      fixture.mediaLibraryPath,
      ".exchange-crash-competitor.mkv",
    );
    const exchangeTemporaryPath = join(
      fixture.mediaLibraryPath,
      ".exchange-crash-temporary.mkv",
    );
    writeFileSync(partialPath, "unaccepted worker replacement", {
      flag: "wx",
    });
    writeFileSync(competingPath, "displaced competing publication", {
      flag: "wx",
    });
    fixture.access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });
    linkSync(canonicalFinalPath, priorPath);
    linkSync(partialPath, replacementPath);
    renameSync(competingPath, canonicalFinalPath);
    renameSync(canonicalFinalPath, exchangeTemporaryPath);
    renameSync(replacementPath, canonicalFinalPath);
    renameSync(exchangeTemporaryPath, replacementPath);
    expect(readFileSync(canonicalFinalPath, "utf8")).toBe(
      "unaccepted worker replacement",
    );
    expect(readFileSync(replacementPath, "utf8")).toBe(
      "displaced competing publication",
    );
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
    fixture.access.encodeJobs.recoverExpiredClaims();

    await pollEncodeWorker({
      ...options,
      runner: { run: vi.fn() },
      workerId: "exchange-recovery",
    });

    expect(readFileSync(canonicalFinalPath, "utf8")).toBe(
      "displaced competing publication",
    );
    expect(existsSync(replacementPath)).toBe(false);
    expect(quarantinedContents(canonicalFinalPath)).not.toContain(
      "displaced competing publication",
    );
    expect(quarantinedContents(partialPath)).toContain(
      "unaccepted worker replacement",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        publicationPending: false,
        status: "failed",
      }),
    ]);
    fixture.access.close();
  });

  it("does not complete matching recovery before the final directory is durable", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const claim = fixture.access.encodeJobs.claimNext("crashed-publisher");
    if (!claim) {
      throw new Error("Expected the Encode Job to be claimed");
    }
    mkdirSync(fixture.mediaLibraryPath, { recursive: true });
    const canonicalFinalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    const partialPath = claimPartialPath(
      canonicalFinalPath,
      claim.claimToken,
    );
    writeFileSync(partialPath, "linked but not directory durable", {
      flag: "wx",
    });
    fixture.access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });
    linkSync(partialPath, canonicalFinalPath);
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
    fixture.access.encodeJobs.recoverExpiredClaims();
    recoveryDirectorySyncFailure.armed = true;
    recoveryDirectorySyncFailure.finalPath = canonicalFinalPath;
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner: { run: vi.fn() },
      signal: new AbortController().signal,
    };

    await pollEncodeWorker(options);

    expect(recoveryDirectorySyncFailure.triggered).toBe(true);
    expect(existsSync(canonicalFinalPath)).toBe(false);
    expect(readFileSync(partialPath, "utf8")).toBe(
      "linked but not directory durable",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: claim.claimToken,
        publicationPending: true,
        status: "failed",
      }),
    ]);

    recoveryDirectorySyncFailure.armed = false;
    await pollEncodeWorker(options);

    expect(existsSync(partialPath)).toBe(false);
    expect(quarantinedContents(partialPath)).toContain(
      "linked but not directory durable",
    );
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        publicationPending: false,
        status: "failed",
      }),
    ]);
    fixture.access.close();
  });

  it.each([
    { kind: "initial", reencode: false },
    { kind: "re-encode", reencode: true },
  ])("rolls back a $kind publication when its fence COMMIT fails", async ({
    reencode,
  }) => {
    const fixture = createQueuedJob();
    const options = {
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
    };
    if (reencode) {
      await pollEncodeWorker({
        ...options,
        runner: {
          run: vi.fn(async ({ outputPath }) => {
            writeFileSync(outputPath, "known good encode", { flag: "wx" });
          }),
        },
      });
      fixture.access.encodeJobs.requeue(fixture.job.id);
    }
    mkdirSync(fixture.mediaLibraryPath, { recursive: true });
    const canonicalFinalPath = join(
      realpathSync(fixture.mediaLibraryPath),
      basename(fixture.outputPath),
    );
    failPublicationFenceCommit(canonicalFinalPath);
    const attemptedOutput = reencode
      ? "unaccepted replacement"
      : "unaccepted initial encode";

    await pollEncodeWorker({
      ...options,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, attemptedOutput, { flag: "wx" });
        }),
      },
    });

    expect(postLinkCommitFailure.triggered).toBe(true);
    if (reencode) {
      expect(readFileSync(canonicalFinalPath, "utf8")).toBe(
        "known good encode",
      );
    } else {
      expect(existsSync(canonicalFinalPath)).toBe(false);
    }
    expect(quarantinedContents(canonicalFinalPath)).toContain(attemptedOutput);
    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: fixture.job.id,
        partialCleanupClaimToken: null,
        partialCleanupOutputPath: null,
        publicationPending: false,
        replaceExistingOutput: reencode,
        status: "failed",
      }),
    ]);
    fixture.access.close();
  });

  it.each([
    {
      boundary: "final-linked",
      kind: "initial",
      publicationPending: true,
      reencode: false,
    },
    {
      boundary: "directory-synced",
      kind: "initial",
      publicationPending: true,
      reencode: false,
    },
    {
      boundary: "database-completed",
      kind: "initial",
      publicationPending: true,
      reencode: false,
    },
    {
      boundary: "partial-unlinked",
      kind: "initial",
      publicationPending: true,
      reencode: false,
    },
    {
      boundary: "final-linked",
      kind: "re-encode",
      publicationPending: true,
      reencode: true,
    },
    {
      boundary: "directory-synced",
      kind: "re-encode",
      publicationPending: true,
      reencode: true,
    },
    {
      boundary: "database-completed",
      kind: "re-encode",
      publicationPending: true,
      reencode: true,
    },
    {
      boundary: "partial-unlinked",
      kind: "re-encode",
      publicationPending: true,
      reencode: true,
    },
    {
      boundary: "final-linked",
      kind: "revoked initial",
      publicationPending: false,
      reencode: false,
    },
    {
      boundary: "final-linked",
      kind: "revoked re-encode",
      publicationPending: false,
      reencode: true,
    },
  ])(
    "reconciles a $kind publication after process kill at $boundary",
    async ({ boundary, publicationPending, reencode }) => {
      const fixture = createQueuedJob();
      const options = {
        access: fixture.access,
        concurrency: 1,
        log: vi.fn(),
        mediaLibraryPath: fixture.mediaLibraryPath,
        originalsLibraryPath: fixture.originalsLibraryPath,
        signal: new AbortController().signal,
      };
      if (reencode) {
        await pollEncodeWorker({
          ...options,
          runner: {
            run: vi.fn(async ({ outputPath }) => {
              writeFileSync(outputPath, "known good encode", { flag: "wx" });
            }),
          },
        });
        fixture.access.encodeJobs.requeue(fixture.job.id);
      }
      mkdirSync(fixture.mediaLibraryPath, { recursive: true });
      const claim = fixture.access.encodeJobs.claimNext("crashed-publisher");
      if (!claim) {
        throw new Error("Expected a publication claim");
      }
      const canonicalFinalPath = join(
        realpathSync(fixture.mediaLibraryPath),
        basename(fixture.outputPath),
      );
      const partialPath = claimPartialPath(
        canonicalFinalPath,
        claim.claimToken,
      );
      const priorPath = reencode
        ? priorFinalPath(canonicalFinalPath, claim.claimToken)
        : "";
      const replacementPath = reencode
        ? claimReplacementPath(canonicalFinalPath, claim.claimToken)
        : "";
      writeFileSync(partialPath, "published before crash", { flag: "wx" });
      expect(
        fixture.access.encodeJobs.registerPartialCleanup(claim, {
          publicationPending,
        }),
      ).toMatchObject({ publicationPending });
      const child = spawnProcess(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "./test-fixtures/publication-kill-helper.mjs",
              import.meta.url,
            ),
          ),
          boundary,
          partialPath,
          canonicalFinalPath,
          priorPath,
          replacementPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      if (boundary === "final-linked" || boundary === "directory-synced") {
        await waitForChildLine(child, boundary);
      } else {
        await waitForChildLine(child, "ready-for-database");
        fixture.access.encodeJobs.complete(claim);
        if (boundary === "partial-unlinked") {
          child.stdin.end();
          await waitForChildLine(child, "partial-unlinked");
        }
      }
      await killChild(child);
      if (boundary === "final-linked" || boundary === "directory-synced") {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + ENCODE_JOB_LEASE_DURATION_MS + 1);
      }
      const recoveryRunner: HandBrakeRunner = { run: vi.fn() };

      await pollEncodeWorker({ ...options, runner: recoveryRunner });

      expect(recoveryRunner.run).not.toHaveBeenCalled();
      expect(existsSync(partialPath)).toBe(false);
      expect(fixture.access.encodeJobs.list()).toEqual([
        expect.objectContaining({
          id: fixture.job.id,
          partialCleanupClaimToken: null,
          partialCleanupOutputPath: null,
          publicationPending: false,
          status: publicationPending ? "completed" : "failed",
        }),
      ]);
      if (publicationPending) {
        expect(readFileSync(fixture.outputPath, "utf8")).toBe(
          "published before crash",
        );
      } else if (reencode) {
        expect(readFileSync(fixture.outputPath, "utf8")).toBe(
          "known good encode",
        );
        expect(quarantinedContents(fixture.outputPath)).toContain(
          "published before crash",
        );
      } else {
        expect(existsSync(fixture.outputPath)).toBe(false);
        expect(quarantinedContents(fixture.outputPath)).toContain(
          "published before crash",
        );
      }
      if (reencode && publicationPending) {
        expect(quarantinedContents(fixture.outputPath)).toContain(
          "known good encode",
        );
      }
      vi.useRealTimers();
      fixture.access.close();
    },
  );

  it.each([
    { boundary: "post-authority" },
    { boundary: "post-replacement-link" },
  ] as const)(
    "recovers a re-encode publication killed at its $boundary fence",
    async ({ boundary }) => {
      const fixture = createQueuedJob();
      const options = {
        access: fixture.access,
        concurrency: 1,
        log: vi.fn(),
        mediaLibraryPath: fixture.mediaLibraryPath,
        originalsLibraryPath: fixture.originalsLibraryPath,
        signal: new AbortController().signal,
      };
      await pollEncodeWorker({
        ...options,
        runner: {
          run: vi.fn(async ({ outputPath }) => {
            writeFileSync(outputPath, "known good encode", { flag: "wx" });
          }),
        },
      });
      fixture.access.encodeJobs.requeue(fixture.job.id);
      const claim = fixture.access.encodeJobs.claimNext("fenced-publisher");
      if (!claim) {
        throw new Error("Expected the fenced publication claim");
      }
      const canonicalFinalPath = join(
        realpathSync(fixture.mediaLibraryPath),
        basename(fixture.outputPath),
      );
      const partialPath = claimPartialPath(
        canonicalFinalPath,
        claim.claimToken,
      );
      const priorPath = priorFinalPath(
        canonicalFinalPath,
        claim.claimToken,
      );
      const replacementPath = claimReplacementPath(
        canonicalFinalPath,
        claim.claimToken,
      );
      writeFileSync(partialPath, "fenced replacement", { flag: "wx" });
      fixture.access.encodeJobs.registerPartialCleanup(claim, {
        publicationPending: true,
      });
      const child = spawnProcess(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "./test-fixtures/mutation-fence-kill-helper.mjs",
              import.meta.url,
            ),
          ),
          "publication",
          boundary,
          fixture.databasePath,
          canonicalFinalPath,
          partialPath,
          priorPath,
          replacementPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      await waitForChildLine(child, boundary);
      if (boundary === "post-replacement-link") {
        expect(readFileSync(canonicalFinalPath, "utf8")).toBe(
          "known good encode",
        );
      }
      await killChild(child);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + ENCODE_JOB_LEASE_DURATION_MS + 1);
      await pollEncodeWorker({
        ...options,
        runner: { run: vi.fn() },
        workerId: "publication-recovery",
      });

      expect(readFileSync(fixture.outputPath, "utf8")).toBe(
        "known good encode",
      );
      expect(existsSync(replacementPath)).toBe(false);
      expect(fixture.access.encodeJobs.list()).toEqual([
        expect.objectContaining({
          id: fixture.job.id,
          partialCleanupClaimToken: null,
          publicationPending: false,
          status: "failed",
        }),
      ]);
      fixture.access.encodeJobs.requeue(fixture.job.id);
      await pollEncodeWorker({
        ...options,
        runner: {
          run: vi.fn(async ({ outputPath }) => {
            writeFileSync(outputPath, "accepted publication retry", {
              flag: "wx",
            });
          }),
        },
        workerId: "accepted-publication-retry",
      });
      expect(readFileSync(fixture.outputPath, "utf8")).toBe(
        "accepted publication retry",
      );
      expect(fixture.access.encodeJobs.list()).toEqual([
        expect.objectContaining({ id: fixture.job.id, status: "completed" }),
      ]);
      vi.useRealTimers();
      fixture.access.close();
    },
  );

  it.each([
    { boundary: "post-authority" },
    { boundary: "post-rename" },
  ] as const)(
    "recovers revoked cleanup killed at its $boundary fence",
    async ({ boundary }) => {
      const fixture = createQueuedJob();
      const options = {
        access: fixture.access,
        concurrency: 1,
        log: vi.fn(),
        mediaLibraryPath: fixture.mediaLibraryPath,
        originalsLibraryPath: fixture.originalsLibraryPath,
        signal: new AbortController().signal,
      };
      await pollEncodeWorker({
        ...options,
        runner: {
          run: vi.fn(async ({ outputPath }) => {
            writeFileSync(outputPath, "known good encode", { flag: "wx" });
          }),
        },
      });
      fixture.access.encodeJobs.requeue(fixture.job.id);
      const claim = fixture.access.encodeJobs.claimNext("revoked-publisher");
      if (!claim) {
        throw new Error("Expected the revoked publication claim");
      }
      const canonicalFinalPath = join(
        realpathSync(fixture.mediaLibraryPath),
        basename(fixture.outputPath),
      );
      const partialPath = claimPartialPath(
        canonicalFinalPath,
        claim.claimToken,
      );
      const priorPath = priorFinalPath(
        canonicalFinalPath,
        claim.claimToken,
      );
      const quarantinePath = `${canonicalFinalPath}.failed.cleanup-kill-${boundary}`;
      writeFileSync(partialPath, "revoked replacement", { flag: "wx" });
      const publication = fixture.access.encodeJobs.registerPartialCleanup(
        claim,
        { publicationPending: true },
      );
      renameSync(canonicalFinalPath, priorPath);
      linkSync(partialPath, canonicalFinalPath);
      fixture.access.encodeJobs.revokePublication(claim, publication);
      fixture.access.encodeJobs.fail(claim, "publication revoked", {
        preserveReplacementAuthority: true,
      });
      const child = spawnProcess(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "./test-fixtures/mutation-fence-kill-helper.mjs",
              import.meta.url,
            ),
          ),
          "cleanup",
          boundary,
          fixture.databasePath,
          canonicalFinalPath,
          partialPath,
          priorPath,
          quarantinePath,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      await waitForChildLine(child, boundary);
      await killChild(child);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + ENCODE_JOB_LEASE_DURATION_MS + 1);
      await pollEncodeWorker({
        ...options,
        runner: { run: vi.fn() },
        workerId: "cleanup-recovery",
      });

      expect(readFileSync(fixture.outputPath, "utf8")).toBe(
        "known good encode",
      );
      expect(fixture.access.encodeJobs.list()).toEqual([
        expect.objectContaining({
          id: fixture.job.id,
          partialCleanupClaimToken: null,
          publicationPending: false,
          status: "failed",
        }),
      ]);
      fixture.access.encodeJobs.requeue(fixture.job.id);
      await pollEncodeWorker({
        ...options,
        runner: {
          run: vi.fn(async ({ outputPath }) => {
            writeFileSync(outputPath, "accepted retry", { flag: "wx" });
          }),
        },
        workerId: "accepted-retry",
      });
      expect(readFileSync(fixture.outputPath, "utf8")).toBe(
        "accepted retry",
      );
      expect(fixture.access.encodeJobs.list()).toEqual([
        expect.objectContaining({ id: fixture.job.id, status: "completed" }),
      ]);
      vi.useRealTimers();
      fixture.access.close();
    },
  );

  it("renews the claim while HandBrake is still running", async () => {
    vi.useFakeTimers();
    const fixture = createQueuedJob();
    const renewClaim = vi.spyOn(fixture.access.encodeJobs, "renewClaim");
    let releaseEncode!: () => void;
    const encodeGate = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        await encodeGate;
        writeFileSync(outputPath, "renewed encode", { flag: "wx" });
      }),
    };

    const polling = pollEncodeWorker({
      access: fixture.access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath: fixture.mediaLibraryPath,
      originalsLibraryPath: fixture.originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(
      Math.floor(ENCODE_JOB_LEASE_DURATION_MS / 3),
    );
    expect(renewClaim).toHaveBeenCalledOnce();
    expect(fixture.access.encodeJobs.recoverExpiredClaims()).toEqual([]);
    releaseEncode();
    await polling;

    expect(fixture.access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: fixture.job.id, status: "completed" }),
    ]);
    vi.useRealTimers();
    fixture.access.close();
  });
});

describe("node HandBrake runner", () => {
  it("runs HandBrake at the lowest priority and releases output ownership only on close", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnProcess = vi.fn(() => child);
    const runner = createNodeHandBrakeRunner({ spawnProcess });
    const onOutput = vi.fn();

    const running = runner.run({
      arguments_: ["--main-feature", "-i", "/source.iso", "-o", "/partial.mkv"],
      onOutput,
      outputPath: "/partial.mkv",
      signal: new AbortController().signal,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "nice",
      [
        "-n",
        "19",
        "ionice",
        "-c",
        "3",
        "HandBrakeCLI",
        "--main-feature",
        "-i",
        "/source.iso",
        "-o",
        "/partial.mkv",
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(runner.isActive?.("/partial.mkv")).toBe(true);
    stderr.emit("data", Buffer.from("Encoding: task 1 of 1, 10.00 %\r"));
    expect(onOutput).toHaveBeenCalledWith(
      "Encoding: task 1 of 1, 10.00 %\r",
    );
    child.emit("close", 0, null);
    await expect(running).resolves.toBeUndefined();
    expect(runner.isActive?.("/partial.mkv")).toBe(false);
  });

  it("retains output ownership after timeout until the child closes", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const runner = createNodeHandBrakeRunner({
      spawnProcess: vi.fn(() => child),
      timeoutMs: 10,
    });
    const running = runner.run({
      arguments_: ["-i", "/source.iso", "-o", "/partial.mkv"],
      onOutput: vi.fn(),
      outputPath: "/partial.mkv",
      signal: new AbortController().signal,
    });
    const timedOut = expect(running).rejects.toThrow("HandBrake timed out");

    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(runner.isActive?.("/partial.mkv")).toBe(true);
    child.emit("close", null, "SIGKILL");
    expect(runner.isActive?.("/partial.mkv")).toBe(false);
    vi.useRealTimers();
  });

  it("cancels a child when abort races with listener installation", async () => {
    const abortController = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const runner = createNodeHandBrakeRunner({
      spawnProcess: vi.fn(() => {
        abortController.abort(new Error("stop now"));
        return child;
      }),
    });
    const running = runner.run({
      arguments_: ["-i", "/source.iso", "-o", "/partial.mkv"],
      onOutput: vi.fn(),
      outputPath: "/partial.mkv",
      signal: abortController.signal,
    });

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    await expect(running).rejects.toThrow("stop now");
    expect(runner.isActive?.("/partial.mkv")).toBe(true);
    child.emit("close", null, "SIGKILL");
    expect(runner.isActive?.("/partial.mkv")).toBe(false);
  });
});
