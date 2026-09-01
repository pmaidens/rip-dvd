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

function cleanupFailure(
  diagnostic = "partial cleanup failed",
): EncodeJobFailureReportInput {
  return {
    schemaVersion: 1,
    reasonCode: "cleanup_failed",
    phase: "cleanup",
    retryability: "after_action",
    diagnostic,
    evidence: { kind: "cleanup", operation: "partial_output" },
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
    expect(() =>
      access.encodeJobs.failWithReport(claimed, {
        ...cleanupFailure(),
        evidence: {
          kind: "cleanup",
          operation: "partial_output",
          outputPath: "/media/private/output.mkv",
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
    expect(() =>
      access.encodeJobs.recordFailureReport(staleClaim, cleanupFailure()),
    ).toThrow(StaleJobAttemptError);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "running" }),
    ]);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([]);
  });

  it("keeps primary and cleanup failures as separate structured reports", () => {
    const { access, job } = createEncodeJobFixture();

    const failed = access.encodeJobs.failWithReports(
      claim(access),
      "HandBrake command failed",
      [commandFailure(29), cleanupFailure("cleanup /private/output.mkv")],
    );

    expect(failed).toMatchObject({
      id: job.id,
      status: "failed",
      errorMessage: "HandBrake command failed",
    });
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        reasonCode: "cleanup_failed",
        phase: "cleanup",
        retryability: "after_action",
        diagnostic: "cleanup /private/output.mkv",
        evidence: { kind: "cleanup", operation: "partial_output" },
      }),
      expect.objectContaining({
        reasonCode: "command_failed",
        phase: "encoding",
        evidence: { kind: "exit_status", exitStatus: 29 },
      }),
    ]);
  });

  it("keeps cancellation terminal while retaining fenced cleanup reports", () => {
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);
    access.encodeJobs.requestCancellation(job.id);

    const cancelled = access.encodeJobs.completeCancellationWithReports(
      claimed,
      [cleanupFailure("cancellation quarantine failed")],
    );
    const cleanup = {
      jobId: job.id,
      outputPath: claimed.outputPath,
      claimToken: claimed.claimToken,
      leaseToken: null,
      publicationPending: false,
    };

    expect(cancelled).toMatchObject({
      status: "cancelled",
      partialCleanupOutputPath: claimed.outputPath,
      partialCleanupClaimToken: claimed.claimToken,
    });
    access.encodeJobs.recordCleanupFailureReport(
      cleanup,
      cleanupFailure("automatic cleanup retry failed"),
    );
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        reasonCode: "cleanup_failed",
        diagnostic: "automatic cleanup retry failed",
      }),
      expect.objectContaining({
        reasonCode: "cleanup_failed",
        diagnostic: "cancellation quarantine failed",
      }),
    ]);
    expect(access.encodeJobs.completePartialCleanup(cleanup)).toMatchObject({
      status: "cancelled",
      partialCleanupOutputPath: null,
      partialCleanupClaimToken: null,
    });
  });

  it("orders reports by insertion sequence without changing occurrence time", () => {
    vi.useFakeTimers();
    const firstOccurrence = new Date("2026-09-01T12:00:00.000Z");
    vi.setSystemTime(firstOccurrence);
    const { access, job } = createEncodeJobFixture();
    access.encodeJobs.failWithReports(
      claim(access),
      "HandBrake command failed",
      [commandFailure(41, "first primary"), cleanupFailure("first cleanup")],
    );

    expect(
      access.encodeJobs.listFailureReports([job.id]).map(({ occurredAt }) =>
        occurredAt
      ),
    ).toEqual([firstOccurrence, firstOccurrence]);

    access.encodeJobs.requeue(job.id);
    const clockRollbackOccurrence = new Date("2026-09-01T11:00:00.000Z");
    vi.setSystemTime(clockRollbackOccurrence);
    access.encodeJobs.failWithReport(
      claim(access),
      commandFailure(42, "after clock rollback"),
    );

    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        diagnostic: "after clock rollback",
        occurredAt: clockRollbackOccurrence,
      }),
      expect.objectContaining({
        diagnostic: "first cleanup",
        occurredAt: firstOccurrence,
      }),
      expect.objectContaining({
        diagnostic: "first primary",
        occurredAt: firstOccurrence,
      }),
    ]);
  });

  it("fences cleanup reports by the current cleanup lease", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);
    const cleanup = access.encodeJobs.registerPartialCleanup(claimed);
    access.encodeJobs.failWithReport(claimed, commandFailure(31));
    const firstOwner = access.encodeJobs.claimPartialCleanup(cleanup);

    vi.advanceTimersByTime(1_000);
    access.encodeJobs.recordCleanupFailureReport(
      firstOwner,
      cleanupFailure("first owner"),
    );
    vi.advanceTimersByTime(60_001);
    const laterOwner = access.encodeJobs.claimPartialCleanup(cleanup);

    expect(() =>
      access.encodeJobs.recordCleanupFailureReport(
        firstOwner,
        cleanupFailure("stale owner"),
      )
    ).toThrow(StaleJobAttemptError);
    access.encodeJobs.recordCleanupFailureReport(
      laterOwner,
      cleanupFailure("later owner"),
    );
    expect(
      access.encodeJobs.listFailureReports([job.id]).map(
        ({ diagnostic }) => diagnostic,
      ),
    ).toEqual(["later owner", "first owner", "HandBrake diagnostic 31"]);
  });

  it("rejects an unfenced cleanup report after its running claim expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);
    const cleanup = access.encodeJobs.registerPartialCleanup(claimed);
    vi.advanceTimersByTime(60_001);

    expect(() =>
      access.encodeJobs.recordCleanupFailureReport(
        cleanup,
        cleanupFailure("expired claim cleanup"),
      )
    ).toThrow(StaleJobAttemptError);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([]);
  });

  it("coalesces an identical repeated publication recovery report", () => {
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);
    const cleanup = access.encodeJobs.registerPartialCleanup(claimed);
    access.encodeJobs.failWithReport(claimed, commandFailure(32));
    const recoveryFailure = {
      schemaVersion: 1,
      reasonCode: "publication_recovery_failed",
      phase: "recovery",
      retryability: "after_action",
      diagnostic: "recovery directory sync failed",
      evidence: { kind: "recovery", operation: "cleanup_recovery" },
    } as const;

    access.encodeJobs.recordCleanupFailureReport(cleanup, recoveryFailure);
    access.encodeJobs.recordCleanupFailureReport(cleanup, recoveryFailure);

    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        reasonCode: "publication_recovery_failed",
        diagnostic: recoveryFailure.diagnostic,
      }),
      expect.objectContaining({
        reasonCode: "command_failed",
      }),
    ]);
  });

  it("atomically classifies expired job and publication leases", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { access, job } = createEncodeJobFixture();
    const abandonedClaim = claim(access);
    access.encodeJobs.updateProgress(abandonedClaim, {
      phase: "previewing",
      progressPercent: 10,
      etaSeconds: null,
    });
    vi.advanceTimersByTime(60_001);

    expect(access.encodeJobs.recoverExpiredClaims()).toHaveLength(1);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
      expect.objectContaining({
        reasonCode: "lease_expired",
        phase: "previewing",
        evidence: { kind: "lease", scope: "job_claim" },
      }),
    ]);

    access.encodeJobs.completePartialCleanup(
      access.encodeJobs.listPendingPartialCleanups()[0]!,
    );
    access.encodeJobs.requeue(job.id);
    const publicationClaim = claim(access);
    const publication = access.encodeJobs.registerPartialCleanup(
      publicationClaim,
      { publicationPending: true },
    );
    const mutation = access.encodeJobs.beginPublicationMutation(
      publicationClaim,
      publication,
    );
    vi.advanceTimersByTime(60_001);

    expect(access.encodeJobs.listPublicationMutations()).toEqual([mutation]);
    expect(access.encodeJobs.listExpiredPublicationMutations()).toEqual([
      mutation,
    ]);
    expect(
      access.encodeJobs.recoverExpiredPublicationMutation(mutation, {
        schemaVersion: 1,
        reasonCode: "publication_recovery_failed",
        phase: "recovery",
        retryability: "after_action",
        diagnostic: "directory sync failed",
        evidence: {
          kind: "recovery",
          operation: "publication_recovery",
        },
      }),
    ).toMatchObject({ id: job.id, status: "failed" });
    expect(access.encodeJobs.listFailureReports([job.id]).slice(0, 2))
      .toEqual([
        expect.objectContaining({
          reasonCode: "publication_recovery_failed",
          phase: "recovery",
          evidence: {
            kind: "recovery",
            operation: "publication_recovery",
          },
        }),
        expect.objectContaining({
          reasonCode: "lease_expired",
          phase: "publication",
          evidence: { kind: "lease", scope: "publication_cleanup" },
        }),
      ]);
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

  it.each([
    {
      reasonCode: "input_unavailable",
      phase: "preparation",
      retryability: "after_action",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "invalid_configuration",
      phase: "preparation",
      retryability: "after_action",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "output_conflict",
      phase: "preparation",
      retryability: "after_action",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "unsafe_output_state",
      phase: "preparation",
      retryability: "after_action",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "output_validation_failed",
      phase: "validation",
      retryability: "after_action",
      evidence: {
        kind: "duration",
        expectedSeconds: 8_078,
        observedSeconds: 97.205,
      },
    },
    {
      reasonCode: "output_validation_failed",
      phase: "validation",
      retryability: "after_action",
      evidence: { kind: "validation_check", check: "video_decode" },
    },
    {
      reasonCode: "unknown_failure",
      phase: "publication",
      retryability: "after_action",
      evidence: { kind: "none" },
    },
  ])(
    "persists allowlisted $reasonCode evidence without changing the report contract",
    ({ reasonCode, phase, retryability, evidence }) => {
      const { access, job } = createEncodeJobFixture();

      access.encodeJobs.failWithReport(claim(access), {
        schemaVersion: 1,
        reasonCode,
        phase,
        retryability,
        diagnostic: "/private/source.iso --preset SECRET claim-token",
        evidence,
      } as EncodeJobFailureReportInput);

      expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
        expect.objectContaining({
          reasonCode,
          phase,
          retryability,
          evidence,
        }),
      ]);
    },
  );

  it("rejects untyped or out-of-range validation evidence", () => {
    const { access, job } = createEncodeJobFixture();
    const claimed = claim(access);

    expect(() =>
      access.encodeJobs.failWithReport(claimed, {
        schemaVersion: 1,
        reasonCode: "output_validation_failed",
        phase: "validation",
        retryability: "after_action",
        evidence: {
          kind: "duration",
          expectedSeconds: 8_078,
          observedSeconds: Number.POSITIVE_INFINITY,
          outputPath: "/private/output.mkv",
        },
      } as unknown as EncodeJobFailureReportInput)
    ).toThrow(DomainInvariantError);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "running" }),
    ]);
    expect(access.encodeJobs.listFailureReports([job.id])).toEqual([]);
  });
});
