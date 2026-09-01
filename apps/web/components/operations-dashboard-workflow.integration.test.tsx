import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";

import type { DataAccess, MediaItemId } from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../encode-worker/src/encode-output-validator.js",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../encode-worker/src/encode-output-validator.js")
    >();
    return {
      ...actual,
      nodeEncodeOutputValidator: {
        prepareAndValidate: vi.fn(async () => {}),
      },
    };
  },
);

import type { OpticalDriveHardware } from "../../archive-worker/src/archive-worker.js";
import type { DvdCopyRunner } from "../../archive-worker/src/dvd-archiver.js";
import {
  createCleanDvdRecoveryResult,
  createDamagedDvdRecoveryResult,
} from "../../archive-worker/src/dvd-recovery-contracts.js";
import {
  dvdRescueWorkspacePaths,
} from "../../archive-worker/src/dvd-rescue-workspace.js";
import {
  createNodeHandBrakeRunner,
  HandBrakeTimeoutError,
  pollEncodeWorker,
  type HandBrakeRunner,
} from "../../encode-worker/src/encode-worker.js";
import { EncodeOutputValidationError } from "../../encode-worker/src/encode-output-validator.js";
import {
  pollArchiveWorkerForTest as pollArchiveWorker,
} from "../test/archive-job-fixture";
import { createArchiveRequestsRoute } from "../app/api/archive-requests/route";
import { createCatalogReviewRoute } from "../app/api/catalog-reviews/[id]/route";
import { createMediaItemSearchRoute } from "../app/api/media-items/route";
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
import { investigationReport } from "../lib/investigation";
import {
  CatalogReviewView,
  type CatalogReviewDto,
} from "./catalog-review-editor";
import type { MappingProposal } from "./catalog-review-model";
import {
  FilesystemVerificationInventoryView,
  type FilesystemVerificationInventoryState,
} from "./filesystem-verification-inventory";
import { DashboardView } from "./operations-dashboard";
import { InvestigationPanel } from "./investigation-panel";

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

