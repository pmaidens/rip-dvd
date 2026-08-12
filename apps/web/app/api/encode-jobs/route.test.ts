import { describe, expect, it, vi } from "vitest";

import {
  completeCatalogReview,
  useDataAccessFixture,
} from "../../../test/data-access-fixture";
import { createEncodeJobsRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

function createSelection(
  access: ReturnType<typeof dataAccessFixture.create>,
  suffix: string,
) {
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/${suffix}`,
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: `encode-api-${suffix}`,
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: `/media/originals/Encode API ${suffix}.iso`,
    fingerprint: `encode-api-${suffix}`,
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title: `Encode API ${suffix}`,
    year: 2026,
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  return { archive, item, selection };
}

describe("Encode Jobs API", () => {
  it("lists reviewed mapped selections and active DVD video profile versions", async () => {
    const access = dataAccessFixture.create();
    createSelection(access, "unreviewed");
    const reviewed = createSelection(access, "reviewed");
    completeCatalogReview(access, reviewed.archive.id);
    const activeProfile = access.encodingProfiles.create({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    access.encodingProfiles.createVersion({
      sourceProfileId: activeProfile.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30", container: "mkv" },
    });
    access.encodingProfiles.create({
      key: "audio-library",
      displayName: "Audio library",
      mediaDomain: "audio",
      settings: {},
    });

    const response = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs"),
      () => access,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      selections: [{
        id: reviewed.selection.id,
        mediaItemId: reviewed.item.id,
        mediaTitle: "Encode API reviewed",
        mediaYear: 2026,
        sourceDescription: "DVD main feature",
      }],
      profiles: [{
        id: activeProfile.id,
        displayName: "DVD library",
        version: 1,
      }],
      page: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
      profilePage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
    });
  });

  it("bounds and pages active DVD profile options independently of selections", async () => {
    const access = dataAccessFixture.create();
    const reviewed = createSelection(access, "profile-pages");
    completeCatalogReview(access, reviewed.archive.id);
    const profileIds = Array.from({ length: 101 }, (_, index) =>
      access.encodingProfiles.create({
        key: `profile-${String(index).padStart(3, "0")}`,
        displayName: `Profile ${index}`,
        mediaDomain: "dvd_video",
        settings: { preset: "Fast 480p30", container: "mkv" },
      }).id);
    const inactiveProfile = access.encodingProfiles.create({
      key: "inactive-profile",
      displayName: "Inactive profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    access.encodingProfiles.setActive({
      id: inactiveProfile.id,
      mediaDomain: "dvd_video",
      isActive: false,
    });
    access.encodingProfiles.create({
      key: "active-audio-profile",
      displayName: "Active audio profile",
      mediaDomain: "audio",
      settings: {},
    });

    const firstResponse = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs"),
      () => access,
    );
    const firstPage = await firstResponse.json();

    expect(firstPage.profiles.map((profile: { id: string }) => profile.id))
      .toEqual(profileIds.slice(0, 100));
    expect(firstPage.profilePage).toEqual({
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: true,
    });
    expect(firstPage.selections).toEqual([
      expect.objectContaining({ id: reviewed.selection.id }),
    ]);

    const secondResponse = await createEncodeJobsRoute(
      new Request(
        "http://localhost:3000/api/encode-jobs?selectionOffset=0&profileOffset=100",
      ),
      () => access,
    );
    const secondPage = await secondResponse.json();

    expect(secondPage.profiles).toEqual([
      expect.objectContaining({ id: profileIds[100] }),
    ]);
    expect(secondPage.profilePage).toEqual({
      offset: 100,
      limit: 100,
      hasPrevious: true,
      hasNext: false,
    });
    expect(secondPage.selections).toEqual(firstPage.selections);
    expect(secondPage.page).toEqual(firstPage.page);
  });

  it("keeps repeated queue submissions idempotent after completion", async () => {
    const access = dataAccessFixture.create();
    const reviewed = createSelection(access, "queue");
    completeCatalogReview(access, reviewed.archive.id);
    const profile = access.encodingProfiles.create({
      key: "queue-profile",
      displayName: "Queue profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const request = (outputPath: string) =>
      new Request("http://localhost:3000/api/encode-jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          discSelectionId: reviewed.selection.id,
          encodingProfileId: profile.id,
          outputPath,
        }),
      });
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });

    const queuedResponse = await createEncodeJobsRoute(
      request("/media/movies/Encode API queue.mkv"),
      () => access,
      config,
    );
    expect(queuedResponse.status).toBe(200);
    const queued = (await queuedResponse.json()).job;
    expect(queued).toMatchObject({
      discSelectionId: reviewed.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Encode API queue.mkv",
      status: "queued",
      progressPercent: 0,
    });

    const repeated = await createEncodeJobsRoute(
      request("/media/movies/ignored-while-queued.mkv"),
      () => access,
      config,
    );
    expect((await repeated.json()).job.id).toBe(queued.id);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: queued.id,
        outputPath: "/media/movies/Encode API queue.mkv",
      }),
    ]);

    const claim = access.encodeJobs.claimNext("completed-api-job");
    if (!claim) {
      throw new Error("Expected queued Encode Job");
    }
    access.encodeJobs.complete(claim);

    const repeatedCompletedResponse = await createEncodeJobsRoute(
      request("/media/movies/Encode API queue.mkv"),
      () => access,
      config,
    );
    expect(repeatedCompletedResponse.status).toBe(200);
    expect((await repeatedCompletedResponse.json()).job).toMatchObject({
      id: queued.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Encode API queue.mkv",
      status: "completed",
      progressPercent: 100,
    });
    expect(access.encodeJobs.list()).toHaveLength(1);
    expect(access.encodeJobs.claimNext("late-post-retry")).toBeNull();
  });

  it("requires explicit retry intent for failed and completed Encode Jobs", async () => {
    const access = dataAccessFixture.create();
    const reviewed = createSelection(access, "retry");
    completeCatalogReview(access, reviewed.archive.id);
    const profile = access.encodingProfiles.create({
      key: "retry-profile",
      displayName: "Retry profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const original = access.encodeJobs.enqueue({
      discSelectionId: reviewed.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Encode API retry.mkv",
    });
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const retry = () =>
      createEncodeJobsRoute(
        new Request("http://localhost:3000/api/encode-jobs", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify({ encodeJobId: original.id }),
        }),
        () => access,
        config,
      );

    const firstClaim = access.encodeJobs.claimNext("failed-api-job");
    if (!firstClaim) {
      throw new Error("Expected first Encode Job claim");
    }
    access.encodeJobs.updateProgress(firstClaim, 37);
    access.encodeJobs.fail(firstClaim, "HandBrake failed");

    const repeatSubmission = () =>
      createEncodeJobsRoute(
        new Request("http://localhost:3000/api/encode-jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify({
            discSelectionId: reviewed.selection.id,
            encodingProfileId: profile.id,
            outputPath: "/media/movies/Encode API retry.mkv",
          }),
        }),
        () => access,
        config,
      );

    expect((await (await repeatSubmission()).json()).job).toMatchObject({
      id: original.id,
      status: "failed",
      progressPercent: 37,
      errorMessage: "HandBrake failed",
      outputPath: "/media/movies/Encode API retry.mkv",
    });
    expect(access.encodeJobs.claimNext("late-failed-post-retry")).toBeNull();

    expect((await (await retry()).json()).job).toMatchObject({
      id: original.id,
      status: "queued",
      progressPercent: 0,
      errorMessage: null,
    });

    const secondClaim = access.encodeJobs.claimNext("completed-api-job");
    if (!secondClaim) {
      throw new Error("Expected second Encode Job claim");
    }
    access.encodeJobs.complete(secondClaim);

    expect((await (await repeatSubmission()).json()).job).toMatchObject({
      id: original.id,
      status: "completed",
      progressPercent: 100,
      outputPath: "/media/movies/Encode API retry.mkv",
    });
    expect(access.encodeJobs.claimNext("late-completed-post-retry")).toBeNull();

    expect((await (await retry()).json()).job).toMatchObject({
      id: original.id,
      status: "queued",
      progressPercent: 0,
      completedAt: null,
    });
    expect(access.encodeJobs.list()).toHaveLength(1);
  });

  it("cancels only queued Encode Jobs through a trusted explicit command", async () => {
    const access = dataAccessFixture.create();
    const reviewed = createSelection(access, "cancel");
    completeCatalogReview(access, reviewed.archive.id);
    const profile = access.encodingProfiles.create({
      key: "cancel-profile",
      displayName: "Cancel profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const queued = access.encodeJobs.enqueue({
      discSelectionId: reviewed.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Encode API cancel.mkv",
    });
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const cancel = (encodeJobId: string, origin = "http://localhost:3000") =>
      createEncodeJobsRoute(
        new Request("http://localhost:3000/api/encode-jobs", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: origin,
            "Sec-Fetch-Site": origin === "http://localhost:3000"
              ? "same-origin"
              : "cross-site",
          },
          body: JSON.stringify({ action: "cancel", encodeJobId }),
        }),
        () => access,
        config,
      );

    const cancelled = await cancel(queued.id);
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).job).toMatchObject({
      id: queued.id,
      status: "cancelled",
      progressPercent: 0,
      completedAt: null,
    });
    expect((await cancel(queued.id)).status).toBe(409);

    const runningProfile = access.encodingProfiles.create({
      key: "running-cancel-profile",
      displayName: "Running cancel profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const runningJob = access.encodeJobs.enqueue({
      discSelectionId: reviewed.selection.id,
      encodingProfileId: runningProfile.id,
      outputPath: "/media/movies/Encode API running cancel.mkv",
    });
    expect(access.encodeJobs.claimNext("route-running-cancel")?.id).toBe(
      runningJob.id,
    );
    expect((await cancel(runningJob.id)).status).toBe(409);
    expect((await cancel("missing-job")).status).toBe(404);
    expect((await cancel(queued.id, "https://attacker.example")).status).toBe(
      403,
    );

    const malformed = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ action: "cancel", encodeJobId: "" }),
      }),
      () => access,
      config,
    );
    expect(malformed.status).toBe(400);
    expect(access.encodeJobs.list().map((job) => [job.id, job.status])).toEqual(
      expect.arrayContaining([
        [runningJob.id, "running"],
        [queued.id, "cancelled"],
      ]),
    );
  });

  it("rejects unreviewed selections and inactive profile versions without queueing", async () => {
    const access = dataAccessFixture.create();
    const unreviewed = createSelection(access, "blocked");
    const activeProfile = access.encodingProfiles.create({
      key: "blocked-profile",
      displayName: "Blocked profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const inactiveProfile = access.encodingProfiles.createVersion({
      sourceProfileId: activeProfile.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30", container: "mkv" },
    });
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const queue = (encodingProfileId: string) =>
      createEncodeJobsRoute(
        new Request("http://localhost:3000/api/encode-jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify({
            discSelectionId: unreviewed.selection.id,
            encodingProfileId,
            outputPath: "/media/movies/Blocked.mkv",
          }),
        }),
        () => access,
        config,
      );

    expect((await queue(activeProfile.id)).status).toBe(409);
    completeCatalogReview(access, unreviewed.archive.id);
    expect((await queue(inactiveProfile.id)).status).toBe(409);
    expect(access.encodeJobs.list()).toEqual([]);
  });

  it("rejects unsafe output paths and cross-origin mutations before opening data access", async () => {
    const getAccess = vi.fn();
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const body = JSON.stringify({
      discSelectionId: "selection-1",
      encodingProfileId: "profile-1",
      outputPath: "/media/originals/not-a-media-output.mkv",
    });

    const unsafePath = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body,
      }),
      getAccess,
      config,
    );
    expect(unsafePath.status).toBe(400);

    const crossOrigin = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "https://attacker.example",
        },
        body,
      }),
      getAccess,
      config,
    );
    expect(crossOrigin.status).toBe(403);
    expect(getAccess).not.toHaveBeenCalled();
  });

  it("reports a final output reserved by another logical job as a conflict", async () => {
    const access = dataAccessFixture.create();
    const reviewed = createSelection(access, "output-owner");
    completeCatalogReview(access, reviewed.archive.id);
    const createProfile = (key: string) => access.encodingProfiles.create({
      key,
      displayName: key,
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const firstProfile = createProfile("first-output-owner");
    const secondProfile = createProfile("second-output-owner");
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const queue = (encodingProfileId: string) =>
      createEncodeJobsRoute(
        new Request("http://localhost:3000/api/encode-jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify({
            discSelectionId: reviewed.selection.id,
            encodingProfileId,
            outputPath: "/media/movies/One owner.mkv",
          }),
        }),
        () => access,
        config,
      );

    expect((await queue(firstProfile.id)).status).toBe(200);
    const conflict = await queue(secondProfile.id);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "Encode Job output is already assigned: /media/movies/One owner.mkv",
    });
    expect(access.encodeJobs.list()).toHaveLength(1);
  });
});
