import { expect, vi } from "vitest";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

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

