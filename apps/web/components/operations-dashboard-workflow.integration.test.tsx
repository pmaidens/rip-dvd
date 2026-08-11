import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataAccess } from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker,
  type OpticalDriveHardware,
} from "../../archive-worker/src/archive-worker.js";
import type { DvdCopyRunner } from "../../archive-worker/src/dvd-archiver.js";
import {
  pollEncodeWorker,
  type HandBrakeRunner,
} from "../../encode-worker/src/encode-worker.js";
import { createArchiveJobsRoute } from "../app/api/archive-jobs/route";
import { createCatalogReviewRoute } from "../app/api/catalog-reviews/[id]/route";
import { createDashboardEventResponse } from "../app/api/dashboard/events/route";
import { createDashboardResponse } from "../app/api/dashboard/route";
import { createEncodeJobsRoute } from "../app/api/encode-jobs/route";
import {
  createFilesystemVerificationInventoryRoute,
  createFilesystemVerificationRoute,
} from "../app/api/filesystem-verification/route";
import type {
  DashboardArchiveJob,
  DashboardEncodeJob,
  DashboardSnapshot,
} from "../lib/dashboard";
import {
  FilesystemVerificationInventoryView,
  type FilesystemVerificationInventoryState,
} from "./filesystem-verification-inventory";
import { DashboardView } from "./operations-dashboard";

const trustedOrigin = "http://localhost:3000";
const temporaryDirectories: string[] = [];
const openAccess: DataAccess[] = [];
const openEventStreams: AbortController[] = [];

