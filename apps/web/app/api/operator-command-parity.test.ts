import { expect, it } from "vitest";
import { join } from "node:path";
import { createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import type { CatalogMetadataLookup } from "@rip-dvd/application";

import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../operator-cli/src/operator-workflow.test-support.js";
import { createCatalogReviewRoute } from "./catalog-reviews/[id]/route";
import { createCatalogSuggestionRoute } from "./catalog-reviews/[id]/suggestion/route";
import { createDeploymentReadinessResponse } from "./deployment-readiness/route";
import { createHealthResponse } from "./health/route";
import { createOperationsResponse } from "./operations/route";

it("returns the same health and readiness results through web and CLI adapters", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const healthResponse = createHealthResponse(access);
    const readinessResponse = createDeploymentReadinessResponse(access);

    expect(healthResponse.status).toBe(200);
    expect(readinessResponse.status).toBe(200);
    expect(healthResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(readinessResponse.headers.get("Cache-Control")).toBe("no-store");
    expect((await fixture.run(["health"])).result).toEqual(await healthResponse.json());
    expect((await fixture.run(["readiness"])).result).toEqual(await readinessResponse.json());
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("returns the same Catalog Review detail and candidates through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, previousSelection, correctedSelection, predecessor } =
    seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  const selectionsBefore = access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id });
  const lookup: CatalogMetadataLookup = {
    search: async () => [{ id: 42, kind: "movie", title: "Example Film", year: 2020 }],
    getTvDetails: async () => ({ seasons: [] }),
    getTvSeason: async () => { throw new Error("Unexpected season request"); },
  };
  try {
    const detail = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
      undefined,
      () => false,
    );
    expect(detail.status).toBe(200);
    const detailResult = await detail.json();
    expect(detailResult).toMatchObject({
      reviewActionAvailability: {
        completeWithSelections: { state: "available", reason: null },
        completeArchiveOnly: {
          state: "blocked",
          reason: "Archive-only Review cannot contain Disc Selections",
        },
      },
      discSelections: [{
        id: correctedSelection.id,
        actionAvailability: {
          state: "correction_lineage",
          availableActions: ["correct", "remove"],
          reason: expect.stringContaining("immutable correction lineage"),
        },
      }],
      correctionHistory: [{
        supersededDiscSelection: { id: previousSelection.id },
        replacementDiscSelection: { id: correctedSelection.id },
      }],
      correctionEncodeHistory: [{ predecessorEncodeJob: { id: predecessor.id } }],
    });
    expect((await fixture.run(["catalog-review", "show", archive.id], null)).result)
      .toEqual(detailResult);

    const suggestion = await createCatalogSuggestionRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`),
      archive.id,
      () => access,
      () => lookup,
    );
    expect(suggestion.status).toBe(200);
    expect((await fixture.run(["catalog-review", "suggest", archive.id], lookup)).result)
      .toEqual(await suggestion.json());

    access.catalog.createMediaItem({ kind: "movie", title: "Example Film", year: 2020 });
    access.catalog.createMediaItem({ kind: "movie", title: "EXAMPLE FILM", year: 2020 });
    const blocked = await createCatalogSuggestionRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`),
      archive.id,
      () => access,
      () => lookup,
    );
    const blockedResult = await blocked.json();
    expect(blockedResult).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_catalog_match",
      candidates: [{ id: 42, kind: "movie", title: "Example Film", year: 2020 }],
    });
    expect((await fixture.run(["catalog-review", "suggest", archive.id], lookup)).result)
      .toEqual(blockedResult);

    const uncertainLookup: CatalogMetadataLookup = {
      ...lookup,
      search: async () => [
        { id: 42, kind: "movie", title: "Example Film", year: 2020 },
        { id: 43, kind: "movie", title: "Example Film", year: 2020 },
      ],
    };
    const uncertain = await createCatalogSuggestionRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`),
      archive.id,
      () => access,
      () => uncertainLookup,
    );
    const uncertainResult = await uncertain.json();
    expect(uncertainResult).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      candidates: [{ id: 42 }, { id: 43 }],
    });
    expect((await fixture.run(["catalog-review", "suggest", archive.id], uncertainLookup)).result)
      .toEqual(uncertainResult);
    expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id }))
      .toEqual(selectionsBefore);
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("returns the same operational records and evidence through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0", isEnabled: true, isPresent: true,
    });
    const started = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "synthetic-generation",
      mediaCapacityBytes: 2_048,
    });
    access.discInspections.record(started.claim!, {
      type: "fail", reasonCode: "metadata_read_failed", diagnostic: "synthetic read failure",
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "synthetic-fingerprint",
      volumeLabel: "SYNTHETIC_DISC",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const archiveDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1", isEnabled: true, isPresent: true,
    });
    const archivedDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: archiveDrive.id,
      discKind: "dvd",
      fingerprint: "synthetic-archived-fingerprint",
      volumeLabel: "SYNTHETIC_ARCHIVED_DISC",
    });
    access.catalog.updateDetectedDiscStatus(archivedDisc.id, "scanned");
    const settled = beginSettledDiscInspectionForTest(access, {
      opticalDriveId: archiveDrive.id,
      mediaGeneration: "synthetic-archived-generation",
      mediaCapacityBytes: 2_048,
    });
    access.discInspections.record(settled.claim, {
      type: "metadata", volumeLabel: archivedDisc.volumeLabel,
      titleCount: 0, chapterCount: 0, audioStreamCount: 0,
      subtitleStreamCount: 0, totalBytes: 2_048,
    });
    const completedInspection = access.discInspections.record(settled.claim, {
      type: "complete", detectedDiscId: archivedDisc.id,
    });
    settled.restoreSystemTime();
    access.archiveRequests.create({ detectedDiscId: archivedDisc.id });
    const job = access.archiveJobs.startForInspection(
      completedInspection.id, "synthetic-worker",
    )!;
    const completedJob = access.archiveJobs.publish(job, {
      archivePath: join(fixture.originalsLibraryPath, "synthetic.iso"),
      sizeBytes: 2_048,
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(2_048),
      integrityEvidence: createCleanReadArchiveIntegrityEvidence("dvd-recovery-v1"),
    });
    const archiveId = completedJob.originalDiscArchiveId!;
    const mediaItem = access.catalog.createMediaItem({ kind: "movie", title: "Synthetic Film" });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archiveId,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const revisedArchive = access.catalog.listOriginalDiscArchives({ ids: [archiveId] })[0]!;
    access.catalog.completeCatalogReview(
      archiveId, revisedArchive.updatedAt, "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "synthetic-parity", displayName: "Synthetic parity", mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });
    const encodeJob = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: join(fixture.mediaLibraryPath, "synthetic.mkv"),
    });
    const encodeClaim = access.encodeJobs.claimNext("synthetic-encode-worker")!;
    access.encodeJobs.failWithReport(encodeClaim, {
      schemaVersion: 1, reasonCode: "command_failed", phase: "encoding",
      retryability: "appropriate", diagnostic: "Synthetic encode failure",
      evidence: { kind: "exit_status", exitStatus: 17 },
    });
    const incident = access.workerIncidents.record({
      schemaVersion: 1,
      workerKind: "archive",
      reasonCode: "poll_failure",
      phase: "polling",
      retryability: "automatic",
      evidence: {},
    });

    for (const kind of [
      "optical-drives", "detected-discs", "disc-inspections", "archive-requests",
      "archive-jobs", "original-disc-archives", "encode-jobs", "worker-incidents", "activity",
    ]) {
      const response = createOperationsResponse(access,
        new Request(`http://localhost/api/operations?kind=${kind}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect((await fixture.run(["inspect", kind])).result).toEqual(await response.json());
    }
    for (const [kind, id] of [
      ["optical-drives", drive.id],
      ["detected-discs", disc.id],
      ["disc-inspections", started.inspection.id],
      ["archive-requests", request.id],
      ["archive-jobs", completedJob.id],
      ["original-disc-archives", archiveId],
      ["encode-jobs", encodeJob.id],
      ["worker-incidents", incident.id],
    ]) {
      const response = createOperationsResponse(access,
        new Request(`http://localhost/api/operations?kind=${kind}&id=${id}`));
      expect(response.status).toBe(200);
      expect((await fixture.run(["inspect", kind, id])).result).toEqual(await response.json());
    }
    expect((await fixture.run(["inspect", "disc-inspections", started.inspection.id])).result)
      .toMatchObject({ item: {
        attempts: [expect.objectContaining({ reasonCode: "metadata_read_failed" })],
        availableActions: [expect.objectContaining({ eligible: true })],
      } });
    expect((await fixture.run(["inspect", "original-disc-archives", archiveId])).result)
      .toMatchObject({ item: {
        boundaryReportedSizeBytes: 2_048,
        boundaryPublishedSizeBytes: 2_048,
        integrity: "clean_read",
      } });
    expect((await fixture.run(["inspect", "encode-jobs", encodeJob.id])).result)
      .toMatchObject({ item: {
        status: "failed",
        history: [expect.objectContaining({ id: encodeJob.id })],
        correctionLinks: [expect.objectContaining({ id: encodeJob.id })],
        failureReports: [expect.objectContaining({ reasonCode: "command_failed" })],
        availableActions: expect.arrayContaining([
          expect.objectContaining({ name: "requeue", eligible: true }),
        ]),
      } });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("shares Encoding Profile validation, replay, preview, and activation between web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  const { createEncodingProfilesRoute } = await import("./encoding-profiles/route");
  const endpoint = "http://localhost/api/encoding-profiles";
  const trustedOrigin = () => "http://localhost";
  const mutate = (method: "POST" | "PATCH", body: unknown) =>
    createEncodingProfilesRoute(new Request(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost",
      },
      body: JSON.stringify(body),
    }), () => access, trustedOrigin);
  try {
    const key = "synthetic-profile-parity-key-0001";
    const created = await mutate("POST", {
      mutationKey: key, key: "synthetic-parity", displayName: "Synthetic parity",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { profile: { id: string } };
    expect((await fixture.run([
      "create-encoding-profile", "--key", key, "--profile-key", "synthetic-parity",
      "--display-name", "Synthetic parity", "--preset", "Fast 480p30",
    ])).result).toEqual(createdBody);

    const version = await fixture.run([
      "version-encoding-profile", "--key", "synthetic-profile-parity-key-0002",
      "--source-profile-id", createdBody.profile.id, "--preset", "HQ 480p30 Surround",
    ]);
    expect(version.exitCode).toBe(0);
    const versionBody = version.result as { profile: { id: string } };
    const webReplay = await mutate("POST", {
      mutationKey: "synthetic-profile-parity-key-0002",
      sourceProfileId: createdBody.profile.id,
      settings: { preset: "HQ 480p30 Surround", container: "mkv" },
    });
    expect(webReplay.status).toBe(201);
    expect(await webReplay.json()).toEqual(versionBody);

    const previewUrl = `${endpoint}?preview-profile-id=${encodeURIComponent(versionBody.profile.id)}&is-active=true`;
    const webPreview = await createEncodingProfilesRoute(
      new Request(previewUrl), () => access, trustedOrigin,
    );
    expect(webPreview.status).toBe(200);
    const preview = await webPreview.json() as { revision: string };
    expect((await fixture.run([
      "preview-encoding-profile-state", "--id", versionBody.profile.id, "--active", "true",
    ])).result).toEqual({ ...preview });
    const activated = await mutate("PATCH", {
      mutationKey: "synthetic-profile-parity-key-0003",
      id: versionBody.profile.id, isActive: true,
      expectedRevision: preview.revision, acknowledge: true,
    });
    expect(activated.status).toBe(200);
    expect((await fixture.run([
      "activate-encoding-profile", "--key", "synthetic-profile-parity-key-0003",
      "--id", versionBody.profile.id, "--revision", preview.revision, "--acknowledge",
    ])).result).toEqual(await activated.json());
    const list = await createEncodingProfilesRoute(
      new Request(endpoint), () => access, trustedOrigin,
    );
    expect((await fixture.run(["list-encoding-profiles"])).result).toEqual(await list.json());
  } finally {
    access.close();
    fixture.dispose();
  }
});
