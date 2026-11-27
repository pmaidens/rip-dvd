import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { ArchiveRequestId, DetectedDiscId } from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";

import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

it("inspects the saved automatic origin after the Archive Request database reopens", async () => {
  const fixture = createOperatorWorkflowFixture();
  try {
    const access = fixture.openAccess();
    let requestId: ArchiveRequestId;
    try {
      access.archivingSettings.set({
        mutationKey: "synthetic-origin-opt-in",
        automaticallyArchiveInsertedDvds: true,
      });
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: "/dev/synthetic-origin", isEnabled: true, isPresent: true,
      });
      const fingerprint = `dvdmeta-sha256:${"a".repeat(64)}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id, discKind: "dvd", fingerprint,
        scanData: {
          schemaVersion: 2,
          contentId: fingerprint,
          titles: [{ number: 1, durationSeconds: 600, chapters: 2, audioStreams: [], subtitles: [] }],
        },
      });
      const mediaGeneration = "synthetic-origin-generation";
      const settling = beginSettledDiscInspectionForTest(access, {
        opticalDriveId: drive.id, mediaGeneration, mediaCapacityBytes: 2_048,
      });
      try {
        access.discInspections.record(settling.claim, {
          type: "metadata", volumeLabel: null, titleCount: 1, chapterCount: 2,
          audioStreamCount: 0, subtitleStreamCount: 0, totalBytes: 2_048,
        });
        access.discInspections.record(settling.claim, {
          type: "complete", detectedDiscId: disc.id, publishScanned: true,
        });
        access.archiveRequests.admitAutomatically({
          inspectionId: settling.inspection.id, mediaGeneration,
        });
        const [request] = access.archiveRequests.list();
        if (!request) throw new Error("Expected an admitted Archive Request");
        requestId = request.id;
      } finally {
        settling.restoreSystemTime();
      }
    } finally {
      access.close();
    }

    expect(await fixture.run(["inspect", "archive-requests", requestId])).toMatchObject({
      exitCode: 0,
      result: { item: { id: requestId, status: "pending", origin: "automatic" } },
    });
  } finally {
    fixture.dispose();
  }
});

it("inspects a historical Archive Request with no recorded origin as null", async () => {
  const fixture = createOperatorWorkflowFixture();
  try {
    const access = fixture.openAccess();
    let discId: DetectedDiscId;
    try {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: "/dev/synthetic-history", isPresent: true,
      });
      discId = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-historical-disc",
      }).id;
    } finally {
      access.close();
    }
    const requestId = "synthetic-historical-request";
    const sqlite = new DatabaseSync(fixture.databasePath);
    try {
      sqlite.prepare(`
        INSERT INTO archive_requests (id, detected_disc_id, status, cancelled_at,
          cancellation_requested_at, created_at, updated_at)
        VALUES (?, ?, 'cancelled', 2, 2, 1, 2)
      `).run(requestId, discId);
    } finally {
      sqlite.close();
    }

    expect(await fixture.run(["inspect", "archive-requests", requestId])).toMatchObject({
      exitCode: 0,
      result: { item: { id: requestId, status: "cancelled", origin: null } },
    });
  } finally {
    fixture.dispose();
  }
});