afterEach(() => {
  for (const controller of openEventStreams.splice(0)) {
    controller.abort();
  }
  for (const access of openAccess.splice(0)) {
    access.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createMutationRequest(path: string, body: unknown): Request {
  return new Request(`${trustedOrigin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: trustedOrigin,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

async function readDashboard(access: DataAccess): Promise<{
  html: string;
  snapshot: DashboardSnapshot;
}> {
  const snapshot = (await createDashboardResponse(access).json()) as DashboardSnapshot;
  return {
    html: renderToStaticMarkup(<DashboardView state={snapshot} />),
    snapshot,
  };
}

function archiveJob(snapshot: DashboardSnapshot): DashboardArchiveJob {
  if (snapshot.archiveJobs.status !== "loaded") {
    throw new Error("Archive Jobs are unavailable");
  }
  const job = snapshot.archiveJobs.items[0];
  if (!job) {
    throw new Error("Expected an Archive Job");
  }
  return job;
}

function encodeJob(snapshot: DashboardSnapshot): DashboardEncodeJob {
  if (snapshot.encodeJobs.status !== "loaded") {
    throw new Error("Encode Jobs are unavailable");
  }
  const job = snapshot.encodeJobs.items[0];
  if (!job) {
    throw new Error("Expected an Encode Job");
  }
  return job;
}

function createDashboardEventReader(access: DataAccess) {
  const controller = new AbortController();
  openEventStreams.push(controller);
  const response = createDashboardEventResponse(access, {
    signal: controller.signal,
    pollIntervalMs: 2,
  });
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected a dashboard event stream");
  }
  const decoder = new TextDecoder();
  const snapshots: DashboardSnapshot[] = [];
  let buffer = "";

  const parseEvents = () => {
    let eventBoundary = buffer.indexOf("\n\n");
    while (eventBoundary >= 0) {
      const event = buffer.slice(0, eventBoundary);
      buffer = buffer.slice(eventBoundary + 2);
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (data) {
        snapshots.push(JSON.parse(data) as DashboardSnapshot);
      }
      eventBoundary = buffer.indexOf("\n\n");
    }
  };

  return {
    async next(
      matches: (snapshot: DashboardSnapshot) => boolean,
    ): Promise<DashboardSnapshot> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const matchingIndex = snapshots.findIndex(matches);
        if (matchingIndex >= 0) {
          return snapshots.splice(matchingIndex, 1)[0]!;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("Dashboard event stream closed before the expected state");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        parseEvents();
      }
      throw new Error("Dashboard event stream did not publish the expected state");
    },
    async close(): Promise<void> {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

function createGate(): {
  entered: Promise<void>;
  release(): void;
  wait(): Promise<void>;
} {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await waiting;
    },
  };
}

describe("end-to-end operations dashboard workflow", () => {
  it("runs the public dashboard workflow through explicit verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-operations-workflow-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    const mediaLibraryPath = join(root, "media");
    mkdirSync(originalsLibraryPath);
    mkdirSync(mediaLibraryPath);
    const inspectPath = vi.fn(async () => "file" as const);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
      filesystemPathProbe: { inspect: inspectPath },
      mediaLibraryPath,
      originalsLibraryPath,
    });
    openAccess.push(access);

    const fingerprint =
      "sha256:e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Workflow Optical Drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "WORKFLOW-001",
    };
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 5_711,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const hardware: OpticalDriveHardware = {
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      bindOpticalDrive: vi.fn(async (drive, signal) => {
        signal.throwIfAborted();
        return { deviceInstanceToken: "workflow-device", drive };
      }),
      confirmOpticalDrive: vi.fn(async (_binding, signal) => {
        signal.throwIfAborted();
      }),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes: 9,
        volumeLabel: "WORKFLOW_DISC",
      }),
    };
    const signal = new AbortController().signal;

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal,
    });

    const discoveredDashboard = await readDashboard(access);
    expect(discoveredDashboard.html).toContain("Workflow Optical Drive");
    expect(discoveredDashboard.html).toContain("WORKFLOW_DISC");
    expect(discoveredDashboard.html).toContain("Approve archive");
    const detectedDisc = access.catalog.listDetectedDiscs()[0]!;

    const approval = await createArchiveJobsRoute(
      createMutationRequest("/api/archive-jobs", {
        detectedDiscId: detectedDisc.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    expect(approval.status).toBe(201);
    expect((await approval.json()).job).toMatchObject({ status: "queued" });
    const queuedArchiveDashboard = await readDashboard(access);
    expect(archiveJob(queuedArchiveDashboard.snapshot)).toMatchObject({
      status: "queued",
      progressPercent: 0,
    });
    expect(queuedArchiveDashboard.html).toContain("Queued");

    const archiveGate = createGate();
    const copyRunner: DvdCopyRunner = {
      isActive: () => false,
      async copy({ outputPath, onBytesCopied }) {
        onBytesCopied(4);
        await archiveGate.wait();
        writeFileSync(outputPath, "dvd-image", { flag: "wx" });
        onBytesCopied(9);
      },
    };
    const archivePoll = pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal,
      workerId: "workflow-archive-worker",
    });
    await archiveGate.entered;
    const runningArchiveDashboard = await readDashboard(access);
    expect(archiveJob(runningArchiveDashboard.snapshot)).toMatchObject({
      status: "running",
      progressPercent: 44,
    });
    expect(runningArchiveDashboard.html).toContain("Running");
    expect(runningArchiveDashboard.html).toContain("44%");
    archiveGate.release();
    await archivePoll;

    const completedArchiveDashboard = await readDashboard(access);
    expect(archiveJob(completedArchiveDashboard.snapshot)).toMatchObject({
      status: "completed",
      progressPercent: 100,
    });
    expect(completedArchiveDashboard.html).toContain("Completed");
    expect(completedArchiveDashboard.html).toContain("Review catalog");
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(existsSync(archive.archivePath)).toBe(true);

    const catalogMutation = (body: unknown) =>
      createCatalogReviewRoute(
        createMutationRequest(`/api/catalog-reviews/${archive.id}`, body),
        archive.id,
        () => access,
        () => trustedOrigin,
      );
    const mediaItemResponse = await catalogMutation({
      action: "create_media_item",
      mediaItem: { kind: "movie", title: "Workflow Movie", year: 2001 },
    });
    expect(mediaItemResponse.status).toBe(201);
    const mediaItem = (await mediaItemResponse.json()).mediaItem as {
      id: string;
    };
    const selectionResponse = await catalogMutation({
      action: "create_disc_selection",
      selection: {
        label: "Main feature",
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    });
    expect(selectionResponse.status).toBe(201);
    const selection = (await selectionResponse.json()).discSelection as {
      id: string;
    };
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt.toISOString();
    const completedReview = await catalogMutation({
      action: "complete_review",
      catalogRevision,
    });
    expect(completedReview.status).toBe(200);
    expect((await completedReview.json()).archive.catalogReviewedAt).toEqual(
      expect.any(String),
    );

    const profile = access.encodingProfiles.create({
      key: "workflow-dvd",
      displayName: "Workflow DVD",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const queueOptions = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`),
      () => access,
    );
    expect(await queueOptions.json()).toMatchObject({
      profiles: [expect.objectContaining({ id: profile.id })],
      selections: [expect.objectContaining({ id: selection.id })],
    });

    const outputPath = join(mediaLibraryPath, "Workflow Movie (2001).mkv");
    const runtimeConfig = () => ({
      mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const queueResponse = await createEncodeJobsRoute(
      createMutationRequest("/api/encode-jobs", {
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath,
      }),
      () => access,
      runtimeConfig,
    );
    expect(queueResponse.status).toBe(200);
    const queuedEncodeJob = (await queueResponse.json()).job as { id: string };

    const events = createDashboardEventReader(access);
    const queuedEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "queued",
    );
    expect(encodeJob(queuedEncodeSnapshot)).toMatchObject({
      id: queuedEncodeJob.id,
      mediaTitle: "Workflow Movie",
      status: "queued",
    });

    const failedEncodeGate = createGate();
    const failingRunner: HandBrakeRunner = {
      async run({ onOutput, outputPath: partialPath }) {
        onOutput(
          "Encoding: task 1 of 1, 31.00 % (128.00 fps, avg 90.00 fps, ETA 0h12m03s)\r",
        );
        await failedEncodeGate.wait();
        writeFileSync(partialPath, "failed encode", { flag: "wx" });
        throw new Error("controlled HandBrake failure");
      },
    };
    const failedEncodePoll = pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: failingRunner,
      signal,
      workerId: "workflow-encode-worker-failure",
    });
    await failedEncodeGate.entered;
    const runningEncodeSnapshot = await events.next(
      (snapshot) =>
        encodeJob(snapshot).status === "running" &&
        encodeJob(snapshot).progressPercent === 31,
    );
    expect(
      renderToStaticMarkup(<DashboardView state={runningEncodeSnapshot} />),
    ).toContain("Encoding · ETA 12m 3s");
    failedEncodeGate.release();
    await failedEncodePoll;
    const failedEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "failed",
    );
    expect(
      renderToStaticMarkup(<DashboardView state={failedEncodeSnapshot} />),
    ).toContain("Retry encode");

    const retryResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ encodeJobId: queuedEncodeJob.id }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(retryResponse.status).toBe(200);
    expect((await retryResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "queued",
      progressPercent: 0,
    });
    await events.next((snapshot) => encodeJob(snapshot).status === "queued");

    const successfulEncodeGate = createGate();
    const successfulRunner: HandBrakeRunner = {
      async run({ onOutput, outputPath: partialPath }) {
        onOutput(
          "Encoding: task 1 of 1, 64.00 % (128.00 fps, avg 90.00 fps, ETA 0h02m05s)\r",
        );
        await successfulEncodeGate.wait();
        writeFileSync(partialPath, "completed encode", { flag: "wx" });
      },
    };
    const successfulEncodePoll = pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: successfulRunner,
      signal,
      workerId: "workflow-encode-worker-success",
    });
    await successfulEncodeGate.entered;
    const retryProgress = await events.next(
      (snapshot) =>
        encodeJob(snapshot).status === "running" &&
        encodeJob(snapshot).progressPercent === 64,
    );
    expect(encodeJob(retryProgress)).toMatchObject({
      progressPhase: "encoding",
      progressEtaSeconds: 125,
    });
    successfulEncodeGate.release();
    await successfulEncodePoll;
    const completedEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "completed",
    );
    expect(encodeJob(completedEncodeSnapshot)).toMatchObject({
      id: queuedEncodeJob.id,
      progressPercent: 100,
    });
    expect(readFileSync(outputPath, "utf8")).toBe("completed encode");

    expect(inspectPath).not.toHaveBeenCalled();
    await readDashboard(access);
    expect(inspectPath).not.toHaveBeenCalled();

    const archiveVerification = await createFilesystemVerificationRoute(
      createMutationRequest("/api/filesystem-verification", {
        target: "original_disc_archive",
        id: archive.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    const outputVerification = await createFilesystemVerificationRoute(
      createMutationRequest("/api/filesystem-verification", {
        target: "encode_job_output",
        id: queuedEncodeJob.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    expect(await archiveVerification.json()).toMatchObject({
      verification: { status: "accessible" },
    });
    expect(await outputVerification.json()).toMatchObject({
      verification: { status: "accessible" },
    });
    expect(inspectPath).toHaveBeenNthCalledWith(
      1,
      archive.archivePath,
      originalsLibraryPath,
    );
    expect(inspectPath).toHaveBeenNthCalledWith(
      2,
      outputPath,
      mediaLibraryPath,
    );
    const verifiedDashboard = await readDashboard(access);
    expect(verifiedDashboard.html).toContain("File is accessible.");
    const readInventory = (target: "encode_job_output" | "original_disc_archive") => {
      const response = createFilesystemVerificationInventoryRoute(
        new Request(
          `${trustedOrigin}/api/filesystem-verification?target=${target}`,
        ),
        () => access,
      );
      return response.json() as Promise<{
        inventory: Omit<
          Extract<
            FilesystemVerificationInventoryState,
            { status: "loaded" }
          >,
          "status"
        >;
      }>;
    };
    const [encodeInventory, archiveInventory] = await Promise.all([
      readInventory("encode_job_output"),
      readInventory("original_disc_archive"),
    ]);
    const inventoryHtml = renderToStaticMarkup(
      <FilesystemVerificationInventoryView
        encodeOutputs={{ status: "loaded", ...encodeInventory.inventory }}
        originalArchives={{ status: "loaded", ...archiveInventory.inventory }}
      />,
    );
    expect(inventoryHtml.match(/File is accessible\./g)).toHaveLength(2);
    expect(inspectPath).toHaveBeenCalledTimes(2);

    await events.close();
  }, 20_000);
});
