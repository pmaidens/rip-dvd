import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";

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

const temporaryDirectories: string[] = [];

afterEach(() => {
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
        expect(readFileSync(`${legacyPartialPath}.failed.1`, "utf8")).toBe(
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
    expect(readFileSync(`${failedAttemptPath}.failed`, "utf8")).toBe(
      "failed attempt",
    );
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
    expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe("new encode");
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
    expect(readFileSync(`${fixture.outputPath}.failed`, "utf8")).toBe(
      "old encode",
    );
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
    expect(readFileSync(`${fixture.outputPath}.failed`, "utf8")).toBe(
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
        expect(readFileSync(`${stalePartial}.failed`, "utf8")).toBe(
          "crashed encode",
        );
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
    expect(existsSync(`${partialPath}.failed`)).toBe(false);
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
    expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe(
      "still being written",
    );
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
    fixture.access.encodeJobs.enqueue({
      discSelectionId: fixture.job.discSelectionId,
      encodingProfileId: fixture.job.encodingProfileId,
      outputPath: replacementOutputPath,
    });
    const runner: HandBrakeRunner = {
      run: vi.fn(async ({ outputPath }) => {
        expect(readFileSync(`${abandonedPartial}.failed`, "utf8")).toBe(
          "abandoned process output",
        );
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

    expect(runner.run).toHaveBeenCalledOnce();
    expect(readFileSync(`${abandonedPartial}.failed`, "utf8")).toBe(
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
