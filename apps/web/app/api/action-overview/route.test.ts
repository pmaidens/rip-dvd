import { afterEach, describe, expect, it, vi } from "vitest";

import {
  seedFailedArchiveJobAndQueuedDuplicate,
  startArchiveJob,
} from "../../../test/archive-job-fixture";
import {
  completeCatalogReview,
  useDataAccessFixture,
} from "../../../test/data-access-fixture";
import { createActionOverviewRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

afterEach(() => vi.useRealTimers());

describe("Action overview API", () => {
  it("counts all failed jobs and reviewed-archive filesystem problems", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "action-overview-disc",
      volumeLabel: "ACTION_OVERVIEW_DISC",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/missing/action-overview.iso",
      fingerprint: disc.fingerprint,
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Action Overview",
      year: 2001,
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);

    const jobs = [];
    for (let index = 0; index < 22; index += 1) {
      const profile = access.encodingProfiles.create({
        key: `action-overview-${index}`,
        displayName: `Action overview ${index}`,
        mediaDomain: "dvd_video",
        settings: { index },
      });
      jobs.push(
        access.encodeJobs.enqueue({
          discSelectionId: selection.id,
          encodingProfileId: profile.id,
          outputPath: `/missing/action-overview-${index}.mkv`,
        }),
      );
    }
    for (;;) {
      const claim = access.encodeJobs.claimNext("action-overview-worker");
      if (!claim) {
        break;
      }
      access.encodeJobs.fail(claim, "fixture failure");
    }
    await access.filesystemVerification.verifyOriginalDiscArchive(archive.id);
    await access.filesystemVerification.verifyEncodeJobOutput(jobs[0]!.id);

    const response = createActionOverviewRoute(() => access);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.failedEncodes).toMatchObject({ count: 22 });
    expect(body.failedEncodes.items).toHaveLength(3);
    expect(body.failedEncodes.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Action Overview (2001)" }),
      ]),
    );
    expect(body.catalogReviews).toEqual({ count: 0, items: [] });
    expect(body.filesystemProblems).toMatchObject({ count: 2 });
    expect(body.filesystemProblems.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `original_disc_archive:${archive.id}`,
          label: "ACTION_OVERVIEW_DISC",
        }),
        expect.objectContaining({
          id: `encode_job_output:${jobs[0]!.id}`,
          label: "Action Overview (2001)",
        }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("/missing/");
  });

  it("excludes failed Archive Jobs superseded by a published duplicate", async () => {
    const access = dataAccessFixture.create();
    const fixture = seedFailedArchiveJobAndQueuedDuplicate(
      access,
      "action-overview-superseded-archive-job",
    );

    const beforePublication = await createActionOverviewRoute(
      () => access,
    ).json();
    expect(beforePublication.archiveRequestsNeedingAttention).toEqual({
      count: 1,
      items: [
        { id: fixture.failedRequestId, label: "FAILED_DUPLICATE" },
      ],
    });
    fixture.publishDuplicate();

    const body = await createActionOverviewRoute(() => access).json();

    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({ id: fixture.failedJob.id }),
    ]);
    expect(body.archiveRequestsNeedingAttention).toEqual({
      count: 0,
      items: [],
    });
  });

  it("includes a running Archive Job that has stopped advancing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T20:04:10.000Z"));
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/stalled-action-overview",
      displayName: "Upper drive",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "stalled-action-overview-disc",
      volumeLabel: "BARBIE",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const job = startArchiveJob(access, disc, "stalled-action-overview-worker");

    vi.advanceTimersByTime(5 * 60_000);
    const body = await createActionOverviewRoute(() => access).json();

    expect(body.archiveRequestsNeedingAttention).toEqual({
      count: 1,
      items: [{ id: job.archiveRequestId, label: "BARBIE" }],
    });
  });

  it("fails closed when the catalog is unavailable", async () => {
    const response = createActionOverviewRoute(() => {
      throw new Error("unavailable");
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Action overview is unavailable",
    });
  });
});
