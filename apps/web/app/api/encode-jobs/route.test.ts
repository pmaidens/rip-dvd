import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
  const contentId = `sha256:${createHash("sha256").update(suffix).digest("hex")}`;
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/${suffix}`,
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    scanData: {
      schemaVersion: 2,
      contentId,
      titles: [1, 2, 3, 4].map((number) => ({
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
    archivePath: `/media/originals/Encode API ${suffix}.iso`,
    fingerprint: contentId,
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
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      historyGroup: "not_encoded",
      query: "",
      counts: { notEncoded: 1, reEncode: 0 },
      selections: [{
        id: reviewed.selection.id,
        mediaItemId: reviewed.item.id,
        mediaTitle: "Encode API reviewed",
        mediaYear: 2026,
        sourceDescription: "DVD main feature",
        hasCompletedEncode: false,
        priorCompletedJob: null,
        logicalJob: null,
        suggestedOutputPath:
          "/media/movies/Encode API reviewed (2026)/Encode API reviewed (2026).mkv",
      }],
      profiles: [{
        id: activeProfile.id,
        displayName: "DVD library",
        version: 1,
      }],
      page: {
        offset: 0,
        limit: 100,
        total: 1,
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

  it("resolves bounded selected-profile logical jobs without a mutation", async () => {
    const access = dataAccessFixture.create();
    const candidate = createSelection(access, "replacement-resolution");
    completeCatalogReview(access, candidate.archive.id);
    const profile = access.encodingProfiles.create({
      key: "replacement-resolution",
      displayName: "Replacement resolution",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: candidate.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement resolution.mkv",
    });

    const response = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?encodingProfileId=${profile.id}&resolveDiscSelectionId=${candidate.selection.id}`,
      ),
      () => access,
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      logicalJobs: [{
        discSelectionId: candidate.selection.id,
        id: job.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Replacement resolution.mkv",
        status: "queued",
        queueAvailable: false,
      }],
    });
    expect(access.encodeJobs.list()).toHaveLength(1);

    const oversizedUrl = new URL("http://localhost:3000/api/encode-jobs");
    oversizedUrl.searchParams.set("encodingProfileId", profile.id);
    for (let index = 0; index < 101; index += 1) {
      oversizedUrl.searchParams.append(
        "resolveDiscSelectionId",
        candidate.selection.id,
      );
    }
    const oversizedResponse = await createEncodeJobsRoute(
      new Request(oversizedUrl),
      () => access,
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
    );
    expect(oversizedResponse.status).toBe(400);
  });

  it("classifies queue candidates and returns profile-relative Encode Job details", async () => {
    const { access, databasePath } = dataAccessFixture.createWithDatabasePath();
    const neverEncoded = createSelection(access, "never-encoded");
    const failed = createSelection(access, "failed-history");
    const cancelled = createSelection(access, "cancelled-history");
    const queued = createSelection(access, "queued-history");
    const completed = createSelection(access, "completed-history");
    const unreviewed = createSelection(access, "unreviewed-history");
    for (const candidate of [
      neverEncoded,
      failed,
      cancelled,
      queued,
      completed,
    ]) {
      completeCatalogReview(access, candidate.archive.id);
    }
    const profile = access.encodingProfiles.create({
      key: "history-profile",
      displayName: "History profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });

    const failedJob = access.encodeJobs.enqueue({
      discSelectionId: failed.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Failed history.mkv",
    });
    const failedClaim = access.encodeJobs.claimNext("failed-history-worker");
    if (!failedClaim) {
      throw new Error("Expected failed-history Encode Job claim");
    }
    access.encodeJobs.fail(failedClaim, "HandBrake stopped");

    const cancelledJob = access.encodeJobs.enqueue({
      discSelectionId: cancelled.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Cancelled history.mkv",
    });
    access.encodeJobs.requestCancellation(cancelledJob.id);

    const completedJob = access.encodeJobs.enqueue({
      discSelectionId: completed.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Completed history.mkv",
    });
    const completedClaim = access.encodeJobs.claimNext(
      "completed-history-worker",
    );
    if (!completedClaim) {
      throw new Error("Expected completed-history Encode Job claim");
    }
    access.encodeJobs.complete(completedClaim);

    const queuedJob = access.encodeJobs.enqueue({
      discSelectionId: queued.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Queued history.mkv",
    });
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });

    const defaultResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?encodingProfileId=${profile.id}`,
      ),
      () => access,
      config,
    );
    expect(defaultResponse.status).toBe(200);
    const defaultBody = await defaultResponse.json();

    expect(defaultBody.historyGroup).toBe("not_encoded");
    expect(defaultBody.counts).toEqual({ notEncoded: 4, reEncode: 1 });
    expect(defaultBody.page).toEqual({
      offset: 0,
      limit: 100,
      total: 4,
      hasPrevious: false,
      hasNext: false,
    });
    expect(new Set(defaultBody.selections.map(
      (selection: { id: string }) => selection.id,
    ))).toEqual(new Set([
        neverEncoded.selection.id,
        failed.selection.id,
        cancelled.selection.id,
        queued.selection.id,
      ]));
    expect(defaultBody.selections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: neverEncoded.selection.id,
        hasCompletedEncode: false,
        priorCompletedJob: null,
        logicalJob: null,
      }),
      expect.objectContaining({
        id: failed.selection.id,
        logicalJob: expect.objectContaining({
          id: failedJob.id,
          status: "failed",
          outputPath: "/media/movies/Failed history.mkv",
        }),
      }),
      expect.objectContaining({
        id: cancelled.selection.id,
        logicalJob: expect.objectContaining({
          id: cancelledJob.id,
          status: "cancelled",
          outputPath: "/media/movies/Cancelled history.mkv",
        }),
      }),
      expect.objectContaining({
        id: queued.selection.id,
        logicalJob: expect.objectContaining({
          id: queuedJob.id,
          status: "queued",
          outputPath: "/media/movies/Queued history.mkv",
        }),
      }),
    ]));
    expect(defaultBody.selections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unreviewed.selection.id }),
    ]));

    const reEncodeResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?historyGroup=re_encode&encodingProfileId=${profile.id}`,
      ),
      () => access,
      config,
    );
    expect(reEncodeResponse.status).toBe(200);
    const reEncodeBody = await reEncodeResponse.json();
    expect(reEncodeBody.historyGroup).toBe("re_encode");
    expect(reEncodeBody.selections).toEqual([
      expect.objectContaining({
        id: completed.selection.id,
        hasCompletedEncode: true,
        priorCompletedJob: expect.objectContaining({
          id: completedJob.id,
          status: "completed",
          profile: {
            id: profile.id,
            displayName: "History profile",
            version: 1,
          },
        }),
        logicalJob: expect.objectContaining({
          id: completedJob.id,
          status: "completed",
          outputPath: "/media/movies/Completed history.mkv",
        }),
      }),
    ]);

    access.encodeJobs.requeue(completedJob.id);
    const activeReEncodeResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?historyGroup=re_encode&encodingProfileId=${profile.id}`,
      ),
      () => access,
      config,
    );
    const activeReEncodeBody = await activeReEncodeResponse.json();
    expect(activeReEncodeBody.counts).toEqual({ notEncoded: 4, reEncode: 1 });
    expect(activeReEncodeBody.selections).toEqual([
      expect.objectContaining({
        id: completed.selection.id,
        hasCompletedEncode: true,
        priorCompletedJob: expect.objectContaining({
          id: completedJob.id,
          status: "completed",
        }),
        logicalJob: expect.objectContaining({
          id: completedJob.id,
          status: "queued",
        }),
      }),
    ]);

    const tentativeRetryClaim = access.encodeJobs.claimNext(
      "tentative-retry-worker",
    );
    if (!tentativeRetryClaim || tentativeRetryClaim.id !== completedJob.id) {
      throw new Error("Expected tentative retry claim");
    }
    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update encode_jobs
      set status = 'completed',
          completed_at = updated_at,
          publication_pending = 1,
          publication_completion_pending = 1,
          partial_cleanup_output_path = output_path,
          partial_cleanup_claim_token = ?,
          partial_cleanup_lease_token = NULL
      where id = ?
    `).run(tentativeRetryClaim.claimToken, completedJob.id);
    sqlite.close();

    const tentativeSummary = access.encodeJobs.listQueueDiscSelections({
      historyGroup: "re_encode",
      encodingProfileId: profile.id,
      limit: 100,
    }).selections[0];
    expect(tentativeSummary?.priorCompletedJob).toEqual({
      id: completedJob.id,
      encodingProfileId: profile.id,
      status: "completed",
    });
    expect(tentativeSummary?.logicalJob).toEqual({
      id: completedJob.id,
      encodingProfileId: profile.id,
      outputPath: completedJob.outputPath,
      status: "completed",
      queueAvailable: false,
    });

    const tentativeRetryResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?historyGroup=re_encode&encodingProfileId=${profile.id}`,
      ),
      () => access,
      config,
    );
    const tentativeRetryBody = await tentativeRetryResponse.json();
    expect(tentativeRetryBody).toEqual(expect.objectContaining({
      counts: { notEncoded: 4, reEncode: 1 },
      selections: [expect.objectContaining({
        id: completed.selection.id,
        hasCompletedEncode: true,
        priorCompletedJob: expect.objectContaining({ id: completedJob.id }),
        logicalJob: expect.objectContaining({
          id: completedJob.id,
          queueAvailable: false,
        }),
      })],
    }));
    expect(tentativeRetryBody.selections[0].priorCompletedJob)
      .not.toHaveProperty("completedAt");

    const tentativeRetryCleanup = access.encodeJobs.renewPublishedPartial({
      jobId: completedJob.id,
      outputPath: completedJob.outputPath,
      claimToken: tentativeRetryClaim.claimToken,
      leaseToken: null,
      publicationPending: true,
    }, () => true);
    expect(access.encodeJobs.completePartialCleanup(tentativeRetryCleanup))
      .toMatchObject({
        status: "failed",
      });
    access.encodeJobs.requeue(completedJob.id);
    const failedReEncodeClaim = access.encodeJobs.claimNext(
      "failed-re-encode-worker",
    );
    if (!failedReEncodeClaim || failedReEncodeClaim.id !== completedJob.id) {
      throw new Error("Expected re-encoded Encode Job claim");
    }
    access.encodeJobs.fail(failedReEncodeClaim, "Replacement failed");
    const failedReEncodeResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?historyGroup=re_encode&encodingProfileId=${profile.id}`,
      ),
      () => access,
      config,
    );
    const failedReEncodeBody = await failedReEncodeResponse.json();
    expect(failedReEncodeBody.counts).toEqual({ notEncoded: 4, reEncode: 1 });
    expect(failedReEncodeBody.selections).toEqual([
      expect.objectContaining({
        id: completed.selection.id,
        hasCompletedEncode: true,
        priorCompletedJob: expect.objectContaining({
          id: completedJob.id,
          status: "completed",
        }),
        logicalJob: expect.objectContaining({
          id: completedJob.id,
          status: "failed",
        }),
      }),
    ]);
  });

  it("reports one completion-ranked profile from deep history", async () => {
    const { access, databasePath } = dataAccessFixture.createWithDatabasePath();
    const candidate = createSelection(access, "completed-profile-order");
    completeCatalogReview(access, candidate.archive.id);
    const olderProfile = access.encodingProfiles.create({
      key: "completed-profile-order-older",
      displayName: "Older completed profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const newerProfile = access.encodingProfiles.create({
      key: "completed-profile-order-newer",
      displayName: "Newer completed profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const deepHistoryJobIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const profile = access.encodingProfiles.create({
        key: `completed-profile-order-${index}`,
        displayName: `Historical completed profile ${index}`,
        mediaDomain: "dvd_video",
        settings: {},
      });
      const job = access.encodeJobs.enqueue({
        discSelectionId: candidate.selection.id,
        encodingProfileId: profile.id,
        outputPath: `/media/movies/Historical completed profile ${index}.mkv`,
      });
      const claim = access.encodeJobs.claimNext(
        `completed-profile-order-worker-${index}`,
      );
      if (!claim || claim.id !== job.id) {
        throw new Error("Expected deep-history profile claim");
      }
      access.encodeJobs.complete(claim);
      deepHistoryJobIds.push(job.id);
    }
    const olderJob = access.encodeJobs.enqueue({
      discSelectionId: candidate.selection.id,
      encodingProfileId: olderProfile.id,
      outputPath: "/media/movies/Older completed profile.mkv",
    });
    const olderClaim = access.encodeJobs.claimNext(
      "completed-profile-order-older-worker",
    );
    if (!olderClaim) throw new Error("Expected older profile claim");
    access.encodeJobs.complete(olderClaim);
    const newerJob = access.encodeJobs.enqueue({
      discSelectionId: candidate.selection.id,
      encodingProfileId: newerProfile.id,
      outputPath: "/media/movies/Newer completed profile.mkv",
    });
    const newerClaim = access.encodeJobs.claimNext(
      "completed-profile-order-newer-worker",
    );
    if (!newerClaim) throw new Error("Expected newer profile claim");
    access.encodeJobs.complete(newerClaim);

    const sqlite = new DatabaseSync(databasePath);
    const backdateDeepHistory = sqlite.prepare(`
      update encode_jobs
      set completed_at = ?, updated_at = ?
      where id = ?
    `);
    for (const jobId of deepHistoryJobIds) {
      backdateDeepHistory.run(500, 500, jobId);
    }
    sqlite.prepare(`
      update encode_jobs
      set completed_at = ?, updated_at = ?
      where id = ?
    `).run(1_000, 3_000, olderJob.id);
    sqlite.prepare(`
      update encode_jobs
      set completed_at = ?, updated_at = ?
      where id = ?
    `).run(2_000, 2_000, newerJob.id);
    sqlite.close();

    const response = await createEncodeJobsRoute(
      new Request(
        "http://localhost:3000/api/encode-jobs?historyGroup=re_encode",
      ),
      () => access,
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      selections: [expect.objectContaining({
        id: candidate.selection.id,
        priorCompletedJob: expect.objectContaining({
          id: newerJob.id,
          status: "completed",
          profile: expect.objectContaining({
            id: newerProfile.id,
            displayName: "Newer completed profile",
          }),
        }),
      })],
    }));
  });

  it("does not treat corrected replacements as ordinary profile jobs", async () => {
    const { access, databasePath } = dataAccessFixture.createWithDatabasePath();
    const mistaken = createSelection(access, "corrected-history");
    completeCatalogReview(access, mistaken.archive.id);
    const profile = access.encodingProfiles.create({
      key: "corrected-history-profile",
      displayName: "Corrected history profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistaken.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Corrected history.mkv",
    });
    const predecessorClaim = access.encodeJobs.claimNext(
      "corrected-history-worker",
    );
    if (!predecessorClaim) {
      throw new Error("Expected corrected-history Encode Job claim");
    }
    access.encodeJobs.complete(predecessorClaim);

    const correctedItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Corrected Encode API title",
      year: 2026,
    });
    const correction = access.catalog.correctDiscSelection(
      mistaken.selection.id,
      {
        originalDiscArchiveId: mistaken.archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [mistaken.archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    );
    const replacement = access.catalog.completeCatalogReviewWithReplacements(
      mistaken.archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [mistaken.archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
      }],
    ).replacementEncodeJobs[0]!;

    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const response = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?encodingProfileId=${profile.id}`,
      ),
      () => access,
      config,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      counts: { notEncoded: 1, reEncode: 0 },
      selections: [expect.objectContaining({
        id: correction.discSelection.id,
        hasCompletedEncode: false,
        logicalJob: null,
      })],
    }));
    expect(replacement).toMatchObject({
      predecessorEncodeJobId: predecessor.id,
      discSelectionId: correction.discSelection.id,
      encodingProfileId: profile.id,
      status: "queued",
    });

    const replacementClaim = access.encodeJobs.claimNext(
      "corrected-tentative-worker",
    );
    if (!replacementClaim || replacementClaim.id !== replacement.id) {
      throw new Error("Expected corrected replacement claim");
    }
    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update encode_jobs
      set status = 'completed',
          completed_at = updated_at,
          publication_pending = 1,
          publication_completion_pending = 1,
          partial_cleanup_output_path = output_path,
          partial_cleanup_claim_token = ?,
          partial_cleanup_lease_token = NULL
      where id = ?
    `).run(replacementClaim.claimToken, replacement.id);
    sqlite.close();
    const expectNotEncoded = async () => {
      const pendingResponse = await createEncodeJobsRoute(
        new Request("http://localhost:3000/api/encode-jobs"),
        () => access,
        config,
      );
      expect(await pendingResponse.json()).toEqual(expect.objectContaining({
        counts: { notEncoded: 1, reEncode: 0 },
        selections: [expect.objectContaining({
          id: correction.discSelection.id,
          hasCompletedEncode: false,
        })],
      }));
    };

    await expectNotEncoded();
    const renewed = access.encodeJobs.renewPublishedPartial({
      jobId: replacement.id,
      outputPath: replacement.outputPath,
      claimToken: replacementClaim.claimToken,
      leaseToken: null,
      publicationPending: true,
    }, () => true);
    await expectNotEncoded();
    expect(access.encodeJobs.completePartialCleanup(renewed)).toMatchObject({
      completedAt: null,
      status: "failed",
    });
    await expectNotEncoded();
  });

  it("keeps tentative first publication out of history through recovery", async () => {
    const { access, databasePath } = dataAccessFixture.createWithDatabasePath();
    const candidate = createSelection(access, "tentative-completion");
    completeCatalogReview(access, candidate.archive.id);
    const profile = access.encodingProfiles.create({
      key: "tentative-completion-profile",
      displayName: "Tentative completion profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: candidate.selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Tentative completion.mkv",
    });
    const claim = access.encodeJobs.claimNext("tentative-completion-worker");
    if (!claim) {
      throw new Error("Expected tentative-completion Encode Job claim");
    }

    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update encode_jobs
      set status = 'completed',
          completed_at = updated_at,
          publication_pending = 1,
          publication_completion_pending = 1,
          partial_cleanup_output_path = output_path,
          partial_cleanup_claim_token = ?,
          partial_cleanup_lease_token = NULL
      where id = ?
    `).run(claim.claimToken, job.id);
    sqlite.close();
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });

    const expectNotEncoded = async (
      status: "completed" | "failed",
      queueAvailable: boolean,
    ) => {
      const notEncodedResponse = await createEncodeJobsRoute(
        new Request(
          `http://localhost:3000/api/encode-jobs?encodingProfileId=${profile.id}`,
        ),
        () => access,
        config,
      );
      expect(await notEncodedResponse.json()).toEqual(expect.objectContaining({
        counts: { notEncoded: 1, reEncode: 0 },
        selections: [expect.objectContaining({
          id: candidate.selection.id,
          hasCompletedEncode: false,
          logicalJob: expect.objectContaining({
            id: job.id,
            status,
            queueAvailable,
          }),
        })],
      }));

      const reEncodeResponse = await createEncodeJobsRoute(
        new Request(
          "http://localhost:3000/api/encode-jobs?historyGroup=re_encode",
        ),
        () => access,
        config,
      );
      expect(await reEncodeResponse.json()).toEqual(expect.objectContaining({
        counts: { notEncoded: 1, reEncode: 0 },
        selections: [],
      }));
    };

    await expectNotEncoded("completed", false);
    const renewed = access.encodeJobs.renewPublishedPartial({
      jobId: job.id,
      outputPath: job.outputPath,
      claimToken: claim.claimToken,
      leaseToken: null,
      publicationPending: true,
    }, () => true);
    await expectNotEncoded("completed", false);
    expect(access.encodeJobs.completePartialCleanup(renewed)).toMatchObject({
      completedAt: null,
      status: "failed",
    });
    await expectNotEncoded("failed", true);
  });

  it("searches complete history groups while keeping counts and pages stable", async () => {
    const { access, databasePath } = dataAccessFixture.createWithDatabasePath();
    const notEncoded = Array.from({ length: 101 }, (_, index) => {
      const candidate = createSelection(
        access,
        `bounded-${String(index).padStart(3, "0")}`,
      );
      completeCatalogReview(access, candidate.archive.id);
      return candidate;
    });
    const completed = [
      createSelection(access, "bounded-reencode-zulu"),
      createSelection(access, "bounded-reencode-alpha"),
    ];
    for (const candidate of completed) {
      completeCatalogReview(access, candidate.archive.id);
    }
    const sqlite = new DatabaseSync(databasePath);
    const setReviewedAt = sqlite.prepare(`
      update original_disc_archives
      set catalog_reviewed_at = ?, updated_at = ?
      where id = ?
    `);
    notEncoded.forEach((candidate, index) => {
      const reviewedAt = 1_700_000_000_000 + index;
      setReviewedAt.run(reviewedAt, reviewedAt, candidate.archive.id);
    });
    sqlite.close();
    const profile = access.encodingProfiles.create({
      key: "bounded-selection-profile",
      displayName: "Bounded selection profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    for (const [index, candidate] of completed.entries()) {
      access.encodeJobs.enqueue({
        discSelectionId: candidate.selection.id,
        encodingProfileId: profile.id,
        outputPath: `/media/movies/Bounded completed ${index}.mkv`,
      });
      const claim = access.encodeJobs.claimNext(
        `bounded-selection-worker-${index}`,
      );
      if (!claim) {
        throw new Error("Expected bounded selection Encode Job claim");
      }
      access.encodeJobs.complete(claim);
    }
    const config = () => ({
      mediaLibraryPath: "/media/movies",
      webTrustedOrigin: "http://localhost:3000",
    });
    const orderedNotEncoded = [...notEncoded].reverse();

    const firstResponse = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs"),
      () => access,
      config,
    );
    const firstPage = await firstResponse.json();
    expect(firstPage.selections).toHaveLength(100);
    expect(firstPage.selections.map((selection: { id: string }) => selection.id))
      .toEqual(
        orderedNotEncoded.slice(0, 100).map(({ selection }) => selection.id),
      );
    expect(firstPage.counts).toEqual({ notEncoded: 101, reEncode: 2 });
    expect(firstPage.page).toEqual({
      offset: 0,
      limit: 100,
      total: 101,
      hasPrevious: false,
      hasNext: true,
    });

    const secondResponse = await createEncodeJobsRoute(
      new Request(
        "http://localhost:3000/api/encode-jobs?selectionOffset=100",
      ),
      () => access,
      config,
    );
    const secondPage = await secondResponse.json();
    expect(secondPage.selections).toEqual([
      expect.objectContaining({ id: orderedNotEncoded[100]?.selection.id }),
    ]);
    expect(secondPage.counts).toEqual(firstPage.counts);
    expect(secondPage.page).toEqual({
      offset: 100,
      limit: 100,
      total: 101,
      hasPrevious: true,
      hasNext: false,
    });

    const repeatedFirstResponse = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs"),
      () => access,
      config,
    );
    const repeatedFirstPage = await repeatedFirstResponse.json();
    expect(repeatedFirstPage.selections.map(
      (selection: { id: string }) => selection.id,
    )).toEqual(firstPage.selections.map(
      (selection: { id: string }) => selection.id,
    ));
    expect(new Set([
      ...firstPage.selections.map((selection: { id: string }) => selection.id),
      ...secondPage.selections.map((selection: { id: string }) => selection.id),
    ])).toHaveLength(101);

    const outsideFirstPage = notEncoded[0]!;
    const query = "bounded 000 2026 DVD main feature";
    const searchResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?query=${encodeURIComponent(query)}`,
      ),
      () => access,
      config,
    );
    const searchPage = await searchResponse.json();
    expect(searchPage.query).toBe(query);
    expect(searchPage.counts).toEqual(firstPage.counts);
    expect(searchPage.selections).toEqual([
      expect.objectContaining({ id: outsideFirstPage.selection.id }),
    ]);
    expect(searchPage.page).toEqual({
      offset: 0,
      limit: 100,
      total: 1,
      hasPrevious: false,
      hasNext: false,
    });

    const wrongGroupResponse = await createEncodeJobsRoute(
      new Request(
        `http://localhost:3000/api/encode-jobs?historyGroup=re_encode&query=${encodeURIComponent(query)}`,
      ),
      () => access,
      config,
    );
    const wrongGroupPage = await wrongGroupResponse.json();
    expect(wrongGroupPage.counts).toEqual(firstPage.counts);
    expect(wrongGroupPage.selections).toEqual([]);
    expect(wrongGroupPage.page.total).toBe(0);

    const noMatchResponse = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs?query=no-such-title"),
      () => access,
      config,
    );
    const noMatchPage = await noMatchResponse.json();
    expect(noMatchPage.counts).toEqual(firstPage.counts);
    expect(noMatchPage.selections).toEqual([]);
    expect(noMatchPage.page.total).toBe(0);

    const reEncodeResponse = await createEncodeJobsRoute(
      new Request(
        "http://localhost:3000/api/encode-jobs?historyGroup=re_encode",
      ),
      () => access,
      config,
    );
    const reEncodePage = await reEncodeResponse.json();
    expect(reEncodePage.selections.map(
      (selection: { id: string }) => selection.id,
    )).toEqual([
      completed[1]!.selection.id,
      completed[0]!.selection.id,
    ]);
    expect(reEncodePage.counts).toEqual(firstPage.counts);
    expect(reEncodePage.page.total).toBe(2);
  });

  it("rejects malformed Disc Selection search and offset parameters", async () => {
    const access = dataAccessFixture.create();
    const cases = [
      ["query=", "Invalid Disc Selection search query"],
      ["query=---", "Invalid Disc Selection search query"],
      [`query=${"x".repeat(257)}`, "Invalid Disc Selection search query"],
      ["query=first&query=second", "Invalid Disc Selection search query"],
      ["selectionOffset=-1", "Invalid Disc Selection offset"],
      ["selectionOffset=1.5", "Invalid Disc Selection offset"],
      [
        "selectionOffset=1&selectionOffset=2",
        "Invalid Disc Selection offset",
      ],
      ["selectionOffset=12345678901234567", "Invalid Disc Selection offset"],
      ["profileOffset=1&profileOffset=2", "Invalid Encoding Profile offset"],
    ] as const;

    for (const [parameters, error] of cases) {
      const response = await createEncodeJobsRoute(
        new Request(`http://localhost:3000/api/encode-jobs?${parameters}`),
        () => access,
        () => ({
          mediaLibraryPath: "/media/movies",
          webTrustedOrigin: "http://localhost:3000",
        }),
      );
      expect(response.status, parameters).toBe(400);
      expect(await response.json(), parameters).toEqual({ error });
      expect(error.length).toBeLessThanOrEqual(64);
    }
  });

  it("suggests hierarchical and selection-specific final output paths", async () => {
    const access = dataAccessFixture.create();
    const reviewed = createSelection(access, "suggestions");
    const alternateMovieSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: reviewed.archive.id,
      mediaItemId: reviewed.item.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
    });
    const trailer = access.catalog.createMediaItem({
      parentId: reviewed.item.id,
      kind: "trailer",
      title: "Trailer",
    });
    const trailerSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: reviewed.archive.id,
      mediaItemId: trailer.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Example Show",
      year: 2020,
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Season Two",
      seasonNumber: 2,
    });
    const episode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Third Episode",
      episodeNumber: 3,
    });
    const episodeSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: reviewed.archive.id,
      mediaItemId: episode.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 4,
        chapterStart: 1,
        chapterEnd: 2,
      },
    });
    completeCatalogReview(access, reviewed.archive.id);

    const response = await createEncodeJobsRoute(
      new Request("http://localhost:3000/api/encode-jobs"),
      () => access,
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
    );
    const body = await response.json() as {
      selections: Array<{ id: string; suggestedOutputPath: string }>;
    };
    const pathsBySelectionId = new Map(
      body.selections.map((selection) => [
        selection.id,
        selection.suggestedOutputPath,
      ]),
    );
    const movieDirectory = "/media/movies/Encode API suggestions (2026)";

    expect(pathsBySelectionId.get(reviewed.selection.id)).toBe(
      `${movieDirectory}/Encode API suggestions (2026) - DVD main feature ${
        reviewed.selection.id.slice(-8)
      }.mkv`,
    );
    expect(pathsBySelectionId.get(alternateMovieSelection.id)).toBe(
      `${movieDirectory}/Encode API suggestions (2026) - DVD title 2 ${
        alternateMovieSelection.id.slice(-8)
      }.mkv`,
    );
    expect(pathsBySelectionId.get(trailerSelection.id)).toBe(
      `${movieDirectory}/extras/Trailer.mkv`,
    );
    expect(pathsBySelectionId.get(episodeSelection.id)).toBe(
      "/media/movies/Example Show (2020)/Season 02/" +
        "Example Show (2020) - S02E03 - Third Episode.mkv",
    );
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
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
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
      () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: "http://localhost:3000",
      }),
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

    const completedBody = await (await repeatSubmission()).json();
    expect(completedBody.job).toMatchObject({
      id: original.id,
      status: "completed",
      progressPercent: 100,
      outputPath: "/media/movies/Encode API retry.mkv",
      completedAt: expect.any(String),
    });
    expect(access.encodeJobs.claimNext("late-completed-post-retry")).toBeNull();

    expect((await (await retry()).json()).job).toMatchObject({
      id: original.id,
      status: "queued",
      progressPercent: 0,
      completedAt: completedBody.job.completedAt,
    });
    expect(access.encodeJobs.list()).toHaveLength(1);
  });

  it("cancels queued jobs and durably requests running cancellation through a trusted command", async () => {
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
    const requested = await cancel(runningJob.id);
    expect(requested.status).toBe(200);
    expect((await requested.json()).job).toMatchObject({
      id: runningJob.id,
      status: "cancellation_requested",
    });
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
        [runningJob.id, "cancellation_requested"],
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
