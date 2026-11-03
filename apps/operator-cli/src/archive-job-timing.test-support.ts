import { expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest, createNormalDvdArchiveBoundaryEvidenceForTest } from "@rip-dvd/data-access/test-support";
import { createOperatorWorkflowFixture, markArchiveWithDvdRecoveryEvidence } from "./operator-workflow.test-support.js";

export async function startTimingAttempt() {
  const fixture = createOperatorWorkflowFixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.250Z"));
  const access = fixture.openAccess();
  const drive = access.catalog.upsertOpticalDrive({ devicePath: "/dev/synthetic-timing", isEnabled: true, isPresent: true });
  const disc = access.catalog.registerDetectedDisc({ opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-timing-disc" });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  expect((await fixture.run(["submit-archive-request", "--key", "synthetic-timing-request", "--detected-disc-id", disc.id])).exitCode).toBe(0);
  expect((await fixture.run(["inspect", "archive-jobs"])).result).toMatchObject({ items: [] });
  const settled = beginSettledDiscInspectionForTest(access, { opticalDriveId: drive.id, mediaGeneration: "synthetic-generation", mediaCapacityBytes: 2048 });
  access.discInspections.record(settled.claim, { type: "metadata", volumeLabel: null, titleCount: 0, chapterCount: 0, audioStreamCount: 0, subtitleStreamCount: 0, totalBytes: 2048 });
  const inspection = access.discInspections.record(settled.claim, { type: "complete", detectedDiscId: disc.id });
  settled.restoreSystemTime();
  const claim = access.archiveJobs.startForInspection(inspection.id, "synthetic-worker")!;
  return { fixture, access, claim };
}

export async function saveTimingArchive({ unavailable = false, recoveryCompleted = false }: {
  unavailable?: boolean;
  recoveryCompleted?: boolean;
} = {}) {
  const started = await startTimingAttempt();
  const { fixture, access, claim } = started;
  vi.setSystemTime(new Date("2026-01-01T00:00:05.999Z"));
  const completed = access.archiveJobs.publish(claim, {
    archivePath: join(fixture.originalsLibraryPath, "synthetic.iso"), sizeBytes: 2048,
    boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(2048),
    integrityEvidence: createCleanReadArchiveIntegrityEvidence("synthetic-policy-v1"),
  });
  const archive = access.catalog.listOriginalDiscArchives({ ids: [completed.originalDiscArchiveId!] })[0]!;
  markArchiveWithDvdRecoveryEvidence(fixture.databasePath, archive.id, "synthetic-saved-timing", {
    ...(recoveryCompleted ? {} : { archiveRecovery: { id: "synthetic-timing-recovery", workStatus: "claimed" as const } }),
    // The checkpoint's exact source attempt differs from the other linked job.
    archiveJobTiming: { startedAt: unavailable ? 9e15 : Date.parse("2026-01-01T00:01:00.250Z"), completedAt: Date.parse("2026-01-01T00:01:09.999Z") },
  });
  if (recoveryCompleted) {
    const sqlite = new DatabaseSync(fixture.databasePath);
    try {
      sqlite.prepare(`INSERT INTO archive_recoveries (id, original_disc_archive_id, attempt_id, attempt_ordinal, status, created_at, updated_at)
        VALUES ('synthetic-timing-recovery', ?, 'synthetic-completed-recovery-attempt', 1, 'completed', 1, 1)`).run(archive.id);
    } finally { sqlite.close(); }
  }
  const sourceJobId = "synthetic-saved-timing-evidence-job";
  return { ...started, archive, sourceJobId };
}