function renderCatalogReview(
  review: CatalogReviewDto,
  activeMappingProposal: MappingProposal | null = null,
): string {
  return renderToStaticMarkup(
    <CatalogReviewView
      state={{ status: "loaded", review }}
      editingMediaItemId={null}
      isSaving={false}
      requestError={null}
      mappingProposalError={null}
      selectionKind="main_feature"
      activeMappingProposal={activeMappingProposal}
      archiveOnlySelected={false}
      onClose={() => undefined}
      onRetry={() => undefined}
      onEditMediaItem={() => undefined}
      onCancelEdit={() => undefined}
      onDiscSelectionsPage={() => undefined}
      onCorrectionHistoryPage={() => undefined}
      onCorrectionEncodeHistoryPage={() => undefined}
      onCorrectionRetainedOutputHistoryPage={() => undefined}
      onSelectionKindChange={() => undefined}
      onArchiveOnlyChange={() => undefined}
      onStartMappingProposal={() => undefined}
      onCancelMappingProposal={() => undefined}
      onCreateMappingProposal={() => undefined}
      onSaveMediaItem={() => undefined}
      onDeleteMediaItem={() => undefined}
      onCreateDiscSelection={() => undefined}
      onUpdateDiscSelection={() => undefined}
      onDeleteDiscSelection={() => undefined}
      onCompleteReview={() => undefined}
    />,
  );
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

function encodeJobById(
  snapshot: DashboardSnapshot,
  id: string,
): DashboardEncodeJob | undefined {
  return snapshot.encodeJobs.status === "loaded"
    ? snapshot.encodeJobs.items.find((job) => job.id === id)
    : undefined;
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
  it("retains path-free Encode command investigations across retry and completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-encode-investigation-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    const mediaLibraryPath = join(root, "media");
    mkdirSync(originalsLibraryPath);
    mkdirSync(mediaLibraryPath);
    const sourcePath = join(originalsLibraryPath, "Investigation.iso");
    writeFileSync(sourcePath, "investigation source");
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
      mediaLibraryPath,
      originalsLibraryPath,
    });
    openAccess.push(access);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/encode-investigation",
      isPresent: true,
    });
    const contentId = `sha256:${"9".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: sourcePath,
      fingerprint: contentId,
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Encode Investigation",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "encode-investigation",
      displayName: "Encode investigation",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: join(mediaLibraryPath, "Encode Investigation.mkv"),
    });
    const sensitiveDiagnostic =
      `${sourcePath} --preset SECRET claim-token=<unsafe>`;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const runner = createNodeHandBrakeRunner({
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from(sensitiveDiagnostic));
          child.emit("close", 17, null);
        });
        return child;
      }),
    });

    await pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
    });

    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        reasonCode: "command_failed",
        phase: "encoding",
        diagnostic: sensitiveDiagnostic,
        evidence: { kind: "exit_status", exitStatus: 17 },
      }),
    ]);
    const failedDashboard = await readDashboard(access);
    const failedJob = encodeJobById(failedDashboard.snapshot, job.id)!;
    const firstInvestigation = failedJob.investigations?.[0];
    expect(firstInvestigation).toMatchObject({
      reasonCode: "encode.command_failed",
      failedPhase: "Encoding",
      retryability: "appropriate",
      explanation: "HandBrake exited without completing the Encode Job.",
      technicalEvidence: [{ label: "Exit status", value: "17" }],
    });
    expect(failedDashboard.html).toContain("Investigate");
    expect(JSON.stringify(failedDashboard.snapshot)).not.toContain(
      sensitiveDiagnostic,
    );
    expect(JSON.stringify(failedDashboard.snapshot)).not.toContain(sourcePath);
    const firstReport = investigationReport(firstInvestigation!);
    expect(firstReport).toContain("Reason code: encode.command_failed");
    expect(firstReport).toContain("- Exit status: 17");
    expect(firstReport).not.toContain(sensitiveDiagnostic);

    access.encodeJobs.requeue(job.id);
    await pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: {
        run: vi.fn(async () => {
          throw new HandBrakeTimeoutError(
            86_400_000,
            "timeout /private/second.iso ENV=secret",
          );
        }),
      },
      signal: new AbortController().signal,
    });

    const retriedDashboard = await readDashboard(access);
    const investigations = encodeJobById(
      retriedDashboard.snapshot,
      job.id,
    )!.investigations!;
    expect(investigations).toHaveLength(2);
    expect(investigations.map(({ reasonCode }) => reasonCode)).toEqual([
      "encode.command_timeout",
      "encode.command_failed",
    ]);
    const investigationHtml = renderToStaticMarkup(
      <InvestigationPanel
        investigation={investigations[0]!}
        investigations={investigations}
        returnFocusTo={null}
        onClose={() => undefined}
      />,
    );
    expect(investigationHtml).toContain("Failure report");
    expect(investigationHtml).toContain("Latest");
    expect(investigationHtml).toContain("Older 1");
    expect(investigationHtml).toContain("encode.command_timeout");
    expect(investigationHtml).not.toContain("/private/second.iso");

    access.encodeJobs.requeue(job.id);
    await pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: {
        run: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, "completed retry", { flag: "wx" });
        }),
      },
      signal: new AbortController().signal,
    });
    const completedDashboard = await readDashboard(access);
    const completedJob = encodeJobById(completedDashboard.snapshot, job.id)!;
    expect(completedJob.status).toBe("completed");
    expect(completedJob.investigations).toHaveLength(2);
    expect(completedDashboard.html).toContain("Investigate prior failures");
    expect(JSON.stringify(completedDashboard.snapshot)).not.toContain(
      sensitiveDiagnostic,
    );

    access.encodeJobs.requeue(job.id);
    const publicationClaim = access.encodeJobs.claimNext(
      "publication-investigation-worker",
    );
    if (!publicationClaim) {
      throw new Error("Expected publication investigation claim");
    }
    const privateRecoveryDiagnostic =
      "/media/private/output.mkv claim-token=private lock=/tmp/private.lock";
    access.encodeJobs.failWithReports(
      publicationClaim,
      "Encode publication recovery failed",
      [
        {
          schemaVersion: 1,
          reasonCode: "cleanup_failed",
          phase: "cleanup",
          retryability: "after_action",
          diagnostic: privateRecoveryDiagnostic,
          evidence: { kind: "cleanup", operation: "partial_output" },
        },
        {
          schemaVersion: 1,
          reasonCode: "publication_failed",
          phase: "publication",
          retryability: "after_action",
          diagnostic: privateRecoveryDiagnostic,
          evidence: {
            kind: "publication",
            operation: "publication_completion",
          },
        },
        {
          schemaVersion: 1,
          reasonCode: "lease_expired",
          phase: "previewing",
          retryability: "after_action",
          diagnostic: privateRecoveryDiagnostic,
          evidence: { kind: "lease", scope: "job_claim" },
        },
        {
          schemaVersion: 1,
          reasonCode: "worker_interrupted",
          phase: "validation",
          retryability: "after_action",
          diagnostic: privateRecoveryDiagnostic,
          evidence: { kind: "interruption", source: "worker_shutdown" },
        },
        {
          schemaVersion: 1,
          reasonCode: "publication_recovery_failed",
          phase: "recovery",
          retryability: "after_action",
          diagnostic: privateRecoveryDiagnostic,
          evidence: {
            kind: "recovery",
            operation: "publication_recovery",
          },
        },
      ],
    );

    const classifiedDashboard = await readDashboard(access);
    const classifiedInvestigations = encodeJobById(
      classifiedDashboard.snapshot,
      job.id,
    )!.investigations!;
    expect(
      classifiedInvestigations.slice(0, 5).map(({ reasonCode }) => reasonCode),
    ).toEqual([
      "encode.publication_recovery_failed",
      "encode.worker_interrupted",
      "encode.lease_expired",
      "encode.publication_failed",
      "encode.cleanup_failed",
    ]);
    expect(classifiedInvestigations.slice(0, 5)).toEqual([
      expect.objectContaining({
        failedPhase: "Recovery",
        retryability: "after_action",
        explanation:
          "The Encode Worker could not reconcile output state left by an interrupted publication.",
        technicalEvidence: [{
          label: "Recovery operation",
          value: "Publication reconciliation",
        }],
      }),
      expect.objectContaining({
        failedPhase: "Validation",
        retryability: "after_action",
        explanation:
          "The Encode Worker stopped before the active phase reached a durable terminal state.",
      }),
      expect.objectContaining({
        failedPhase: "Previewing",
        retryability: "after_action",
        technicalEvidence: [{
          label: "Expired lease",
          value: "Encode Job claim",
        }],
      }),
      expect.objectContaining({
        failedPhase: "Publication",
        retryability: "after_action",
        technicalEvidence: [{
          label: "Publication stage",
          value: "Completion commit",
        }],
      }),
      expect.objectContaining({
        failedPhase: "Cleanup",
        retryability: "after_action",
        technicalEvidence: [{
          label: "Cleanup operation",
          value: "Partial output",
        }],
      }),
    ]);
    const classifiedPanelHtml = renderToStaticMarkup(
      <InvestigationPanel
        investigation={classifiedInvestigations[0]!}
        investigations={classifiedInvestigations}
        returnFocusTo={null}
        onClose={() => undefined}
      />,
    );
    expect(classifiedPanelHtml).toContain(
      "encode.publication_recovery_failed",
    );
    expect(JSON.stringify(classifiedDashboard.snapshot)).not.toContain(
      privateRecoveryDiagnostic,
    );
    for (const investigation of classifiedInvestigations.slice(0, 5)) {
      const copied = investigationReport(investigation);
      expect(copied).toContain("Suggested action:");
      expect(copied).not.toContain(privateRecoveryDiagnostic);
      expect(copied).not.toContain("claim-token");
      expect(copied).not.toContain("/tmp/private.lock");
    }
  });

  it("carries every preparation and validation failure through the safe dashboard workflow", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-encode-categories-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    const mediaLibraryPath = join(root, "media");
    const databasePath = join(root, "rip-dvd.sqlite");
    mkdirSync(originalsLibraryPath);
    mkdirSync(mediaLibraryPath);
    const sourcePath = join(originalsLibraryPath, "Categories.iso");
    const outputPath = join(mediaLibraryPath, "Categories.mkv");
    writeFileSync(sourcePath, "category source");
    const access = createLegacySidecarDataAccess({
      databasePath,
      mediaLibraryPath,
      originalsLibraryPath,
    });
    openAccess.push(access);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/encode-categories",
      isPresent: true,
    });
    const contentId = `sha256:${"7".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 8_078,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: sourcePath,
      fingerprint: contentId,
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Encode Categories",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "encode-categories",
      displayName: "Encode categories",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath,
    });
    const sensitiveValues = [
      sourcePath,
      outputPath,
      "/private/validation.mkv",
      "--preset SECRET",
      "ENV=private",
      "claim-token-secret",
    ];
    const runAttempt = async ({
      outputValidator,
      runner,
    }: {
      outputValidator?: {
        prepareAndValidate(
          outputPath: string,
          signal: AbortSignal,
        ): Promise<void>;
      };
      runner: HandBrakeRunner;
    }) => {
      await pollEncodeWorker({
        access,
        concurrency: 1,
        log: vi.fn(),
        mediaLibraryPath,
        originalsLibraryPath,
        ...(outputValidator === undefined ? {} : { outputValidator }),
        runner,
        signal: new AbortController().signal,
      });
    };

    rmSync(sourcePath);
    await runAttempt({ runner: { run: vi.fn() } });
    writeFileSync(sourcePath, "category source");
    access.encodeJobs.requeue(job.id);

    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare("UPDATE encoding_profiles SET settings = '{}' WHERE id = ?")
      .run(profile.id);
    sqlite.close();
    await runAttempt({ runner: { run: vi.fn() } });
    const restoredSqlite = new DatabaseSync(databasePath);
    restoredSqlite.prepare(
      "UPDATE encoding_profiles SET settings = ? WHERE id = ?",
    ).run(JSON.stringify({ preset: "Fast 480p30", container: "mkv" }), profile.id);
    restoredSqlite.close();
    access.encodeJobs.requeue(job.id);

    writeFileSync(outputPath, "competing output");
    await runAttempt({ runner: { run: vi.fn() } });
    rmSync(outputPath);
    access.encodeJobs.requeue(job.id);

    symlinkSync(sourcePath, outputPath);
    await runAttempt({ runner: { run: vi.fn() } });
    rmSync(outputPath);
    access.encodeJobs.requeue(job.id);

    await runAttempt({
      runner: {
        run: vi.fn(async ({ outputPath: partialPath }) => {
          writeFileSync(partialPath, "invalid output", { flag: "wx" });
        }),
      },
      outputValidator: {
        prepareAndValidate: vi.fn(async () => {
          throw new EncodeOutputValidationError(
            `${sensitiveValues.slice(2).join(" ")} failed bounded decode`,
            { kind: "validation_check", check: "video_decode" },
          );
        }),
      },
    });
    access.encodeJobs.requeue(job.id);

    await runAttempt({
      runner: {
        run: vi.fn(async () => {
          throw new Error(sensitiveValues.slice(2).join(" "));
        }),
      },
    });

    const dashboard = await readDashboard(access);
    const investigations = encodeJobById(
      dashboard.snapshot,
      job.id,
    )!.investigations!;
    expect(new Set(investigations.map(({ reasonCode }) => reasonCode))).toEqual(
      new Set([
        "encode.input_unavailable",
        "encode.invalid_configuration",
        "encode.output_conflict",
        "encode.unsafe_output_state",
        "encode.output_validation_failed",
        "encode.unknown_failure",
      ]),
    );
    const renderedInvestigations = investigations.map((investigation) =>
      renderToStaticMarkup(
        <InvestigationPanel
          investigation={investigation}
          investigations={investigations}
          returnFocusTo={null}
          onClose={() => undefined}
        />,
      )
    ).join("\n");
    const copiedReports = investigations.map(investigationReport).join("\n");
    const exposedText = [
      JSON.stringify(dashboard.snapshot),
      renderedInvestigations,
      copiedReports,
    ].join("\n");
    for (const sensitiveValue of sensitiveValues) {
      expect(exposedText).not.toContain(sensitiveValue);
    }
    expect(renderedInvestigations).toContain("Bounded video decode");
    expect(copiedReports).toContain("Validation check: Bounded video decode");
  });

  it("presents bounded watchable-salvage evidence after unused-space validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-salvage-workflow-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    mkdirSync(originalsLibraryPath);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
      originalsLibraryPath,
    });
    openAccess.push(access);
    const fingerprint = `dvdmeta-sha256:${"6".repeat(64)}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Salvage Optical Drive",
      serialNumber: "SALVAGE-WORKFLOW-001",
    };
    const hardware: OpticalDriveHardware = {
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      bindOpticalDrive: vi.fn(async (drive, signal) => {
        signal.throwIfAborted();
        return { deviceInstanceToken: "salvage-workflow-device", drive };
      }),
      confirmOpticalDrive: vi.fn(async (_binding, signal) => {
        signal.throwIfAborted();
      }),
      observeMedia: vi.fn().mockResolvedValue({
        mediaGeneration: "salvage-generation",
        capacityBytes: 4_096,
      }),
      observeMediaGeneration: vi.fn().mockResolvedValue("salvage-generation"),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes: 4_096,
        volumeLabel: "SALVAGE_DISC",
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
    const disc = access.catalog.listDetectedDiscs()[0]!;
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const rescuedImage = Buffer.alloc(4_096, 7);
    rescuedImage.fill(0, 2_048);

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: vi.fn(async ({ outputPath, sizeBytes }) => {
          writeFileSync(outputPath, rescuedImage);
          return createDamagedDvdRecoveryResult(sizeBytes, [
            { startLba: 1, sectorCount: 1 },
          ]);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [],
          outcome: "accepted",
        }),
      },
      signal,
      workerId: "salvage-workflow-worker",
    });

    expect(access.archiveJobs.list(["failed"])).toEqual([]);
    const dashboard = await readDashboard(access);
    expect(dashboard.html).toContain("Archive integrity: Watchable salvage");
    expect(dashboard.html).toContain(
      "Automatically accepted with 1 unreadable sector across 1 area (LBAs 1).",
    );
    expect(JSON.stringify(dashboard.snapshot)).not.toContain(
      originalsLibraryPath,
    );
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    const response = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const review = await response.json() as CatalogReviewDto;
    expect(review.archive).toMatchObject({
      integrity: "watchable_salvage",
      badSectorCount: 1,
      badAreaCount: 1,
      badSectorRanges: [{ startLba: 1, sectorCount: 1 }],
    });
    const reviewHtml = renderCatalogReview(review);
    expect(reviewHtml).toContain("Archive integrity: Watchable salvage");
    expect(reviewHtml).toContain(
      "Automatically accepted with 1 unreadable sector across 1 area (LBAs 1).",
    );
    expect(JSON.stringify(review)).not.toContain(originalsLibraryPath);
  });

  it.each([
    ["filesystem_metadata", "filesystem metadata"],
    ["directory_data", "filesystem directory data"],
    ["ifo", "DVD IFO data"],
    ["bup", "DVD backup data"],
    ["menu", "DVD menu data"],
    ["navigation", "DVD navigation data"],
    ["referenced_content", "referenced DVD content"],
    ["ambiguous", "an ambiguous DVD region"],
    ["unmappable", "an unmappable DVD region"],
    ["decoder_stream", "a missing decoded audio or video stream"],
    ["decoder_duration", "an incomplete decoded title duration"],
    [
      "decoder_rate",
      "decoding failures beyond the automatic salvage policy limit",
    ],
    ["decoder_incomplete", "incomplete DVD title traversal"],
  ] as const)(
    "presents path-free retained-salvage evidence after %s rejection",
    async (reason, description) => {
      const root = mkdtempSync(join(tmpdir(), "rip-dvd-salvage-rejected-"));
      temporaryDirectories.push(root);
      const originalsLibraryPath = join(root, "originals");
      mkdirSync(originalsLibraryPath);
      const access = createLegacySidecarDataAccess({
        databasePath: join(root, "rip-dvd.sqlite"),
        originalsLibraryPath,
      });
      openAccess.push(access);
      const fingerprint = `dvdmeta-sha256:${"7".repeat(64)}`;
      const scanData = {
        schemaVersion: 2 as const,
        contentId: fingerprint,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      };
      const discoveredDrive = {
        devicePath: "/dev/sr0",
        displayName: "Rejected Salvage Drive",
        serialNumber: "SALVAGE-REJECTED-001",
      };
      const hardware: OpticalDriveHardware = {
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        bindOpticalDrive: vi.fn(async (drive, signal) => {
          signal.throwIfAborted();
          return { deviceInstanceToken: "salvage-rejected-device", drive };
        }),
        confirmOpticalDrive: vi.fn(async (_binding, signal) => {
          signal.throwIfAborted();
        }),
        observeMedia: vi.fn().mockResolvedValue({
          mediaGeneration: "salvage-rejected-generation",
          capacityBytes: 4_096,
        }),
        observeMediaGeneration: vi.fn().mockResolvedValue(
          "salvage-rejected-generation",
        ),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes: 4_096,
          volumeLabel: "REJECTED_SALVAGE",
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
      const disc = access.catalog.listDetectedDiscs()[0]!;
      const request = access.archiveRequests.create({
        detectedDiscId: disc.id,
      });
      const rescuedImage = Buffer.alloc(4_096, 0);
      let rescuedPartialPath: string | undefined;

      await pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        copyRunner: {
          copy: vi.fn(async ({ outputPath, sizeBytes }) => {
            rescuedPartialPath = outputPath;
            writeFileSync(outputPath, rescuedImage);
            return createDamagedDvdRecoveryResult(sizeBytes, [
              { startLba: 1, sectorCount: 1 },
            ]);
          }),
          isActive: () => false,
          withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
          waitForInactive: vi.fn(async () => undefined),
        },
        hardware,
        log: vi.fn(),
        originalsLibraryPath,
        salvageValidator: {
          validate: vi.fn().mockResolvedValue({ outcome: "rejected", reason }),
        },
        signal,
        workerId: `salvage-rejected-${reason}`,
      });

      expect(access.archiveRequests.list(["needs_attention"])).toEqual([
        expect.objectContaining({ id: request.id }),
      ]);
      expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
      const rescuePaths = dvdRescueWorkspacePaths(
        realpathSync(originalsLibraryPath),
        request.id,
      );
      expect(existsSync(rescuedPartialPath!)).toBe(false);
      expect(existsSync(`${rescuedPartialPath}.failed`)).toBe(false);
      expect(readFileSync(rescuePaths.imagePath)).toEqual(rescuedImage);
      expect(existsSync(rescuePaths.mapPath)).toBe(true);
      const dashboard = await readDashboard(access);
      expect(dashboard.html).toContain(
        `Automatic salvage validation rejected damage to ${description}`,
      );
      expect(JSON.stringify(dashboard.snapshot)).not.toContain(
        originalsLibraryPath,
      );
    },
  );

  it("reopens review and reports resulting coverage after an episodic batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-episodic-workflow-"));
    temporaryDirectories.push(root);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
    });
    openAccess.push(access);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"d".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "EPISODIC_WORKFLOW",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [1, 3, 5].map((number) => ({
          number,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Episodic Workflow.iso",
      fingerprint: contentId,
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Workflow Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Workflow Show Season 1",
      seasonNumber: 1,
    });
    const existingEpisode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Episode 1",
      episodeNumber: 1,
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: existingEpisode.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    const reviewRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    access.catalog.completeCatalogReview(
      archive.id,
      reviewRevision,
      "reviewed_with_selections",
    );
    const reviewedArchive = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!;

    const response = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "create_episodic_mapping_proposal",
        catalogRevision: reviewedArchive.updatedAt.toISOString(),
        tvShow: { choice: "use_existing", mediaItemId: show.id },
        season: { choice: "use_existing", mediaItemId: season.id },
        episodes: [
          { titleNumber: 3, title: "Episode 2", episodeNumber: 2 },
          { titleNumber: 5, title: "Episode 3", episodeNumber: 3 },
        ],
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      message: "Mapping changed; review required",
    });
    expect(access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.catalogReviewedAt).toBeNull();
    const refreshedResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as CatalogReviewDto;
    expect(refreshed.reviewOutcome).toBe("needs_review");
    expect(refreshed.coverage).toMatchObject({
      discSelectionCount: 3,
      mediaItemsWithSelections: 3,
      mappedTitles: 3,
      partiallyMappedTitles: 0,
      unmappedTitles: 0,
    });
    expect(refreshed.mediaItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: show.id }),
      expect.objectContaining({ id: season.id }),
      expect.objectContaining({ title: "Episode 2", episodeNumber: 2 }),
      expect.objectContaining({ title: "Episode 3", episodeNumber: 3 }),
    ]));
    const html = renderCatalogReview(refreshed);
    expect(html).toContain("3 Media Items with Disc Selections");
    expect(html).toContain("3 mapped titles");
  });

  it("preserves a job-free Disc Selection edit and reopens only its archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-job-free-edit-"));
    temporaryDirectories.push(root);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
    });
    openAccess.push(access);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/job-free-edit",
      isPresent: true,
    });
    const contentId = `sha256:${"d".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "JOB_FREE_EDIT",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Job Free Edit.iso",
      fingerprint: contentId,
    });
    const originalItem = access.catalog.createMediaItem({
      kind: "episode",
      title: "Original episode",
      episodeNumber: 1,
    });
    const correctedItem = access.catalog.createMediaItem({
      kind: "episode",
      title: "Corrected episode",
      episodeNumber: 2,
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: originalItem.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 2,
        chapterEnd: 5,
      },
      label: "Director's cut",
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );

    const otherDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "unrelated-reviewed-archive",
    });
    access.catalog.updateDetectedDiscStatus(otherDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(otherDisc.id, "approved");
    const otherArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: otherDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Other Reviewed Archive.iso",
      fingerprint: "unrelated-reviewed-archive",
    });
    const otherItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Other reviewed movie",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: otherArchive.id,
      mediaItemId: otherItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      otherArchive.id,
      access.catalog.listOriginalDiscArchives({ ids: [otherArchive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );

    const readReview = async () => {
      const response = await createCatalogReviewRoute(
        new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
        archive.id,
        () => access,
        () => trustedOrigin,
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<CatalogReviewDto>;
    };
    const initialReview = await readReview();
    expect(renderCatalogReview(initialReview)).toContain(
      "Label: Director&#x27;s cut",
    );

    const invalid = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "update_disc_selection",
        discSelectionId: selection.id,
        changes: { label: "   " },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(invalid.status).toBe(400);
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({ catalogReviewOutcome: "reviewed_with_selections" });

    const updated = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "update_disc_selection",
        discSelectionId: selection.id,
        changes: { mediaItemId: correctedItem.id },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({
      message: "Mapping changed; review required",
      discSelection: {
        id: selection.id,
        mediaItemId: correctedItem.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 2,
          chapterEnd: 5,
        },
        label: "Director's cut",
      },
    });
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        catalogReviewOutcome: "needs_review",
        catalogReviewedAt: null,
      });
    expect(access.catalog.listOriginalDiscArchives({ ids: [otherArchive.id] })[0])
      .toMatchObject({
        catalogReviewOutcome: "reviewed_with_selections",
        catalogReviewedAt: expect.any(Date),
      });

    const cleared = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "update_disc_selection",
        discSelectionId: selection.id,
        changes: { label: null },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(cleared.status).toBe(200);
    const finalReview = await readReview();
    expect(finalReview.discSelections).toEqual([
      expect.objectContaining({
        id: selection.id,
        mediaItemId: correctedItem.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 2,
          chapterEnd: 5,
        },
        label: null,
      }),
    ]);

    const wholeTarget = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    const wholeEditable = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const rangeEditable = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 6,
        chapterEnd: 8,
      },
    });
    for (const [discSelectionId, sourceIdentity] of [
      [wholeEditable.id, wholeTarget.sourceIdentity],
      [rangeEditable.id, selection.sourceIdentity],
    ] as const) {
      const overlapUpdate = await createCatalogReviewRoute(
        createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
          action: "update_disc_selection",
          discSelectionId,
          changes: { sourceIdentity },
        }),
        archive.id,
        () => access,
        () => trustedOrigin,
      );
      expect(overlapUpdate.status).toBe(200);
    }
    const overlapReview = await readReview();
    expect(overlapReview.discSelections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: wholeEditable.id,
        sourceIdentity: wholeTarget.sourceIdentity,
      }),
      expect.objectContaining({
        id: rangeEditable.id,
        sourceIdentity: selection.sourceIdentity,
      }),
    ]));
    expect(renderCatalogReview(overlapReview)).toContain(
      "Overlapping Disc Selections",
    );
  });

  it("saves a running Disc Selection Correction before cancellation finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-running-correction-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    const mediaLibraryPath = join(root, "media");
    mkdirSync(originalsLibraryPath);
    mkdirSync(mediaLibraryPath);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
      mediaLibraryPath,
      originalsLibraryPath,
    });
    openAccess.push(access);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/running-correction",
      isPresent: true,
    });
    const contentId = `sha256:${"e".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 5_400,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: join(originalsLibraryPath, "Running Correction.iso"),
      fingerprint: contentId,
    });
    writeFileSync(archive.archivePath, "running correction source");
    const mistakenItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Running Correction Mistake",
    });
    const correctedItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Running Correction Target",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mistakenItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "running-correction",
      displayName: "Running correction",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: join(mediaLibraryPath, "Running Correction.mkv"),
    });
    const workerGate = createGate();
    const runner: HandBrakeRunner = {
      async run({ outputPath }) {
        writeFileSync(outputPath, "running correction partial", { flag: "wx" });
        await workerGate.wait();
      },
    };
    let workerSettled = false;
    const workerPoll = pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      workerId: "running-correction-worker",
    }).finally(() => {
      workerSettled = true;
    });
    await workerGate.entered;
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "running" }),
    ]);

    const response = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "correct_disc_selection",
        discSelectionId: selection.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt.toISOString(),
        correctionReason: "The running encode uses the wrong mapping.",
        selection: {
          mediaItemId: correctedItem.id,
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      message: "Mapping changed; review required",
      supersession: {
        supersededDiscSelectionId: selection.id,
        reason: "The running encode uses the wrong mapping.",
      },
    });
    expect(workerSettled).toBe(false);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        discSelectionId: selection.id,
        status: "cancellation_requested",
      }),
    ]);
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        catalogReviewOutcome: "needs_review",
        catalogReviewedAt: null,
      });

    const reviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(reviewResponse.status).toBe(200);
    const review = await reviewResponse.json() as CatalogReviewDto;
    expect(review.replacementPlan).toEqual({
      jobs: [{
        predecessorEncodeJobId: job.id,
        predecessorStatus: "cancellation_requested",
        predecessorReady: false,
        replacementDiscSelectionId: expect.any(String),
        proposedEncodingProfileId: profile.id,
        proposedOutputPath: job.outputPath,
      }],
      encodingProfiles: [{
        id: profile.id,
        displayName: profile.displayName,
        version: profile.version,
        isActive: true,
      }],
      jobsPage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
      encodingProfilesPage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
    });
    const reviewHtml = renderCatalogReview(review);
    expect(reviewHtml).toContain("Queue corrected replacement");
    expect(reviewHtml).toContain("Waiting for previous encode to stop");
    expect(reviewHtml).toContain(`value="${profile.id}" selected`);
    expect(reviewHtml).toContain(`value="${job.outputPath}"`);
    expect(reviewHtml).not.toContain(
      `name="replacement:${job.id}:selected" checked`,
    );

    const events = createDashboardEventReader(access);
    await events.next((snapshot) =>
      encodeJobById(snapshot, job.id)?.status === "cancellation_requested"
    );
    const completionResponse = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "complete_review",
        catalogRevision: review.catalogRevision,
        outcome: "reviewed_with_selections",
        replacementEncodes: [{
          predecessorEncodeJobId: job.id,
          encodingProfileId: profile.id,
          outputPath: job.outputPath,
        }],
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
      () => mediaLibraryPath,
    );
    expect(completionResponse.status).toBe(200);
    const completion = await completionResponse.json() as {
      archive: { catalogReviewOutcome: string };
      replacementEncodeJobs: Array<{ id: string }>;
    };
    expect(completion.archive.catalogReviewOutcome).toBe(
      "reviewed_with_selections",
    );
    const replacementJobId = completion.replacementEncodeJobs[0]!.id;
    const waitingSnapshot = await events.next((snapshot) => {
      const predecessor = encodeJobById(snapshot, job.id);
      const replacement = encodeJobById(snapshot, replacementJobId);
      return predecessor?.correctedReplacement?.successorId ===
        replacementJobId &&
        replacement?.correctedReplacement?.predecessorId === job.id;
    });
    const waitingHtml = renderToStaticMarkup(
      <DashboardView state={waitingSnapshot} />,
    );
    expect(waitingHtml).toContain(`Replacement Encode Job ${replacementJobId}`);
    expect(waitingHtml).toContain(`Replaces Encode Job ${job.id}`);
    expect(waitingHtml).toContain("Waiting for previous encode to stop");

    workerGate.release();
    await workerPoll;
    const readySnapshot = await events.next((snapshot) => {
      const predecessor = encodeJobById(snapshot, job.id);
      const replacement = encodeJobById(snapshot, replacementJobId);
      return predecessor?.status === "cancelled" &&
        replacement?.status === "completed";
    });
    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: job.id,
        discSelectionId: selection.id,
        status: "cancelled",
      }),
      expect.objectContaining({
        id: replacementJobId,
        predecessorEncodeJobId: job.id,
        status: "completed",
      }),
    ]));
    const readyHtml = renderToStaticMarkup(
      <DashboardView state={readySnapshot} />,
    );
    expect(readyHtml).toContain(`Replaces Encode Job ${job.id}`);
    expect(readyHtml).not.toContain("Waiting for corrected publication support");
    await events.close();
  });

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
          audioStreams: [{
            id: 128,
            language: "English",
            format: "AC3",
            channels: 6,
          }],
          subtitles: [{
            id: 32,
            language: "English",
            content: "Normal",
          }],
        },
        {
          number: 2,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 3,
          durationSeconds: 1_800,
          chapters: 6,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 4,
          durationSeconds: 300,
          chapters: 2,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 5,
          durationSeconds: 119,
          chapters: 1,
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
      observeMedia: vi.fn().mockResolvedValue({
        mediaGeneration: "workflow-generation",
        capacityBytes: 2_048,
      }),
      observeMediaGeneration: vi.fn().mockResolvedValue("workflow-generation"),
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
    expect(discoveredDashboard.html).toContain("Request archive");
    const detectedDisc = access.catalog.listDetectedDiscs()[0]!;

    const approval = await createArchiveRequestsRoute(
      createMutationRequest("/api/archive-requests", {
        detectedDiscId: detectedDisc.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    expect(approval.status).toBe(201);
    expect((await approval.json()).archiveRequest).toMatchObject({ status: "pending" });
    const queuedArchiveDashboard = await readDashboard(access);
    expect(queuedArchiveDashboard.snapshot.archiveJobs).toEqual({
      status: "loaded",
      items: [],
    });
    expect(queuedArchiveDashboard.html).toContain("Waiting for this disc");

    const archiveGate = createGate();
    const copyRunner: DvdCopyRunner = {
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
      async copy({ outputPath, onBytesCopied, sizeBytes }) {
        onBytesCopied(4);
        await archiveGate.wait();
        writeFileSync(outputPath, "dvd-image", { flag: "wx" });
        onBytesCopied(9);
        return createCleanDvdRecoveryResult(sizeBytes);
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
    expect(completedArchiveDashboard.html).toContain(
      "Archive integrity: Clean read",
    );
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      integrity: "clean_read",
      integrityPolicyVersion: "dvd-recovery-v1",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    });
    expect(existsSync(archive.archivePath)).toBe(true);
    const unrelatedMediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Unrelated Global Noise",
    });
    const existingShow = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Existing Workflow Show",
    });
    const existingSeason = access.catalog.createMediaItem({
      parentId: existingShow.id,
      kind: "season",
      title: "Season 1",
      seasonNumber: 1,
    });
    const existingEpisode = access.catalog.createMediaItem({
      parentId: existingSeason.id,
      kind: "episode",
      title: "Workflow Movie",
      episodeNumber: 1,
    });

    const catalogReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(catalogReviewResponse.status).toBe(200);
    const catalogReview = await catalogReviewResponse.json() as
      CatalogReviewDto;
    expect(catalogReview.archive.integrity).toBe("clean_read");
    expect(JSON.stringify(catalogReview)).not.toContain(archive.archivePath);
    expect(JSON.stringify(catalogReview)).not.toContain(originalsLibraryPath);
    expect(catalogReview.mediaItems).toEqual([]);
    const catalogReviewHtml = renderCatalogReview(catalogReview);
    expect(catalogReviewHtml).toContain("Catalog Workflow Disc");
    expect(catalogReviewHtml).toContain("Archive integrity: Clean read");
    expect(catalogReviewHtml).toContain("Original volume label");
    expect(catalogReviewHtml).toContain("WORKFLOW_DISC");
    expect(catalogReviewHtml).toContain("1h 35m 11s");
    expect(catalogReviewHtml).toContain("12 chapters");
    expect(catalogReviewHtml).toContain("Audio: English");
    expect(catalogReviewHtml).toContain("Subtitles: English");
    expect(catalogReviewHtml).toContain("Feature-length candidate");
    expect(catalogReviewHtml).toContain("Very short or menu candidate");
    expect(catalogReviewHtml).toContain("Longest title");
    expect(catalogReviewHtml).toContain("Technical stream details");
    expect(catalogReviewHtml).toContain("Audio stream 0x80");
    expect(catalogReviewHtml).toContain("Subtitle stream 0x20");
    expect(catalogReviewHtml).toContain("Map DVD main feature");
    expect(catalogReviewHtml).toContain(
      '<button type="button">Map DVD main feature</button>',
    );
    expect(catalogReviewHtml).toContain(
      "HandBrake resolves the source during encode",
    );
    expect(catalogReviewHtml).toContain("Map as movie");
    expect(catalogReviewHtml).toContain("Map as bonus feature");
    expect(catalogReviewHtml).toContain("Map as trailer");
    expect(catalogReviewHtml).toContain("Map to existing Media Item");
    expect(catalogReviewHtml).toContain("Map chapters");
    expect(catalogReviewHtml).toContain("Map as other");
    expect(catalogReviewHtml).not.toContain("Unrelated Global Noise");
    expect(catalogReviewHtml).not.toContain("Existing Workflow Show");
    const directReuseProposalHtml = renderCatalogReview(catalogReview, {
      action: "existing_media_item",
      sourceIdentity: { kind: "dvd_title", titleNumber: 5 },
    });
    expect(directReuseProposalHtml).toContain("exact whole Title 5");
    expect(directReuseProposalHtml).toMatch(
      /name="mappingTargetChoice" checked="" value="use_existing"/,
    );
    expect(directReuseProposalHtml).not.toMatch(
      /name="mappingTargetChoice" checked="" value="create_new"/,
    );
    expect(directReuseProposalHtml).not.toContain(
      'name="existingMediaItemId"',
    );

    const mediaItemSearchResponse = await createMediaItemSearchRoute(
      new Request(
        `${trustedOrigin}/api/media-items?query=Workflow%20Movie&offset=0`,
      ),
      () => access,
    );
    expect(mediaItemSearchResponse.status).toBe(200);
    expect(mediaItemSearchResponse.headers.get("Cache-Control")).toBe(
      "no-store",
    );
    await expect(mediaItemSearchResponse.json()).resolves.toEqual({
      results: [{
        mediaItem: expect.objectContaining({ id: existingEpisode.id }),
        ancestors: [
          expect.objectContaining({ id: existingShow.id }),
          expect.objectContaining({ id: existingSeason.id }),
        ],
        maintenance: {
          childCount: 0,
          discSelectionReferenceCount: 0,
          referencedArchiveCount: 0,
          otherArchiveCount: 0,
          deletionAvailability: { state: "available", reason: null },
        },
        suggestion: "exact",
      }],
      page: {
        offset: 0,
        limit: 20,
        hasPrevious: false,
        hasNext: false,
      },
    });
    expect(catalogReviewHtml).toContain("Archive only");

    const catalogMutation = (body: unknown) =>
      createCatalogReviewRoute(
        createMutationRequest(`/api/catalog-reviews/${archive.id}`, body),
        archive.id,
        () => access,
        () => trustedOrigin,
      );
    const archiveOnlyCompletion = await catalogMutation({
      action: "complete_review",
      catalogRevision: catalogReview.catalogRevision,
      outcome: "archive_only",
    });
    expect(archiveOnlyCompletion.status).toBe(200);
    await expect(archiveOnlyCompletion.json()).resolves.toEqual({
      archive: {
        id: archive.id,
        catalogReviewedAt: expect.any(String),
        catalogReviewOutcome: "archive_only",
      },
    });
    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .toEqual([]);
    const archiveOnlyDashboard = await readDashboard(access);
    expect(archiveOnlyDashboard.snapshot.catalogReview).toEqual({
      status: "loaded",
      items: [],
    });
    const archiveOnlyReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const archiveOnlyReview = await archiveOnlyReviewResponse.json() as
      CatalogReviewDto;
    expect(archiveOnlyReview.reviewOutcome).toBe("archive_only");
    expect(renderCatalogReview(archiveOnlyReview)).toContain("Archive only");

    const failedProposal = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: archiveOnlyReview.catalogRevision,
      target: {
        choice: "create_new",
        mediaItem: { kind: "movie", title: "Orphaned Workflow Movie" },
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 99 },
      },
    });
    expect(failedProposal.status).toBe(409);
    expect(access.catalog.listMediaItems()).toHaveLength(4);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([]);

    const proposalResponse = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: archiveOnlyReview.catalogRevision,
      target: {
        choice: "create_new",
        mediaItem: { kind: "movie", title: "Workflow Movie", year: 2001 },
      },
      discSelection: {
        label: "Exact archived title",
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    });
    expect(proposalResponse.status).toBe(201);
    const proposal = await proposalResponse.json() as {
      mediaItem: { id: string };
      discSelection: { id: string };
    };
    const selection = proposal.discSelection;
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(proposal.mediaItem.id).not.toBe(existingEpisode.id);
    expect(access.catalog.listMediaItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: proposal.mediaItem.id,
        title: "Workflow Movie",
      }),
      expect.objectContaining({ id: existingEpisode.id }),
    ]));
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([
      expect.objectContaining({
        id: selection.id,
        mediaItemId: proposal.mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        label: "Exact archived title",
      }),
    ]);

    const refreshedReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const refreshedReview = await refreshedReviewResponse.json() as
      CatalogReviewDto;
    expect(refreshedReview.catalogRevision).not.toBe(
      archiveOnlyReview.catalogRevision,
    );
    expect(refreshedReview.reviewOutcome).toBe("needs_review");
    expect(refreshedReview.mediaItems).toEqual([
      expect.objectContaining({ id: proposal.mediaItem.id }),
    ]);
    expect(refreshedReview.discSelections).toEqual([
      expect.objectContaining({
        id: selection.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
    ]);

    const mainFeatureResponse = await catalogMutation({
      action: "create_disc_selection",
      selection: {
        label: "Main feature",
        mediaItemId: proposal.mediaItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    });
    expect(mainFeatureResponse.status).toBe(201);
    const manualSelections = [
      {
        mediaItemId: existingEpisode.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
      ...[
        {
          mediaItemId: proposal.mediaItem.id,
          sourceIdentity: {
            kind: "dvd_chapters" as const,
            titleNumber: 2,
            chapterStart: 1,
            chapterEnd: 3,
          },
        },
        {
          mediaItemId: existingEpisode.id,
          sourceIdentity: {
            kind: "dvd_chapters" as const,
            titleNumber: 2,
            chapterStart: 1,
            chapterEnd: 3,
          },
        },
        {
          mediaItemId: proposal.mediaItem.id,
          sourceIdentity: {
            kind: "dvd_chapters" as const,
            titleNumber: 2,
            chapterStart: 3,
            chapterEnd: 5,
          },
        },
        {
          mediaItemId: proposal.mediaItem.id,
          sourceIdentity: {
            kind: "dvd_chapters" as const,
            titleNumber: 3,
            chapterStart: 1,
            chapterEnd: 3,
          },
        },
        {
          mediaItemId: proposal.mediaItem.id,
          sourceIdentity: {
            kind: "dvd_chapters" as const,
            titleNumber: 3,
            chapterStart: 4,
            chapterEnd: 6,
          },
        },
      ],
    ] as const;
    for (const { mediaItemId, sourceIdentity } of manualSelections) {
      const response = await catalogMutation({
        action: "create_disc_selection",
        selection: { mediaItemId, sourceIdentity },
      });
      expect(response.status).toBe(201);
    }

    const coveredReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(coveredReviewResponse.status).toBe(200);
    const coveredReview = await coveredReviewResponse.json() as
      CatalogReviewDto;
    expect(coveredReview.coverage).toEqual({
      discSelectionCount: 8,
      mediaItemsWithSelections: 2,
      mappedTitles: 2,
      partiallyMappedTitles: 1,
      unmappedTitles: 2,
      mainFeatureSelections: 1,
      titles: [
        {
          titleNumber: 1,
          status: "mapped",
          hasOverlap: true,
        },
        {
          titleNumber: 2,
          status: "partially_mapped",
          hasOverlap: true,
        },
        {
          titleNumber: 3,
          status: "mapped",
          hasOverlap: false,
        },
        {
          titleNumber: 4,
          status: "unmapped",
          hasOverlap: false,
        },
        {
          titleNumber: 5,
          status: "unmapped",
          hasOverlap: false,
        },
      ],
    });
    const coveredReviewHtml = renderCatalogReview(coveredReview);
    expect(coveredReviewHtml).toContain("2 Media Items with Disc Selections");
    expect(coveredReviewHtml).toContain("2 mapped titles");
    expect(coveredReviewHtml).toContain("1 partially mapped title");
    expect(coveredReviewHtml).toContain("2 unmapped titles");
    expect(coveredReviewHtml).toContain("1 main-feature selection");
    expect(coveredReviewHtml).toContain(
      '<button type="button" disabled="">Map DVD main feature</button>',
    );
    expect(coveredReviewHtml).toContain(
      "already has an active main-feature Disc Selection",
    );
    expect(coveredReviewHtml).toContain("Overlapping Disc Selections");
    expect(coveredReviewHtml).toContain("counted once and remain valid");
    expect(coveredReviewHtml).toContain("1 very-short unmapped title");
    expect(coveredReviewHtml).not.toContain('<details open=""');
    const completedReview = await catalogMutation({
      action: "complete_review",
      catalogRevision: coveredReview.catalogRevision,
      outcome: "reviewed_with_selections",
    });
    expect(completedReview.status).toBe(200);
    expect((await completedReview.json()).archive.catalogReviewedAt).toEqual(
      expect.any(String),
    );

    const reviewedRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt.toISOString();
    const additionalProposal = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: reviewedRevision,
      target: {
        choice: "use_existing",
        mediaItemId: existingEpisode.id,
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 5 },
      },
    });
    expect(additionalProposal.status).toBe(201);
    await expect(additionalProposal.json()).resolves.toMatchObject({
      mediaItem: { id: existingEpisode.id },
      discSelection: { mediaItemId: existingEpisode.id },
    });
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.catalogReviewedAt).toBeNull();
    const refreshedCoverageResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const refreshedCoverage = await refreshedCoverageResponse.json() as
      CatalogReviewDto;
    expect(refreshedCoverage.discSelections).toHaveLength(9);
    expect(refreshedCoverage.coverage).toMatchObject({
      discSelectionCount: 9,
      mediaItemsWithSelections: 2,
      mappedTitles: 3,
      partiallyMappedTitles: 1,
      unmappedTitles: 1,
      mainFeatureSelections: 1,
    });
    expect(refreshedCoverage.coverage.titles).toContainEqual({
      titleNumber: 2,
      status: "partially_mapped",
      hasOverlap: true,
    });
    expect(refreshedCoverage.coverage.titles).toContainEqual({
      titleNumber: 5,
      status: "mapped",
      hasOverlap: false,
    });
    const refreshedCoverageHtml = renderCatalogReview(refreshedCoverage);
    expect(refreshedCoverageHtml).toContain(
      "2 Media Items with Disc Selections",
    );
    expect(refreshedCoverageHtml).toContain("3 mapped titles");
    expect(refreshedCoverageHtml).toContain("1 partially mapped title");
    expect(refreshedCoverageHtml).toContain("1 unmapped title");
    expect(refreshedCoverage.mediaItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: proposal.mediaItem.id }),
      expect.objectContaining({ id: existingShow.id }),
      expect.objectContaining({ id: existingSeason.id }),
      expect.objectContaining({ id: existingEpisode.id }),
    ]));
    expect(refreshedCoverage.mediaItems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unrelatedMediaItem.id }),
    ]));
    expect((await catalogMutation({
      action: "complete_review",
      catalogRevision: refreshedCoverage.catalogRevision,
      outcome: "reviewed_with_selections",
    })).status).toBe(200);

    const reviewedDiscovery = (await createDashboardResponse(
      access,
      undefined,
      {
        view: "reviewed",
        query: "workflow disc",
        outcome: "reviewed_with_selections",
      },
    ).json()) as DashboardSnapshot;
    expect(reviewedDiscovery.catalogReview).toEqual(expect.objectContaining({
      status: "loaded",
      items: [expect.objectContaining({
        id: archive.id,
        discLabel: "WORKFLOW_DISC",
        catalogReviewedAt: expect.any(String),
        catalogReviewOutcome: "reviewed_with_selections",
        mappedMediaItemCount: 2,
        mappedMediaItemTitles: ["Workflow Movie"],
      })],
    }));
    const reviewedDiscoveryHtml = renderToStaticMarkup(
      <DashboardView
        state={reviewedDiscovery}
        section="catalog"
        catalogReviewView="reviewed"
        catalogReviewQuery="workflow disc"
        catalogReviewOutcome="reviewed_with_selections"
      />,
    );
    expect(reviewedDiscoveryHtml).toContain("Reviewed with selections");
    expect(reviewedDiscoveryHtml).toContain("Open review");
    expect(reviewedDiscoveryHtml).toContain("Workflow Movie");
    const reopenedReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(reopenedReviewResponse.status).toBe(200);
    expect(renderCatalogReview(
      await reopenedReviewResponse.json() as CatalogReviewDto,
    )).toContain("Technical stream details");

    const sharedFingerprint = "workflow-shared-media-item";
    const sharedDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: detectedDisc.opticalDriveId,
      discKind: "dvd",
      fingerprint: sharedFingerprint,
      volumeLabel: "SHARED_WORKFLOW_DISC",
    });
    access.catalog.updateDetectedDiscStatus(sharedDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(sharedDisc.id, "approved");
    const sharedArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: sharedDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: join(originalsLibraryPath, "Shared Workflow Disc.iso"),
      fingerprint: sharedFingerprint,
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: sharedArchive.id,
      mediaItemId: proposal.mediaItem.id as MediaItemId,
      sourceIdentity: { kind: "main_feature" },
    });
    const sharedRevision = access.catalog.listOriginalDiscArchives({
      ids: [sharedArchive.id],
    })[0]!.updatedAt;
    access.catalog.completeCatalogReview(
      sharedArchive.id,
      sharedRevision,
      "reviewed_with_selections",
    );
    const reviewedBeforeMetadata = access.catalog.listOriginalDiscArchives({
      ids: [archive.id, sharedArchive.id],
    }).map((candidate) => [
      candidate.id,
      candidate.catalogReviewedAt?.toISOString(),
    ]);

    const sharedReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const sharedReview = await sharedReviewResponse.json() as CatalogReviewDto;
    expect(sharedReview.mediaItems.find(
      (item) => item.id === proposal.mediaItem.id,
    )?.maintenance).toMatchObject({
      otherArchiveCount: 1,
      deletionAvailability: { state: "unavailable" },
    });

    const metadataResponse = await catalogMutation({
      action: "update_media_item",
      mediaItemId: proposal.mediaItem.id,
      changes: { title: "Corrected Workflow Movie" },
    });
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      message: "Metadata saved",
      mediaItem: { title: "Corrected Workflow Movie" },
    });
    expect(access.catalog.listOriginalDiscArchives({
      ids: [archive.id, sharedArchive.id],
    }).map((candidate) => [
      candidate.id,
      candidate.catalogReviewedAt?.toISOString(),
    ])).toEqual(reviewedBeforeMetadata);

    const unavailableDeletion = await catalogMutation({
      action: "delete_media_item",
      mediaItemId: proposal.mediaItem.id,
    });
    expect(unavailableDeletion.status).toBe(409);
    const unavailableDeletionBody = await unavailableDeletion.json() as {
      error: string;
    };
    expect(unavailableDeletionBody.error).toMatch(
      /^Media Item deletion is unavailable: \d+ Disc Selection references$/,
    );
    expect(unavailableDeletionBody.error).not.toContain(originalsLibraryPath);

    const mistakenProposalResponse = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt.toISOString(),
      target: {
        choice: "create_new",
        mediaItem: {
          parentId: proposal.mediaItem.id,
          kind: "bonus_feature",
          title: "Mistaken Assisted Mapping",
        },
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
      },
    });
    expect(mistakenProposalResponse.status).toBe(201);
    const mistakenProposal = await mistakenProposalResponse.json() as {
      mediaItem: { id: string };
      discSelection: { id: string };
    };
    const removeMistakenSelection = await catalogMutation({
      action: "delete_disc_selection",
      discSelectionId: mistakenProposal.discSelection.id,
    });
    await expect(removeMistakenSelection.json()).resolves.toMatchObject({
      message: "Mapping changed; review required",
    });
    const reviewStatesAfterMappingChange = new Map(
      access.catalog.listOriginalDiscArchives({
        ids: [archive.id, sharedArchive.id],
      }).map((candidate) => [candidate.id, candidate.catalogReviewedAt]),
    );
    expect(reviewStatesAfterMappingChange.get(archive.id)).toBeNull();
    expect(reviewStatesAfterMappingChange.get(sharedArchive.id))
      .toEqual(expect.any(Date));
    const profile = access.encodingProfiles.create({
      key: "workflow-dvd",
      displayName: "Workflow DVD",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const runtimeConfig = () => ({
      mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const pendingQueueOptions = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`),
      () => access,
      runtimeConfig,
    );
    expect((await pendingQueueOptions.json() as {
      selections: Array<{ id: string }>;
    }).selections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: selection.id }),
    ]));
    const deleteMistakenItem = await catalogMutation({
      action: "delete_media_item",
      mediaItemId: mistakenProposal.mediaItem.id,
    });
    expect(deleteMistakenItem.status).toBe(200);
    await expect(deleteMistakenItem.json()).resolves.toMatchObject({
      message: "Media Item deleted",
    });
    expect(access.catalog.listMediaItems({
      ids: [mistakenProposal.mediaItem.id as MediaItemId],
    })).toEqual([]);
    expect((await catalogMutation({
      action: "complete_review",
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt.toISOString(),
      outcome: "reviewed_with_selections",
    })).status).toBe(200);

    const queueOptions = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`),
      () => access,
      runtimeConfig,
    );
    expect(await queueOptions.json()).toEqual(expect.objectContaining({
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: profile.id }),
      ]),
      selections: expect.arrayContaining([
        expect.objectContaining({ id: selection.id }),
      ]),
    }));

    const outputPath = join(mediaLibraryPath, "Workflow Movie (2001).mkv");
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
      mediaTitle: "Corrected Workflow Movie",
      status: "queued",
    });
    expect(
      renderToStaticMarkup(<DashboardView state={queuedEncodeSnapshot} />),
    ).toContain("Cancel queued encode");

    const cancelResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "cancel",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "cancelled",
    });
    const cancelledEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "cancelled",
    );
    const cancelledHtml = renderToStaticMarkup(
      <DashboardView state={cancelledEncodeSnapshot} />,
    );
    expect(cancelledHtml).toContain("Cancelled");
    expect(cancelledHtml).toContain("Requeue encode");
    expect(cancelledHtml).not.toContain("Worker reported a failure");

    const cancelledRequeueResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "requeue",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(cancelledRequeueResponse.status).toBe(200);
    expect((await cancelledRequeueResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "queued",
    });
    await events.next((snapshot) => encodeJob(snapshot).status === "queued");

    const cancellationGate = createGate();
    const cancellableRunner: HandBrakeRunner = {
      async run({ onOutput, outputPath: partialPath }) {
        writeFileSync(partialPath, "cancelled workflow partial", {
          flag: "wx",
        });
        onOutput(
          "Encoding: task 1 of 1, 21.00 % (128.00 fps, avg 90.00 fps, ETA 0h09m00s)\r",
        );
        await cancellationGate.wait();
        onOutput("Encoding: task 1 of 1, 22.00 %\r");
      },
    };
    const cancellationPoll = pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: cancellableRunner,
      signal,
      workerId: "workflow-encode-worker-cancellation",
    });
    await cancellationGate.entered;
    const cancellableSnapshot = await events.next(
      (snapshot) =>
        encodeJob(snapshot).status === "running" &&
        encodeJob(snapshot).progressPercent === 21,
    );
    expect(
      renderToStaticMarkup(<DashboardView state={cancellableSnapshot} />),
    ).toContain("Request cancellation");

    const runningCancelResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "cancel",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(runningCancelResponse.status).toBe(200);
    expect((await runningCancelResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "cancellation_requested",
    });
    const cancellationRequestedSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "cancellation_requested",
    );
    const cancellationRequestedHtml = renderToStaticMarkup(
      <DashboardView state={cancellationRequestedSnapshot} />,
    );
    expect(cancellationRequestedHtml).toContain("Cancellation requested");
    expect(cancellationRequestedHtml).toContain(
      "Waiting for HandBrake to stop safely",
    );

    cancellationGate.release();
    await cancellationPoll;
    const runningCancelledSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "cancelled",
    );
    expect(
      renderToStaticMarkup(<DashboardView state={runningCancelledSnapshot} />),
    ).toContain("Requeue encode");
    expect(existsSync(outputPath)).toBe(false);

    const runningCancelledRequeueResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "requeue",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(runningCancelledRequeueResponse.status).toBe(200);
    await events.next((snapshot) => encodeJob(snapshot).status === "queued");

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
        body: JSON.stringify({
          action: "requeue",
          encodeJobId: queuedEncodeJob.id,
        }),
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

    const correctedSourceItemResponse = await catalogMutation({
      action: "create_media_item",
      mediaItem: {
        kind: "movie",
        title: "Corrected Workflow Source",
      },
    });
    const correctedSourceItem = (await correctedSourceItemResponse.json())
      .mediaItem as { id: string };
    const correctionResponse = await catalogMutation({
      action: "correct_disc_selection",
      discSelectionId: selection.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt.toISOString(),
      correctionReason: "The completed encode used the wrong source mapping.",
      selection: {
        mediaItemId: correctedSourceItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    });
    expect(correctionResponse.status).toBe(200);
    await expect(correctionResponse.json()).resolves.toMatchObject({
      message: "Mapping changed; review required",
      discSelection: { mediaItemId: correctedSourceItem.id },
      supersession: {
        supersededDiscSelectionId: selection.id,
        reason: "The completed encode used the wrong source mapping.",
      },
    });
    const correctedSnapshot = await events.next(
      (snapshot) =>
        encodeJob(snapshot).discSelectionCorrection?.correctedMediaTitle ===
          "Corrected Workflow Source",
    );
    expect(encodeJob(correctedSnapshot)).toMatchObject({
      id: queuedEncodeJob.id,
      mediaTitle: "Corrected Workflow Movie",
      status: "completed",
      requeueable: false,
      discSelectionCorrection: {
        correctedMediaTitle: "Corrected Workflow Source",
        reason: "The completed encode used the wrong source mapping.",
      },
    });
    const correctedDashboardHtml = renderToStaticMarkup(
      <DashboardView state={correctedSnapshot} />,
    );
    expect(correctedDashboardHtml).toContain("Completed");
    expect(correctedDashboardHtml).toContain("Disc Selection corrected");
    expect(correctedDashboardHtml).not.toContain("Re-encode");
    const correctedReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const correctedReview = await correctedReviewResponse.json() as CatalogReviewDto;
    expect(correctedReview.reviewOutcome).toBe("needs_review");
    const correctedReviewHtml = renderCatalogReview(correctedReview);
    expect(correctedReviewHtml).toContain("Disc Selection Correction");
    expect(correctedReviewHtml).toContain(
      "The completed encode used the wrong source mapping.",
    );
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
      archive.sizeBytes,
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
