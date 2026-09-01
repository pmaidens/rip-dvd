import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCatalogReview } from "./catalog.test-support.js";
import { DomainInvariantError, StaleJobAttemptError } from "./errors.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";
import type {
  DataAccess,
  EncodeJobFailureReportInput,
  RunningEncodeJob,
} from "./types.js";

const openAccess: DataAccess[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const access of openAccess.splice(0)) {
    access.close();
  }
});

function createEncodeJobFixture() {
  const access = createLegacySidecarDataAccess({ databasePath: ":memory:" });
  openAccess.push(access);
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/failure-report",
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: "encode-failure-report-disc",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: "/originals/failure-report.iso",
    fingerprint: disc.fingerprint,
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title: "Failure Report",
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  completeCatalogReview(access, archive.id);
  const profile = access.encodingProfiles.create({
    key: "failure-report",
    displayName: "Failure report",
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30" },
  });
  const job = access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: "/media/failure-report.mkv",
  });
  return { access, job };
}

function commandFailure(
  exitStatus: number,
  diagnostic = `HandBrake diagnostic ${exitStatus}`,
): EncodeJobFailureReportInput {
  return {
    schemaVersion: 1,
    reasonCode: "command_failed",
    phase: "encoding",
    retryability: "appropriate",
    diagnostic,
    evidence: { kind: "exit_status", exitStatus },
  };
}

function claim(access: DataAccess): RunningEncodeJob {
  const claimed = access.encodeJobs.claimNext("failure-report-worker");
  if (claimed === null) {
    throw new Error("Expected an Encode Job claim");
  }
  return claimed;
}

describe("Encode Job Failure Reports", () => {
  it("commits the claimed failure and validated report together", () => {
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);

    const failed = access.encodeJobs.failWithReport(
      claimed,
      commandFailure(17),
    );

    expect(failed).toMatchObject({
      id: job.id,
      status: "failed",
      errorMessage: "HandBrake command failed",
    });
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        encodeJobId: job.id,
        schemaVersion: 1,
        workerKind: "encode_worker",
        reasonCode: "command_failed",
        phase: "encoding",
        retryability: "appropriate",
        diagnostic: "HandBrake diagnostic 17",
        evidence: { kind: "exit_status", exitStatus: 17 },
        occurredAt: expect.any(Date),
      }),
    ]);
  });

  it("rejects an invalid report before changing the claimed job", () => {
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);
    const invalid = {
      ...commandFailure(2),
      diagnostic: "x".repeat(501),
    };

    expect(() => access.encodeJobs.failWithReport(claimed, invalid)).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      access.encodeJobs.failWithReport(claimed, {
        ...commandFailure(2),
        evidence: {
          kind: "exit_status",
          exitStatus: 2,
          rawCommand: "--preset SECRET",
        },
      } as EncodeJobFailureReportInput),
    ).toThrow(DomainInvariantError);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "running" }),
    ]);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([]);
  });

  it("lets neither a stale claim nor its report cross the claim fence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { access, job } = createEncodeJobFixture();
    const staleClaim = claim(access);
    vi.advanceTimersByTime(60_001);

    expect(() =>
      access.encodeJobs.failWithReport(staleClaim, commandFailure(3)),
    ).toThrow(StaleJobAttemptError);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "running" }),
    ]);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([]);
  });

  it("keeps newest-first history across requeue and completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { access, job } = createEncodeJobFixture();
    access.encodeJobs.failWithReport(claim(access), commandFailure(4, "first"));
    access.encodeJobs.requeue(job.id);
    vi.advanceTimersByTime(1_000);
    access.encodeJobs.failWithReport(claim(access), {
      schemaVersion: 1,
      reasonCode: "command_timeout",
      phase: "encoding",
      retryability: "appropriate",
      diagnostic: "second",
      evidence: { kind: "timeout", timeoutSeconds: 86_400 },
    });
    access.encodeJobs.requeue(job.id);
    access.encodeJobs.complete(claim(access));

    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "completed" }),
    ]);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        reasonCode: "command_timeout",
        diagnostic: "second",
      }),
      expect.objectContaining({
        reasonCode: "command_failed",
        diagnostic: "first",
      }),
    ]);
  });

  it("bounds retained history to the newest twenty reports", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { access, job } = createEncodeJobFixture();

    for (let attempt = 1; attempt <= 21; attempt += 1) {
      access.encodeJobs.failWithReport(
        claim(access),
        commandFailure(attempt, `attempt ${attempt}`),
      );
      if (attempt < 21) {
        access.encodeJobs.requeue(job.id);
        vi.advanceTimersByTime(1_000);
      }
    }

    const reports = access.encodeJobs.listFailureReports([job.id]);
    expect(reports).toHaveLength(20);
    expect(reports[0]).toMatchObject({ diagnostic: "attempt 21" });
    expect(reports.at(-1)).toMatchObject({ diagnostic: "attempt 2" });
  });
});
