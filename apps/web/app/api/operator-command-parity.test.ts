import { expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  archiveBoundaryEvidenceFromRecord,
  createCleanReadArchiveIntegrityEvidence,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  createDvdStructuralAssessment,
  dvdTitleIdentityCatalogMappingProjectionDigest,
  DVD_RECOVERY_EVIDENCE_ADMISSION,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  MAX_DVD_TITLES,
} from "@rip-dvd/data-access";
import {
  beginSettledDiscInspectionForTest,
  createDvdRecoveryEvidenceEncodingTestAccess,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import {
  createApplicationOperations,
  describeCatalogReviewWorkflow,
  encodeOutputArtifactIdentity,
  type CatalogMetadataLookup,
  type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import type {
  ArchiveRequestId,
  MediaItemId,
} from "@rip-dvd/data-access";
import {
  createArchiveImageOwnership,
  defaultArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import {
  createOperatorWorkflowFixture,
  markArchiveWithDvdRecoveryEvidence,
  seedCatalogReviewForReadFixture,
  seedRearchiveCatalogReviewFixture,
} from "../../../operator-cli/src/operator-workflow.test-support.js";
import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
  withEvidenceGuardsDisabled,
} from "../../../operator-cli/src/archive-evidence.test-support.js";
import { createCatalogReviewRoute } from "./catalog-reviews/[id]/route";
import {
  createCatalogTitleDamageRoute,
} from "./catalog-reviews/[id]/damage/route";
import { createCatalogSuggestionRoute } from "./catalog-reviews/[id]/suggestion/route";
import { createDeploymentReadinessResponse } from "./deployment-readiness/route";
import { createDashboardRoute } from "./dashboard/route";
import { createHealthResponse } from "./health/route";
import { createOperationsResponse } from "./operations/route";
import { createArchiveRequestsRoute } from "./archive-requests/route";
import { createRearchiveRequestsRoute } from "./rearchive-requests/route";
import {
  createArchiveRequestCancellationRoute,
} from "./archive-requests/[id]/route";
import {
  createArchiveRequestRetryRoute,
} from "./archive-requests/[id]/retry/route";
import { createMediaItemSearchRoute } from "./media-items/route";
import { createMediaItemPreviewRoute } from "./media-items/[id]/route";
import { createEncodeJobsRoute } from "./encode-jobs/route";
import {
  createEncodeOutputInspectionRoute,
} from "./encode-outputs/[artifactIdentity]/route";
import {
  createFilesystemVerificationInventoryRoute,
} from "./filesystem-verification/route";
import { readDashboardSnapshot } from "../../lib/dashboard";

const trustedOrigin = "http://localhost:3000";

it("keeps recovering Catalog Review facts and mapping identical through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seedAccess = createLegacySidecarDataAccess({
    databasePath: fixture.databasePath,
    mediaLibraryPath: fixture.mediaLibraryPath,
    originalsLibraryPath: fixture.originalsLibraryPath,
  });
  const drive = seedAccess.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-review-recovery",
    isPresent: true,
  });
  const fingerprint = `sha256:${"7".repeat(64)}`;
  const disc = seedAccess.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: "SYNTHETIC_REVIEW_RECOVERY",
    scanData: {
      schemaVersion: 2,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 5_400,
        chapters: 12,
        audioStreams: [],
        subtitles: [],
      }, {
        number: 2,
        durationSeconds: 2_700,
        chapters: 6,
        audioStreams: [],
        subtitles: [],
      }],
    },
  });
  seedAccess.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  seedAccess.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = seedAccess.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: "/media/originals/synthetic-review-recovery.iso",
    fingerprint,
  });
  const mediaItem = seedAccess.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic recovery mapping",
  });
  const secondMediaItem = seedAccess.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic recovery mapping two",
  });
  seedAccess.close();
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    archive.id,
    "synthetic-review-recovery",
    {
      archiveRecovery: {
        id: "synthetic-review-recovery-id",
        workStatus: "claimed",
      },
    },
  );
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare(`
    UPDATE archive_recoveries
    SET status = 'running', updated_at = 2
    WHERE original_disc_archive_id = ?
  `).run(archive.id);
  sqlite.close();

  const access = fixture.openAccess();
  const checkpoint = access.catalog.findDvdArchiveEvidenceHeader(archive.id)!;
  const pendingWebReview = await createCatalogReviewRoute(
    new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
    archive.id,
    () => access,
    () => trustedOrigin,
  );
  const pendingCliReview = await fixture.run([
    "catalog-review",
    "show",
    archive.id,
  ]);
  expect(pendingWebReview.status).toBe(200);
  expect(pendingCliReview.result).toEqual(await pendingWebReview.json());
  const pending = pendingCliReview.result as {
    catalogRevision: string;
    automaticCataloging: { configured: boolean };
    reviewWorkflow: {
      actions: Array<{
        action: string;
        available: boolean;
        reasons: Array<{ code: string }>;
      }>;
    };
  };
  expect(pending.reviewWorkflow.actions.find(({ action }) =>
    action === "catalog_mapping"
  )).toMatchObject({
    available: false,
    reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
  });
  expect(pending.automaticCataloging).toEqual({ configured: false });
  const automaticSearch = vi.fn(async () => [{
    id: 101,
    kind: "movie" as const,
    title: "Synthetic Review Recovery",
    year: 2026,
  }]);
  const lookup: CatalogMetadataLookup = {
    search: automaticSearch,
    getTvDetails: async () => ({ seasons: [] }),
    getTvSeason: async () => {
      throw new Error("Unexpected season lookup");
    },
  };
  const webSuggestion = await createCatalogSuggestionRoute(
    new Request(
      `${trustedOrigin}/api/catalog-reviews/${archive.id}/suggestion`,
    ),
    archive.id,
    () => access,
    () => lookup,
  );
  const cliSuggestion = await fixture.run([
    "catalog-review",
    "suggest",
    archive.id,
  ], lookup);
  expect(webSuggestion.status).toBe(200);
  expect(cliSuggestion.exitCode).toBe(0);
  expect(cliSuggestion.result).toEqual(await webSuggestion.json());
  expect(cliSuggestion.result).toMatchObject({
    status: "needs_review",
    reason: "manual_mapping_required",
  });
  expect(automaticSearch).not.toHaveBeenCalled();
  const pendingWebMapping = await createCatalogReviewRoute(
    catalogReviewMutationRequest(archive.id, {
      action: "create_disc_selection",
      catalogRevision: pending.catalogRevision,
      mutationKey: "00000000-0000-4000-8000-000000000395",
      selection: {
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    }),
    archive.id,
    () => access,
    () => trustedOrigin,
  );
  const pendingCliMapping = await fixture.run([
    "disc-selection",
    "create",
    archive.id,
    "--key",
    "00000000-0000-4000-8000-000000000396",
    "--revision",
    pending.catalogRevision,
    "--media-item-id",
    mediaItem.id,
    "--source-kind",
    "dvd_title",
    "--title-number",
    "1",
  ]);
  expect(pendingWebMapping.status).toBe(409);
  expect(pendingCliMapping.exitCode).toBe(2);
  expect(pendingCliMapping.result).toEqual(await pendingWebMapping.json());
  expect(pendingCliMapping.result).toMatchObject({
    error: {
      code: "CATALOG_MAPPING_UNAVAILABLE",
      reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
      current: { catalogMappingProjectionId: null },
    },
  });
  const pendingProposal = {
    action: "create_mapping_proposal" as const,
    catalogRevision: pending.catalogRevision,
    target: {
      choice: "create_new" as const,
      mediaItem: { kind: "movie" as const, title: "Pending proposal" },
    },
    discSelection: {
      sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
    },
  };
  const pendingWebProposal = await createCatalogReviewRoute(
    catalogReviewMutationRequest(archive.id, {
      ...pendingProposal,
      mutationKey: "00000000-0000-4000-8000-000000000401",
    }),
    archive.id,
    () => access,
    () => trustedOrigin,
  );
  const pendingCliProposal = await fixture.run([
    "catalog-review",
    "apply-proposal",
    archive.id,
    "--key",
    "00000000-0000-4000-8000-000000000402",
    "--json",
    JSON.stringify(pendingProposal),
  ]);
  expect(pendingWebProposal.status).toBe(409);
  expect(pendingCliProposal.exitCode).toBe(2);
  expect(pendingCliProposal.result).toEqual(await pendingWebProposal.json());
  expect(pendingCliProposal.result).toMatchObject({
    error: {
      code: "CATALOG_MAPPING_UNAVAILABLE",
      reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
      current: { catalogMappingProjectionId: null },
    },
  });
  const reviewSet = access.catalog.recordDvdTitleIdentityObservations({
    originalDiscArchiveId: archive.id,
    checkpoint: {
      manifestId: checkpoint.currentManifestId,
      manifestRevision: checkpoint.currentManifestRevision,
      manifestDigest: checkpoint.currentManifestDigest,
    },
    observations: [{
      displayTitleNumber: 1,
      navigation: {
        videoTitleSetNumber: 1,
        titleSetTitleNumber: 1,
        programChainNumber: 1,
      },
      selectedPath: [{
        programNumber: 1,
        cellNumber: 1,
        vobId: 1,
        cellId: 1,
      }],
      angleNumber: 1,
      angleCount: 2,
      chapterStart: 1,
      chapterEnd: 12,
      chapterCount: 12,
      sourceExtents: [{ startLba: 0, sectorCount: 1 }],
    }, {
      displayTitleNumber: 1,
      navigation: {
        videoTitleSetNumber: 1,
        titleSetTitleNumber: 1,
        programChainNumber: 1,
      },
      selectedPath: [{
        programNumber: 1,
        cellNumber: 1,
        vobId: 1,
        cellId: 2,
      }],
      angleNumber: 2,
      angleCount: 2,
      chapterStart: 1,
      chapterEnd: 12,
      chapterCount: 12,
      sourceExtents: [{ startLba: 0, sectorCount: 1 }],
    }, {
      displayTitleNumber: 3,
      navigation: {
        videoTitleSetNumber: 2,
        titleSetTitleNumber: 1,
        programChainNumber: 1,
      },
      selectedPath: [{
        programNumber: 1,
        cellNumber: 1,
        vobId: 2,
        cellId: 1,
      }],
      angleNumber: 1,
      angleCount: 1,
      chapterStart: 1,
      chapterEnd: 6,
      chapterCount: 6,
      sourceExtents: [{ startLba: 0, sectorCount: 1 }],
    }],
  });

  const readBoth = async () => {
    const web = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const cli = await fixture.run(["catalog-review", "show", archive.id]);
    expect(web.status).toBe(200);
    expect(cli.exitCode, JSON.stringify(cli.result)).toBe(0);
    expect(cli.result).toEqual(await web.json());
    return cli.result as {
      catalogRevision: string;
      reviewOutcome: string;
      reviewWorkflow: {
        facts: Record<string, unknown>;
        current: Record<string, unknown>;
        actions: Array<{
          action: string;
          available: boolean;
          reasons: Array<{ code: string }>;
        }>;
      };
    };
  };

  try {
    const before = await readBoth();
    expect(before.reviewWorkflow).toMatchObject({
      facts: {
        saved: true,
        recovering: true,
        mapped: false,
        mappingState: "unmapped",
        readyForDamageDecision: false,
        readyForEncoding: false,
      },
      current: {
        originalDiscArchiveId: archive.id,
        archiveJob: { status: "completed" },
        checkpoint: { revision: 1 },
        recovery: {
          id: "synthetic-review-recovery-id",
          state: "running",
          work: { status: "claimed" },
        },
        catalogMappingProjectionId:
          dvdTitleIdentityCatalogMappingProjectionDigest(
            reviewSet.checkpoint,
            reviewSet.items,
          ),
        titleDamageAssessmentId: null,
      },
      actions: [
        { action: "catalog_mapping", available: true, reasons: [] },
        {
          action: "damage_decision",
          available: false,
          reasons: [
            { code: "ASSESSMENT_PENDING" },
            { code: "RECOVERY_ACTIVE" },
            { code: "SELECTION_UNIDENTIFIED" },
            { code: "CATALOG_DAMAGE_DECISION_UNAVAILABLE" },
          ],
        },
        { action: "encode", available: false },
      ],
    });
    const dashboardResponse = createDashboardRoute(
      () => access,
      new Request(
        `${trustedOrigin}/api/dashboard?catalogReviewView=needs_review`,
      ),
    );
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json();
    expect(dashboard.catalogReview.status).toBe("loaded");
    if (dashboard.catalogReview.status !== "loaded") {
      throw new Error("Catalog Review dashboard is unavailable");
    }
    expect(
      dashboard.catalogReview.items.find(
        ({ id }: { id: string }) => id === archive.id,
      )
        ?.reviewWorkflow,
    ).toEqual(before.reviewWorkflow);

    const mixedWorkflow = describeCatalogReviewWorkflow(
      access,
      archive.id,
      {
        archiveJobs: access.archiveJobs.listForArchive(archive.id),
        evidenceHeader: checkpoint,
        recovery: access.catalog.findArchiveRecovery(archive.id),
        titleIdentity: {
          catalogMappingProjectionId:
            dvdTitleIdentityCatalogMappingProjectionDigest(
              reviewSet.checkpoint,
              reviewSet.items,
            ),
          currentMappingStates: [
            "needs_mapping_review",
            "unmapped",
          ],
          currentDefaultAngleTitleCount: reviewSet.items.filter((item) =>
            item.presentAtCurrentCheckpoint &&
            item.observation.angleNumber === 1
          ).length,
        },
        titleDamage: {
          state: "pending",
          currentAssessmentIdentity: null,
          acceptanceRequired: false,
        },
      },
    );
    expect(
      mixedWorkflow?.actions.find(({ action }) =>
        action === "damage_decision"
      )?.reasons.map(({ code }) => code),
    ).toEqual([
      "ASSESSMENT_PENDING",
      "RECOVERY_ACTIVE",
      "MAPPING_REVIEW_REQUIRED",
      "SELECTION_UNIDENTIFIED",
      "CATALOG_DAMAGE_DECISION_UNAVAILABLE",
    ]);

    const missingRevisionWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "create_disc_selection",
        mutationKey: "00000000-0000-4000-8000-000000000413",
        selection: {
          mediaItemId: mediaItem.id,
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const missingRevisionCli = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000414",
      "--media-item-id",
      mediaItem.id,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "1",
    ]);
    expect(missingRevisionWeb.status).toBe(409);
    expect(missingRevisionCli.exitCode).toBe(2);
    expect(missingRevisionCli.result).toEqual(
      await missingRevisionWeb.json(),
    );
    expect(missingRevisionCli.result).toEqual({
      error: {
        code: "CATALOG_MAPPING_REVISION_REQUIRED",
        message:
          "Catalog mapping requires the reviewed Catalog Review revision",
      },
    });

    const unsupportedWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "create_disc_selection",
        catalogRevision: before.catalogRevision,
        mutationKey: "00000000-0000-4000-8000-000000000405",
        selection: {
          mediaItemId: mediaItem.id,
          sourceIdentity: { kind: "main_feature" },
        },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const unsupportedCli = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000406",
      "--revision",
      before.catalogRevision,
      "--media-item-id",
      mediaItem.id,
      "--source-kind",
      "main_feature",
    ]);
    expect(unsupportedWeb.status).toBe(409);
    expect(unsupportedCli.exitCode).toBe(2);
    expect(unsupportedCli.result).toEqual(await unsupportedWeb.json());
    expect(unsupportedCli.result).toEqual({
      error: {
        code: "CATALOG_MAPPING_SOURCE_UNSUPPORTED",
        message:
          "Current-evidence mapping requires an exact DVD title or chapter range",
      },
    });

    const absentTitleWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "create_disc_selection",
        catalogRevision: before.catalogRevision,
        mutationKey: "00000000-0000-4000-8000-000000000409",
        selection: {
          mediaItemId: mediaItem.id,
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const absentTitleCli = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000410",
      "--revision",
      before.catalogRevision,
      "--media-item-id",
      mediaItem.id,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "2",
    ]);
    expect(absentTitleWeb.status).toBe(409);
    expect(absentTitleCli.exitCode).toBe(2);
    expect(absentTitleCli.result).toEqual(await absentTitleWeb.json());
    expect(absentTitleCli.result).toEqual({
      error: {
        code: "CATALOG_MAPPING_SOURCE_NOT_CURRENT",
        message:
          "Catalog mapping source is not present in current Title Identity evidence",
      },
    });

    const outOfRangeProposal = {
      action: "create_mapping_proposal" as const,
      catalogRevision: before.catalogRevision,
      target: {
        choice: "create_new" as const,
        mediaItem: { kind: "movie" as const, title: "Synthetic chapter target" },
      },
      discSelection: {
        sourceIdentity: {
          kind: "dvd_chapters" as const,
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 13,
        },
      },
    };
    const outOfRangeWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...outOfRangeProposal,
        mutationKey: "00000000-0000-4000-8000-000000000411",
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const outOfRangeCli = await fixture.run([
      "catalog-review",
      "apply-proposal",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000412",
      "--json",
      JSON.stringify(outOfRangeProposal),
    ]);
    expect(outOfRangeWeb.status).toBe(409);
    expect(outOfRangeCli.exitCode).toBe(2);
    expect(outOfRangeCli.result).toEqual(await outOfRangeWeb.json());
    expect(outOfRangeCli.result).toEqual(absentTitleCli.result);

    const firstMutationKey = "00000000-0000-4000-8000-000000000397";
    const firstSelectionCommand = {
      action: "create_disc_selection" as const,
      catalogRevision: before.catalogRevision,
      selection: {
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
      },
    };
    const mappedFirstWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...firstSelectionCommand,
        mutationKey: firstMutationKey,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const mappedFirst = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      firstMutationKey,
      "--revision",
      before.catalogRevision,
      "--media-item-id",
      mediaItem.id,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "1",
    ]);
    expect(mappedFirstWeb.status).toBe(201);
    expect(mappedFirst.exitCode, JSON.stringify(mappedFirst.result)).toBe(0);
    expect(mappedFirst.result).toEqual(await mappedFirstWeb.json());
    const firstSelectionId = (mappedFirst.result as {
      discSelection: { id: string };
    }).discSelection.id;
    const afterFirst = await readBoth();
    const missingPreviewRevisionCommand = {
      action: "update_disc_selection" as const,
      discSelectionId: firstSelectionId,
      changes: {
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
      },
    };
    const missingPreviewRevisionWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...missingPreviewRevisionCommand,
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const missingPreviewRevisionCli = await fixture.run([
      "disc-selection",
      "preview",
      "update",
      archive.id,
      firstSelectionId,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "1",
    ]);
    expect(missingPreviewRevisionWeb.status).toBe(409);
    expect(missingPreviewRevisionCli.exitCode).toBe(2);
    expect(missingPreviewRevisionCli.result).toEqual(
      await missingPreviewRevisionWeb.json(),
    );
    expect(missingPreviewRevisionCli.result).toEqual(
      missingRevisionCli.result,
    );
    const missingLabelRevisionWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        mutationKey: "00000000-0000-4000-8000-000000000415",
        changes: { label: "Synthetic feature" },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const missingLabelRevisionCli = await fixture.run([
      "disc-selection",
      "update",
      archive.id,
      firstSelectionId,
      "--key",
      "00000000-0000-4000-8000-000000000416",
      "--label",
      "Synthetic feature",
    ]);
    expect(missingLabelRevisionWeb.status).toBe(409);
    expect(missingLabelRevisionCli.exitCode).toBe(2);
    expect(missingLabelRevisionCli.result).toEqual(
      await missingLabelRevisionWeb.json(),
    );
    expect(missingLabelRevisionCli.result).toEqual(
      missingRevisionCli.result,
    );
    const staleLabelWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        catalogRevision: before.catalogRevision,
        mutationKey: "00000000-0000-4000-8000-000000000417",
        changes: { label: "Synthetic feature" },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const staleLabelCli = await fixture.run([
      "disc-selection",
      "update",
      archive.id,
      firstSelectionId,
      "--key",
      "00000000-0000-4000-8000-000000000418",
      "--revision",
      before.catalogRevision,
      "--label",
      "Synthetic feature",
    ]);
    expect(staleLabelWeb.status).toBe(409);
    expect(staleLabelCli.exitCode).toBe(2);
    expect(staleLabelCli.result).toEqual(await staleLabelWeb.json());
    const staleWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "create_disc_selection",
        catalogRevision: before.catalogRevision,
        mutationKey: "00000000-0000-4000-8000-000000000399",
        selection: {
          mediaItemId: secondMediaItem.id,
          sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
        },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const staleCli = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000400",
      "--revision",
      before.catalogRevision,
      "--media-item-id",
      secondMediaItem.id,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "3",
    ]);
    expect(staleWeb.status).toBe(409);
    expect(staleCli.exitCode).toBe(2);
    expect(staleCli.result).toEqual(await staleWeb.json());
    expect(staleLabelCli.result).toEqual(staleCli.result);
    expect(staleCli.result).toMatchObject({
      error: {
        code: "STALE_CATALOG_REVISION",
        reasons: [{
          code: "STALE_CATALOG_REVISION",
          details: {
            expectedCatalogRevision: before.catalogRevision,
            currentCatalogRevision: afterFirst.catalogRevision,
          },
        }],
        current: {
          checkpoint: { revision: 1 },
          catalogMappingProjectionId:
            afterFirst.reviewWorkflow.current.catalogMappingProjectionId,
        },
      },
    });
    const staleEpisodicProposal = {
      action: "create_episodic_mapping_proposal" as const,
      catalogRevision: before.catalogRevision,
      tvShow: { choice: "create_new" as const, title: "Stale show" },
      season: {
        choice: "create_new" as const,
        title: "Season One",
        seasonNumber: 1,
      },
      episodes: [{
        titleNumber: 3,
        title: "Stale episode",
        episodeNumber: 1,
      }],
    };
    const staleWebProposal = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...staleEpisodicProposal,
        mutationKey: "00000000-0000-4000-8000-000000000403",
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const staleCliProposal = await fixture.run([
      "catalog-review",
      "apply-proposal",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000404",
      "--json",
      JSON.stringify(staleEpisodicProposal),
    ]);
    expect(staleWebProposal.status).toBe(409);
    expect(staleCliProposal.exitCode).toBe(2);
    expect(staleCliProposal.result).toEqual(await staleWebProposal.json());
    expect(staleCliProposal.result).toMatchObject({
      error: {
        code: "STALE_CATALOG_REVISION",
        reasons: [{
          code: "STALE_CATALOG_REVISION",
          details: {
            expectedCatalogRevision: before.catalogRevision,
            currentCatalogRevision: afterFirst.catalogRevision,
          },
        }],
        current: {
          checkpoint: { revision: 1 },
          catalogMappingProjectionId:
            afterFirst.reviewWorkflow.current.catalogMappingProjectionId,
        },
      },
    });
    const mappedSecond = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000398",
      "--revision",
      afterFirst.catalogRevision,
      "--media-item-id",
      secondMediaItem.id,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "3",
    ]);
    expect(mappedSecond.exitCode, JSON.stringify(mappedSecond.result)).toBe(0);
    const secondSelectionId = (mappedSecond.result as {
      discSelection: { id: string };
    }).discSelection.id;
    const after = await readBoth();
    expect(after.reviewOutcome).toBe("needs_review");
    expect(after.reviewWorkflow.facts).toMatchObject({
      recovering: true,
      mapped: true,
      mappingState: "mapped",
      readyForDamageDecision: false,
      readyForEncoding: false,
    });
    expect(
      after.reviewWorkflow.actions.find(({ action }) =>
        action === "damage_decision"
      )?.reasons,
    ).toEqual([
      expect.objectContaining({ code: "ASSESSMENT_PENDING" }),
      expect.objectContaining({ code: "RECOVERY_ACTIVE" }),
      expect.objectContaining({
        code: "CATALOG_DAMAGE_DECISION_UNAVAILABLE",
      }),
    ]);

    const completionCommand = {
      action: "complete_review" as const,
      catalogRevision: after.catalogRevision,
      outcome: "reviewed_with_selections" as const,
      replacementEncodes: [],
    };
    const webCompletion = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...completionCommand,
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const completion = await fixture.run([
      "catalog-review",
      "preview-completion",
      archive.id,
      "--json",
      JSON.stringify(completionCommand),
    ]);
    expect(webCompletion.status).toBe(409);
    expect(completion.exitCode).toBe(2);
    expect(completion.result).toEqual(await webCompletion.json());
    expect(completion.result).toMatchObject({
      error: {
        code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE",
        reasons: [
          { code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE" },
        ],
        current: {
          recovery: { state: "running" },
          catalogMappingProjectionId:
            after.reviewWorkflow.current.catalogMappingProjectionId,
        },
      },
    });

    const staleWebUpdatePreview = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        catalogRevision: before.catalogRevision,
        changes: { mediaItemId: secondMediaItem.id },
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const staleCliUpdatePreview = await fixture.run([
      "disc-selection",
      "preview",
      "update",
      archive.id,
      firstSelectionId,
      "--revision",
      before.catalogRevision,
      "--media-item-id",
      secondMediaItem.id,
    ]);
    expect(staleWebUpdatePreview.status).toBe(409);
    expect(staleCliUpdatePreview.exitCode).toBe(2);
    expect(staleCliUpdatePreview.result).toEqual(
      await staleWebUpdatePreview.json(),
    );
    expect(staleCliUpdatePreview.result).toMatchObject({
      error: {
        code: "STALE_CATALOG_REVISION",
        reasons: [{ code: "STALE_CATALOG_REVISION" }],
        current: {
          catalogMappingProjectionId:
            after.reviewWorkflow.current.catalogMappingProjectionId,
        },
      },
    });

    const webUpdatePreviewResponse = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        catalogRevision: after.catalogRevision,
        changes: { mediaItemId: secondMediaItem.id },
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const webUpdatePreview = await webUpdatePreviewResponse.json() as {
      catalogRevision: string;
      previewToken: string;
    };
    const cliUpdatePreviewResult = await fixture.run([
      "disc-selection",
      "preview",
      "update",
      archive.id,
      firstSelectionId,
      "--revision",
      after.catalogRevision,
      "--media-item-id",
      secondMediaItem.id,
    ]);
    const cliUpdatePreview = cliUpdatePreviewResult.result as {
      catalogRevision: string;
      previewToken: string;
    };
    const webDeletePreviewResponse = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "delete_disc_selection",
        discSelectionId: secondSelectionId,
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const webDeletePreview = await webDeletePreviewResponse.json() as {
      catalogRevision: string;
      previewToken: string;
    };
    const cliDeletePreviewResult = await fixture.run([
      "disc-selection",
      "preview",
      "delete",
      archive.id,
      secondSelectionId,
    ]);
    const cliDeletePreview = cliDeletePreviewResult.result as {
      catalogRevision: string;
      previewToken: string;
    };
    expect(webUpdatePreviewResponse.status).toBe(200);
    expect(cliUpdatePreviewResult.exitCode).toBe(0);
    expect(webDeletePreviewResponse.status).toBe(200);
    expect(cliDeletePreviewResult.exitCode).toBe(0);

    const faultDatabase = new DatabaseSync(fixture.databasePath);
    faultDatabase.prepare(`
      UPDATE archive_recoveries
      SET status = 'faulted', fault_code = 'CONSISTENCY_FAULT'
      WHERE original_disc_archive_id = ?
    `).run(archive.id);
    faultDatabase.close();

    const faultedWebUpdatePreview = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        catalogRevision: after.catalogRevision,
        changes: { mediaItemId: secondMediaItem.id },
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const faultedCliUpdatePreview = await fixture.run([
      "disc-selection",
      "preview",
      "update",
      archive.id,
      firstSelectionId,
      "--revision",
      after.catalogRevision,
      "--media-item-id",
      secondMediaItem.id,
    ]);
    expect(faultedWebUpdatePreview.status).toBe(409);
    expect(faultedCliUpdatePreview.exitCode).toBe(2);
    expect(faultedCliUpdatePreview.result).toEqual(
      await faultedWebUpdatePreview.json(),
    );
    expect(faultedCliUpdatePreview.result).toMatchObject({
      error: {
        code: "CATALOG_MAPPING_UNAVAILABLE",
        reasons: [{ code: "CONSISTENCY_FAULT" }],
        current: { recovery: { state: "faulted" } },
      },
    });

    const faultedWebDeletePreview = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "delete_disc_selection",
        discSelectionId: secondSelectionId,
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const faultedCliDeletePreview = await fixture.run([
      "disc-selection",
      "preview",
      "delete",
      archive.id,
      secondSelectionId,
    ]);
    expect(faultedWebDeletePreview.status).toBe(409);
    expect(faultedCliDeletePreview.exitCode).toBe(2);
    expect(faultedCliDeletePreview.result).toEqual(
      await faultedWebDeletePreview.json(),
    );

    const blockedWebUpdate = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        changes: { mediaItemId: secondMediaItem.id },
        mutationKey: "00000000-0000-4000-8000-000000000409",
        expectedCatalogRevision: webUpdatePreview.catalogRevision,
        previewToken: webUpdatePreview.previewToken,
        acknowledge: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const blockedCliUpdate = await fixture.run([
      "disc-selection",
      "update",
      archive.id,
      firstSelectionId,
      "--key",
      "00000000-0000-4000-8000-000000000410",
      "--media-item-id",
      secondMediaItem.id,
      "--revision",
      cliUpdatePreview.catalogRevision,
      "--preview-token",
      cliUpdatePreview.previewToken,
      "--acknowledge",
    ]);
    expect(blockedWebUpdate.status).toBe(409);
    expect(blockedCliUpdate.exitCode).toBe(2);
    expect(blockedCliUpdate.result).toEqual(await blockedWebUpdate.json());
    expect(blockedCliUpdate.result).toMatchObject({
      error: {
        code: "CATALOG_MAPPING_UNAVAILABLE",
        reasons: [{ code: "CONSISTENCY_FAULT" }],
        current: { recovery: { state: "faulted" } },
      },
    });

    const blockedWebDelete = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "delete_disc_selection",
        discSelectionId: secondSelectionId,
        mutationKey: "00000000-0000-4000-8000-000000000411",
        expectedCatalogRevision: webDeletePreview.catalogRevision,
        previewToken: webDeletePreview.previewToken,
        acknowledge: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const blockedCliDelete = await fixture.run([
      "disc-selection",
      "delete",
      archive.id,
      secondSelectionId,
      "--key",
      "00000000-0000-4000-8000-000000000412",
      "--revision",
      cliDeletePreview.catalogRevision,
      "--preview-token",
      cliDeletePreview.previewToken,
      "--acknowledge",
    ]);
    expect(blockedWebDelete.status).toBe(409);
    expect(blockedCliDelete.exitCode).toBe(2);
    expect(blockedCliDelete.result).toEqual(await blockedWebDelete.json());
    expect(blockedCliDelete.result).toMatchObject({
      error: {
        code: "CATALOG_MAPPING_UNAVAILABLE",
        reasons: [{ code: "CONSISTENCY_FAULT" }],
        current: { recovery: { state: "faulted" } },
      },
    });

    const resumedDatabase = new DatabaseSync(fixture.databasePath);
    resumedDatabase.prepare(`
      UPDATE archive_recoveries
      SET status = 'running', fault_code = NULL
      WHERE original_disc_archive_id = ?
    `).run(archive.id);
    resumedDatabase.close();
    const resumed = await readBoth();
    const labelMutationKey = "00000000-0000-4000-8000-000000000419";
    const currentLabelWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "update_disc_selection",
        discSelectionId: firstSelectionId,
        catalogRevision: resumed.catalogRevision,
        mutationKey: labelMutationKey,
        changes: { label: "Synthetic current feature" },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const currentLabelWebResult = await currentLabelWeb.json();
    const currentLabelCli = await fixture.run([
      "disc-selection",
      "update",
      archive.id,
      firstSelectionId,
      "--key",
      labelMutationKey,
      "--revision",
      resumed.catalogRevision,
      "--label",
      "Synthetic current feature",
    ]);
    expect(currentLabelWeb.status).toBe(200);
    expect(currentLabelCli.exitCode).toBe(0);
    expect(currentLabelCli.result).toEqual(currentLabelWebResult);
    expect(currentLabelCli.result).toMatchObject({
      discSelection: { label: "Synthetic current feature" },
    });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    }).find(({ id }) => id === firstSelectionId)?.label).toBe(
      "Synthetic current feature",
    );
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("returns the same stable new-format mapping capacity failure through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive } = await seedCommittedArchiveEvidence(
    fixture,
    [],
    false,
    true,
  );
  const access = fixture.openAccess();
  try {
    const checkpoint = access.catalog.findDvdArchiveEvidenceHeader(
      archive.id,
    )!;
    access.catalog.recordDvdTitleIdentityObservations({
      originalDiscArchiveId: archive.id,
      checkpoint: {
        manifestId: checkpoint.currentManifestId,
        manifestRevision: checkpoint.currentManifestRevision,
        manifestDigest: checkpoint.currentManifestDigest,
      },
      observations: [{
        displayTitleNumber: 1,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 1,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 12,
        chapterCount: 12,
        sourceExtents: [{ startLba: 0, sectorCount: 1 }],
      }],
    });
    const seedSelection = access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })[0]!;
    const sqlite = new DatabaseSync(fixture.databasePath);
    const clone = sqlite.prepare(`
      INSERT INTO disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        title_number, chapter_start, chapter_end, label, is_catalog_active,
        created_at, updated_at
      )
      SELECT ?, original_disc_archive_id, media_item_id, source_key, kind,
        title_number, chapter_start, chapter_end, label, is_catalog_active,
        created_at, updated_at
      FROM disc_selections
      WHERE id = ?
    `);
    sqlite.exec("BEGIN IMMEDIATE");
    for (let index = 1; index < MAX_DVD_TITLES; index += 1) {
      clone.run(`synthetic-capacity-selection-${index}`, seedSelection.id);
    }
    sqlite.exec("COMMIT");
    sqlite.close();

    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt.toISOString();
    const expected = {
      error: {
        code: "CATALOG_MAPPING_CAPACITY_EXCEEDED",
        message:
          `New-format DVD archives are limited to ${MAX_DVD_TITLES} active Disc Selections`,
      },
    };
    const webSelection = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "create_disc_selection",
        catalogRevision,
        mutationKey: "00000000-0000-4000-8000-000000000421",
        selection: {
          mediaItemId: seedSelection.mediaItemId,
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const cliSelection = await fixture.run([
      "disc-selection",
      "create",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000422",
      "--revision",
      catalogRevision,
      "--media-item-id",
      seedSelection.mediaItemId,
      "--source-kind",
      "dvd_title",
      "--title-number",
      "1",
    ]);
    expect(webSelection.status).toBe(409);
    expect(cliSelection.exitCode).toBe(2);
    expect(cliSelection.result).toEqual(await webSelection.json());
    expect(cliSelection.result).toEqual(expected);

    const proposal = {
      action: "create_mapping_proposal" as const,
      catalogRevision,
      target: {
        choice: "use_existing" as const,
        mediaItemId: seedSelection.mediaItemId,
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
      },
    };
    const webProposal = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...proposal,
        mutationKey: "00000000-0000-4000-8000-000000000423",
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const cliProposal = await fixture.run([
      "catalog-review",
      "apply-proposal",
      archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000424",
      "--json",
      JSON.stringify(proposal),
    ]);
    expect(webProposal.status).toBe(409);
    expect(cliProposal.exitCode).toBe(2);
    expect(cliProposal.result).toEqual(await webProposal.json());
    expect(cliProposal.result).toEqual(expected);
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("rejects mapping previews when only a non-default title angle is current", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive } = await seedCommittedArchiveEvidence(
    fixture,
    [],
    false,
    true,
  );
  const access = fixture.openAccess();
  try {
    const selection = access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })[0]!;
    const checkpoint = access.catalog.findDvdArchiveEvidenceHeader(
      archive.id,
    )!;
    access.catalog.recordDvdTitleIdentityObservations({
      originalDiscArchiveId: archive.id,
      checkpoint: {
        manifestId: checkpoint.currentManifestId,
        manifestRevision: checkpoint.currentManifestRevision,
        manifestDigest: checkpoint.currentManifestDigest,
      },
      observations: [{
        displayTitleNumber: 1,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 2,
        }],
        angleNumber: 2,
        angleCount: 2,
        chapterStart: 1,
        chapterEnd: 1,
        chapterCount: 1,
        sourceExtents: [{ startLba: 0, sectorCount: 1 }],
      }],
    });

    const web = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        action: "delete_disc_selection",
        discSelectionId: selection.id,
        preview: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const cli = await fixture.run([
      "disc-selection",
      "preview",
      "delete",
      archive.id,
      selection.id,
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "CATALOG_MAPPING_UNAVAILABLE",
        reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
      },
    });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("keeps absent retained mapping blockers identical through web, CLI, and dashboard", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const access = fixture.openAccess();
  try {
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Synthetic retained mapping",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    const firstHeader = access.catalog.findDvdArchiveEvidenceHeader(
      archive.id,
    )!;
    const firstReviewSet = access.catalog.recordDvdTitleIdentityObservations({
      originalDiscArchiveId: archive.id,
      checkpoint: {
        manifestId: firstHeader.currentManifestId,
        manifestRevision: firstHeader.currentManifestRevision,
        manifestDigest: firstHeader.currentManifestDigest,
      },
      observations: [{
        displayTitleNumber: 1,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 1,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 12,
        chapterCount: 12,
        sourceExtents: [{ startLba: 0, sectorCount: 1 }],
      }],
    });
    expect(firstReviewSet.items[0]?.discSelectionMappings).toEqual([
      expect.objectContaining({
        discSelectionId: selection.id,
        mappingState: "mapped",
      }),
    ]);

    const nextManifest = advanceCommittedArchiveEvidence(fixture, manifest);
    const missingReviewSet = access.catalog.recordDvdTitleIdentityObservations({
      originalDiscArchiveId: archive.id,
      checkpoint: {
        manifestId: nextManifest.id,
        manifestRevision: nextManifest.revision,
        manifestDigest: nextManifest.manifestDigest,
      },
      observations: [],
    });
    expect(missingReviewSet.items[0]).toMatchObject({
      presentAtCurrentCheckpoint: false,
      mappingState: "needs_mapping_review",
      discSelectionMappings: [{
        discSelectionId: selection.id,
        mappingState: "needs_mapping_review",
      }],
    });

    const web = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const cli = await fixture.run(["catalog-review", "show", archive.id]);
    expect(web.status).toBe(200);
    expect(cli.exitCode, JSON.stringify(cli.result)).toBe(0);
    expect(cli.result).toEqual(await web.json());
    const review = cli.result as {
      reviewWorkflow: {
        facts: Record<string, unknown>;
        actions: Array<{
          action: string;
          available: boolean;
          reasons: Array<{ code: string }>;
        }>;
      };
    };
    expect(review.reviewWorkflow.facts).toMatchObject({
      mapped: false,
      mappingState: "pending",
      readyForDamageDecision: false,
    });
    expect(
      review.reviewWorkflow.actions.find(({ action }) =>
        action === "catalog_mapping"
      ),
    ).toMatchObject({
      available: false,
      reasons: expect.arrayContaining([expect.objectContaining({
        code: "SELECTION_UNIDENTIFIED",
      })]),
    });
    expect(
      review.reviewWorkflow.actions.find(({ action }) =>
        action === "damage_decision"
      ),
    ).toMatchObject({
      available: false,
      reasons: expect.arrayContaining([expect.objectContaining({
        code: "MAPPING_REVIEW_REQUIRED",
      })]),
    });

    const dashboard = readDashboardSnapshot(access, { activityLimit: 20 });
    expect(dashboard.catalogReview.status).toBe("loaded");
    if (dashboard.catalogReview.status !== "loaded") {
      throw new Error("Catalog Review dashboard is unavailable");
    }
    expect(
      dashboard.catalogReview.items.find(({ id }) => id === archive.id)
        ?.reviewWorkflow,
    ).toEqual(review.reviewWorkflow);
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("reports a missing marked Title Damage checkpoint through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive } = await seedCommittedArchiveEvidence(fixture);
  withEvidenceGuardsDisabled(fixture.databasePath, (database) => {
    database.prepare(`
      DELETE FROM dvd_archive_evidence_headers
      WHERE original_disc_archive_id = ?
    `).run(archive.id);
  });
  const access = fixture.openAccess();
  try {
    const cli = await fixture.run([
      "catalog-review",
      "damage",
      archive.id,
    ]);
    const web = createCatalogTitleDamageRoute(
      new Request(
        `${trustedOrigin}/api/catalog-reviews/${archive.id}/damage`,
      ),
      archive.id,
      () => access,
    );
    expect(web.status).toBe(200);
    expect(cli.exitCode, JSON.stringify(cli.result)).toBe(0);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      state: "unavailable",
      checkpointRevision: null,
      assessmentIdentity: null,
      currentAssessmentIdentity: null,
      items: [],
      unavailableReasons: [{ code: "CONSISTENCY_FAULT" }],
    });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("keeps every structural assessment state identical through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const access = fixture.openAccess();
  const inspectBoth = async () => {
    const web = createOperationsResponse(
      access,
      new Request(
        `${trustedOrigin}/api/operations?kind=original-disc-archives&id=${archive.id}`,
      ),
      fixture.originalsLibraryPath,
    );
    const cli = await fixture.run([
      "inspect",
      "original-disc-archives",
      archive.id,
    ]);
    expect(web.status).toBe(200);
    expect(cli.exitCode, JSON.stringify(cli.result)).toBe(0);
    expect(cli.result).toEqual(await web.json());
    return cli.result as {
      item: { structuralAssessment: Record<string, unknown> };
    };
  };
  try {
    expect((await inspectBoth()).item.structuralAssessment).toMatchObject({
      state: "pending",
      currentAssessmentIdentity: null,
      unavailableReasons: [{ code: "ASSESSMENT_PENDING" }],
    });

    access.dvdStructuralAssessments.recordFailed({
      checkpoint: {
        originalDiscArchiveId: archive.id,
        manifestId: manifest.id,
        manifestRevision: manifest.revision,
        manifestDigest: manifest.manifestDigest,
        acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
      },
      reason: {
        code: "CONSISTENCY_FAULT",
        message: "A consistent image read was unavailable.",
      },
    });
    expect((await inspectBoth()).item.structuralAssessment).toMatchObject({
      state: "pending",
      currentAssessmentIdentity: null,
      latestAttempt: {
        outcome: "failed",
        reason: { code: "CONSISTENCY_FAULT" },
      },
      unavailableReasons: [
        { code: "ASSESSMENT_PENDING" },
        { code: "CONSISTENCY_FAULT" },
      ],
    });

    const completed = await access.assessDvdStructure(
      archive.id,
      createArchiveImageOwnership({
        authorityRootPath: fixture.originalsLibraryPath,
      }),
      async () => ({
        outcome: "completed",
        findings: ([
          "filesystem_structure",
          "dvd_navigation",
          "title_enumeration",
        ] as const).map((checkKind) => ({
          checkKind,
          policyVersion: "synthetic-structural-check-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 1024,
            observedSectorCount: 32,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: `synthetic-parity-evidence:${checkKind}`,
        })),
      }),
    );
    if (completed === null || completed.outcome !== "completed") {
      throw new Error("Expected structural support");
    }
    expect((await inspectBoth()).item.structuralAssessment).toMatchObject({
      state: "current",
      currentAssessmentIdentity: completed.assessment.id,
      assessment: { validity: "valid" },
      unavailableReasons: [],
    });

    const current = advanceCommittedArchiveEvidence(fixture, manifest);
    expect((await inspectBoth()).item.structuralAssessment).toMatchObject({
      state: "outdated",
      currentAssessmentIdentity: null,
      assessment: { id: completed.assessment.id },
      unavailableReasons: [{ code: "ASSESSMENT_OUTDATED" }],
    });

    access.dvdStructuralAssessments.recordFailed({
      checkpoint: {
        originalDiscArchiveId: archive.id,
        manifestId: current.id,
        manifestRevision: current.revision,
        manifestDigest: current.manifestDigest,
        acceptedEndLbaExclusive: current.acceptedEndLbaExclusive,
      },
      reason: {
        code: "CONSISTENCY_FAULT",
        message: "A consistent image read was unavailable.",
      },
    });
    expect((await inspectBoth()).item.structuralAssessment).toMatchObject({
      state: "outdated",
      latestAttempt: {
        outcome: "failed",
        reason: { code: "CONSISTENCY_FAULT" },
      },
      unavailableReasons: [
        { code: "ASSESSMENT_OUTDATED" },
        { code: "CONSISTENCY_FAULT" },
      ],
    });

  } finally {
    access.close();
    fixture.dispose();
  }
});

it.each(["web", "cli"] as const)(
  "keeps long-running archives cancellable through %s with adapter parity",
  async (firstAdapter) => {
    const fixture = createOperatorWorkflowFixture();
    const access = fixture.openAccess();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: "/dev/synthetic-drive", isEnabled: true, isPresent: true,
      });
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id, discKind: "dvd",
        fingerprint: "synthetic-long-running-disc",
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      const request = access.archiveRequests.create({ detectedDiscId: disc.id });
      const settled = beginSettledDiscInspectionForTest(access, {
        opticalDriveId: drive.id,
        mediaGeneration: "synthetic-long-running-generation",
        mediaCapacityBytes: 2_048,
      });
      access.discInspections.record(settled.claim, {
        type: "metadata", volumeLabel: "SYNTHETIC_DISC",
        titleCount: 0, chapterCount: 0, audioStreamCount: 0,
        subtitleStreamCount: 0, totalBytes: 2_048,
      });
      const inspection = access.discInspections.record(settled.claim, {
        type: "complete", detectedDiscId: disc.id,
      });
      settled.restoreSystemTime();
      const claim = access.archiveJobs.startForInspection(
        inspection.id, "synthetic-long-running-worker",
      )!;
      // Renew the live worker claim without any byte-progress updates.
      for (let elapsed = 0; elapsed < 13 * 60 * 60_000; elapsed += 30_000) {
        vi.setSystemTime(Date.now() + 30_000);
        access.archiveJobs.renewClaim(claim);
      }
      const observed = await fixture.run([
        "wait", "archive-requests", request.id, "--timeout-ms", "0",
      ]);
      expect(observed.result).toMatchObject({
        outcome: "timeout", current: { status: "running" },
      });
      expect(access.archiveJobs.find(claim.id)?.status).toBe("running");
      const inspected = await fixture.run(["inspect", "archive-requests", request.id]);
      expect(inspected.result).toMatchObject({ item: {
        availableActions: expect.arrayContaining([
          expect.objectContaining({ name: "cancel", eligible: true }),
        ]),
      } });
      const key = "synthetic-long-running-cancellation";
      const webCancel = () => createArchiveRequestCancellationRoute(
        new Request(`${trustedOrigin}/api/archive-requests/${request.id}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: trustedOrigin,
          },
          body: JSON.stringify({ mutationKey: key }),
        }),
        request.id,
        () => access,
        () => trustedOrigin,
      );
      const cliCancel = () => fixture.run([
        "cancel-archive-request", "--key", key, "--archive-request-id", request.id,
      ]);
      let web: Response;
      let cli: Awaited<ReturnType<typeof cliCancel>>;
      if (firstAdapter === "web") {
        web = await webCancel();
        cli = await cliCancel();
      } else {
        cli = await cliCancel();
        web = await webCancel();
      }
      expect(web.status).toBe(200);
      expect(cli.exitCode).toBe(0);
      expect(cli.result).toEqual(await web.json());
      expect(cli.result).toMatchObject({
        archiveRequest: { id: request.id, status: "cancellation_requested" },
      });
      access.archiveJobs.abort(claim, "Synthetic operator cancellation");
      expect((await fixture.run([
        "wait", "archive-requests", request.id, "--timeout-ms", "0",
      ])).result).toMatchObject({
        outcome: "settled", current: { status: "cancelled" },
      });
    } finally {
      vi.useRealTimers();
      access.close();
      fixture.dispose();
    }
  },
);

it("shares canonical Encode Output inspection across web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, {
    validatedOutputContents: "synthetic parity output",
  });
  const artifactIdentity = encodeOutputArtifactIdentity(predecessor.id);
  const mediaProbe: EncodeOutputMediaProbe = async () => ({
    durationSeconds: 3_600.5,
    streams: [{
      index: 0,
      kind: "video",
      codecName: "h264",
      language: null,
      title: null,
      default: true,
      forced: false,
    }],
  });
  const access = fixture.openAccess();
  try {
    const web = await createEncodeOutputInspectionRoute(
      new Request(
        `${trustedOrigin}/api/encode-outputs/${encodeURIComponent(artifactIdentity)}`,
      ),
      artifactIdentity,
      () => access,
      mediaProbe,
    );
    const cli = await fixture.run(
      ["encode-output", "inspect", artifactIdentity],
      undefined,
      undefined,
      { encodeOutputMediaProbe: mediaProbe },
    );

    expect(web.status).toBe(200);
    expect(web.headers.get("Cache-Control")).toBe("no-store");
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({ artifact: {
      availableActions: [{
        name: "export",
        eligible: true,
        reasonCode: null,
        reason: null,
      }],
    } });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("shares unknown validation when canonical output probing is unavailable", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, {
    validatedOutputContents: "synthetic parity output",
  });
  const artifactIdentity = encodeOutputArtifactIdentity(predecessor.id);
  const mediaProbe: EncodeOutputMediaProbe = async () => {
    throw new Error("Synthetic unavailable probe");
  };
  const access = fixture.openAccess();
  try {
    const web = await createEncodeOutputInspectionRoute(
      new Request(
        `${trustedOrigin}/api/encode-outputs/${encodeURIComponent(artifactIdentity)}`,
      ),
      artifactIdentity,
      () => access,
      mediaProbe,
    );
    const cli = await fixture.run(
      ["encode-output", "inspect", artifactIdentity],
      undefined,
      undefined,
      { encodeOutputMediaProbe: mediaProbe },
    );

    expect(web.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({ artifact: {
      validation: { result: "unknown" },
      inspectability: {
        status: "unknown",
        reasonCode: "OUTPUT_PROBE_FAILED",
      },
      availableActions: [{
        name: "export",
        eligible: true,
        reasonCode: null,
        reason: null,
      }],
    } });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("reports the same closed DVD evidence admission through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/synthetic-closed-admission",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: `sha256:${"4".repeat(64)}`,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const mutationKey = "00000000-0000-4000-8000-000000000402";
    const cli = await fixture.run([
      "submit-archive-request",
      "--key",
      mutationKey,
      "--detected-disc-id",
      disc.id,
      "--evidence-format",
      "dvd-recovery-evidence-v1",
    ]);
    expect(cli.exitCode).toBe(2);

    const web = await createArchiveRequestsRoute(
      new Request(`${trustedOrigin}/api/archive-requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          mutationKey,
          detectedDiscId: disc.id,
          evidenceFormat: "dvd-recovery-evidence-v1",
        }),
      }),
      () => access,
      () => trustedOrigin,
    );
    expect(web.status).toBe(409);
    expect(await web.json()).toEqual(cli.result);
    expect(cli.result).toEqual({
      error: {
        code: "DVD_RECOVERY_EVIDENCE_ADMISSION_CLOSED",
        message:
          "New-format DVD Archive Job admission is closed until the recovery and encoding workflow is complete.",
        blockingReasons: [{
          code: "DVD_RECOVERY_EVIDENCE_ADMISSION_CLOSED",
          message:
            "New-format DVD Archive Job admission is closed until the recovery and encoding workflow is complete.",
        }],
      },
    });
    expect(access.archiveRequests.list()).toEqual([]);
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("preserves re-archive replay but blocks fresh reuse of a marked request", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive: source } = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    const replayKey = "00000000-0000-4000-8000-000000000417";
    const initial = createApplicationOperations(access).submitRearchiveRequest({
      mutationKey: replayKey,
      sourceArchiveId: source.id,
    });
    const requestId = initial.archiveRequest.id;
    const sqlite = new DatabaseSync(fixture.databasePath);
    sqlite.prepare(`
      UPDATE archive_requests
      SET evidence_format = ?
      WHERE id = ?
    `).run(DVD_RECOVERY_EVIDENCE_FORMAT, requestId);
    sqlite.close();

    const request = (mutationKey: string) => new Request(
      `${trustedOrigin}/api/rearchive-requests`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ mutationKey, sourceArchiveId: source.id }),
      },
    );
    const replayedWeb = await createRearchiveRequestsRoute(
      request(replayKey),
      () => access,
      () => trustedOrigin,
    );
    const replayedCli = await fixture.run([
      "request-rearchive",
      "--key",
      replayKey,
      "--source-archive-id",
      source.id,
    ]);
    expect(replayedWeb.status).toBe(201);
    expect(replayedCli.exitCode).toBe(0);
    expect(replayedCli.result).toEqual(await replayedWeb.json());
    expect(replayedCli.result).toMatchObject({
      archiveRequest: {
        id: requestId,
        status: "pending",
      },
    });

    const freshKey = "00000000-0000-4000-8000-000000000418";
    const blockedWeb = await createRearchiveRequestsRoute(
      request(freshKey),
      () => access,
      () => trustedOrigin,
    );
    const blockedCli = await fixture.run([
      "request-rearchive",
      "--key",
      freshKey,
      "--source-archive-id",
      source.id,
    ]);
    expect(blockedWeb.status).toBe(409);
    expect(blockedCli.exitCode).toBe(2);
    expect(blockedCli.result).toEqual(await blockedWeb.json());
    expect(blockedCli.result).toEqual({
      error: {
        code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
        message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        blockingReasons: [{
          code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
          message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        }],
      },
    });
    expect(access.archiveRequests.find(requestId)).toMatchObject({
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      status: "pending",
    });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("reports unsupported Archive evidence formats consistently through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const mutationKey = "00000000-0000-4000-8000-000000000405";
    const cli = await fixture.run([
      "submit-archive-request",
      "--key",
      mutationKey,
      "--detected-disc-id",
      "synthetic-disc",
      "--evidence-format",
      "unsupported-evidence-v2",
    ]);
    const web = await createArchiveRequestsRoute(
      new Request(`${trustedOrigin}/api/archive-requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          mutationKey,
          detectedDiscId: "synthetic-disc",
          evidenceFormat: "unsupported-evidence-v2",
        }),
      }),
      () => access,
      () => trustedOrigin,
    );

    expect(web.status).toBe(400);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toEqual({
      error: {
        code: "UNSUPPORTED_ARCHIVE_EVIDENCE_FORMAT",
        message: "Archive evidence format is unsupported.",
      },
    });
    expect(access.archiveRequests.list()).toEqual([]);
  } finally {
    access.close();
    fixture.dispose();
  }
});

function catalogReviewMutationRequest(
  archiveId: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`${trustedOrigin}/api/catalog-reviews/${archiveId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: trustedOrigin,
    },
    body: JSON.stringify(body),
  });
}

const dvdEvidenceEncodingUnavailableError = {
  error: {
    code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
    message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
    blockingReasons: [{
      code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
      message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
    }],
  },
};

it("preserves stale legacy Mapping Proposal adapter responses", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    const review = await fixture.run([
      "catalog-review",
      "show",
      seeded.archive.id,
    ]);
    const staleRevision = (review.result as { catalogRevision: string })
      .catalogRevision;
    const revisionDatabase = new DatabaseSync(fixture.databasePath);
    revisionDatabase.prepare(`
      UPDATE original_disc_archives
      SET updated_at = updated_at + 1
      WHERE id = ?
    `).run(seeded.archive.id);
    revisionDatabase.close();
    const proposal = {
      action: "create_mapping_proposal" as const,
      catalogRevision: staleRevision,
      target: {
        choice: "create_new" as const,
        mediaItem: { kind: "movie" as const, title: "Synthetic stale target" },
      },
      discSelection: {
        sourceIdentity: { kind: "main_feature" as const },
      },
    };
    const web = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.archive.id, {
        ...proposal,
        mutationKey: "00000000-0000-4000-8000-000000000407",
      }),
      seeded.archive.id,
      () => access,
      () => trustedOrigin,
    );
    const cli = await fixture.run([
      "catalog-review",
      "apply-proposal",
      seeded.archive.id,
      "--key",
      "00000000-0000-4000-8000-000000000408",
      "--json",
      JSON.stringify(proposal),
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(await web.json()).toEqual({
      error: "Catalog review changed; reload before saving Mapping Proposal",
    });
    expect(cli.result).toEqual({
      error: {
        code: "STALE_CATALOG_REVISION",
        message:
          "Catalog review changed; reload before saving Mapping Proposal",
      },
    });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("blocks Catalog Review replacement previews consistently through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    const review = await fixture.run([
      "catalog-review",
      "show",
      seeded.archive.id,
    ]);
    const catalogRevision = (review.result as { catalogRevision: string })
      .catalogRevision;
    const command = {
      action: "complete_review" as const,
      catalogRevision,
      outcome: "reviewed_with_selections" as const,
      replacementEncodes: [{
        predecessorEncodeJobId: seeded.predecessor.id,
        encodingProfileId: seeded.predecessor.encodingProfileId,
        outputPath: seeded.predecessor.outputPath,
      }],
    };
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      seeded.archive.id,
      "catalog-review-parity",
    );
    const web = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.archive.id, {
        ...command,
        preview: true,
      }),
      seeded.archive.id,
      () => access,
      () => trustedOrigin,
      () => fixture.mediaLibraryPath,
    );
    const cli = await fixture.run([
      "catalog-review",
      "preview-completion",
      seeded.archive.id,
      "--json",
      JSON.stringify(command),
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toEqual(dvdEvidenceEncodingUnavailableError);
    expect(access.catalog.listOriginalDiscArchives({
      ids: [seeded.archive.id],
    })[0]).toMatchObject({
      catalogReviewOutcome: "needs_review",
      catalogReviewedAt: null,
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: seeded.predecessor.id,
        predecessorEncodeJobId: null,
        reservesOutputPath: true,
      }),
    ]);
    const sqlite = new DatabaseSync(fixture.databasePath);
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE operation = 'catalog_review.complete.preview'
    `).get()).toEqual({ count: 0 });
    sqlite.close();
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("reports Archive Recovery conflicts for replacement previews through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    const review = await fixture.run([
      "catalog-review",
      "show",
      seeded.archive.id,
    ]);
    const catalogRevision = (review.result as { catalogRevision: string })
      .catalogRevision;
    const command = {
      action: "complete_review" as const,
      catalogRevision,
      outcome: "reviewed_with_selections" as const,
      replacementEncodes: [{
        predecessorEncodeJobId: seeded.predecessor.id,
        encodingProfileId: seeded.predecessor.encodingProfileId,
        outputPath: seeded.predecessor.outputPath,
      }],
    };
    const recoveryId = "synthetic-replacement-conflict-recovery";
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      seeded.archive.id,
      "catalog-review-recovery-conflict",
      {
        archiveRecovery: {
          id: recoveryId,
          workStatus: "claimed",
        },
      },
    );
    expect(access.catalog.findArchiveRecovery(seeded.archive.id))
      .toMatchObject({
        id: recoveryId,
        work: expect.objectContaining({ status: "claimed" }),
      });
    const web = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.archive.id, {
        ...command,
        preview: true,
      }),
      seeded.archive.id,
      () => access,
      () => trustedOrigin,
      () => fixture.mediaLibraryPath,
    );
    const cli = await fixture.run([
      "catalog-review",
      "preview-completion",
      seeded.archive.id,
      "--json",
      JSON.stringify(command),
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "ENCODE_WORK_CONFLICT",
        blockingReasons: [{ code: "ENCODE_WORK_CONFLICT" }],
        current: {
          archiveRecovery: {
            id: recoveryId,
            originalDiscArchiveId: seeded.archive.id,
            work: { status: "claimed" },
          },
        },
      },
    });
    expect(JSON.stringify(cli.result)).not.toContain("claimToken");
    expect(JSON.stringify(cli.result)).not.toContain("claimedBy");
    expect(access.catalog.listOriginalDiscArchives({
      ids: [seeded.archive.id],
    })[0]).toMatchObject({
      catalogReviewOutcome: "needs_review",
      catalogReviewedAt: null,
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: seeded.predecessor.id,
        predecessorEncodeJobId: null,
      }),
    ]);
    const sqlite = new DatabaseSync(fixture.databasePath);
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE operation = 'catalog_review.complete.preview'
    `).get()).toEqual({ count: 0 });
    sqlite.close();
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("reports recovery-owned Encode availability consistently through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedCatalogReviewForReadFixture(fixture);
  const openGateAccess = () => createDvdRecoveryEvidenceEncodingTestAccess({
    databasePath: fixture.databasePath,
    mediaLibraryPath: fixture.mediaLibraryPath,
    originalsLibraryPath: fixture.originalsLibraryPath,
  });
  let access: ReturnType<typeof openGateAccess> | null = null;
  const getAccess = () => {
    if (access === null) throw new Error("Expected gate-open data access");
    return access;
  };
  try {
    const setup = fixture.openAccess();
    setup.catalog.completeCatalogReview(
      seeded.archive.id,
      setup.catalog.listOriginalDiscArchives({
        ids: [seeded.archive.id],
      })[0]!.updatedAt,
      "reviewed_with_selections",
    );
    setup.close();
    const recoveryId = "encode-resolution-parity-recovery";
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      seeded.archive.id,
      "encode-resolution-parity",
      {
        archiveRecovery: {
          id: recoveryId,
          workStatus: "claimed",
        },
      },
    );
    access = openGateAccess();
    const queueUrl = new URL(`${trustedOrigin}/api/encode-jobs`);
    queueUrl.searchParams.set(
      "encodingProfileId",
      seeded.predecessor.encodingProfileId,
    );
    const webQueue = await createEncodeJobsRoute(
      new Request(queueUrl),
      getAccess,
      () => ({
        mediaLibraryPath: fixture.mediaLibraryPath,
        webTrustedOrigin: trustedOrigin,
      }),
    );
    const cliQueue = await fixture.run([
      "encode-queue",
      "--encoding-profile-id",
      seeded.predecessor.encodingProfileId,
    ], undefined, undefined, { openAccess: openGateAccess });
    expect(webQueue.status).toBe(200);
    expect(cliQueue.exitCode).toBe(0);
    expect(cliQueue.result).toEqual(await webQueue.json());
    expect(cliQueue.result).toMatchObject({
      selections: expect.arrayContaining([expect.objectContaining({
        id: seeded.correctedSelection.id,
        currentWork: expect.objectContaining({
          archiveRecovery: expect.objectContaining({
            id: recoveryId,
            originalDiscArchiveId: seeded.archive.id,
            work: expect.objectContaining({ status: "claimed" }),
          }),
          encodeJobs: [],
        }),
        queueAction: expect.objectContaining({
          eligible: false,
          blockingReasons: [expect.objectContaining({
            code: "ENCODE_WORK_CONFLICT",
          })],
        }),
      })]),
    });
    expect(JSON.stringify(cliQueue.result)).not.toContain("claimToken");
    expect(JSON.stringify(cliQueue.result)).not.toContain("claimedBy");

    const url = new URL(`${trustedOrigin}/api/encode-jobs`);
    url.searchParams.set(
      "encodingProfileId",
      seeded.predecessor.encodingProfileId,
    );
    url.searchParams.set(
      "resolveDiscSelectionId",
      seeded.correctedSelection.id,
    );
    const web = await createEncodeJobsRoute(
      new Request(url),
      getAccess,
      () => ({
        mediaLibraryPath: fixture.mediaLibraryPath,
        webTrustedOrigin: trustedOrigin,
      }),
    );
    const cli = await fixture.run([
      "encode-resolve",
      "--encoding-profile-id",
      seeded.predecessor.encodingProfileId,
      "--disc-selection-id",
      seeded.correctedSelection.id,
    ], undefined, undefined, { openAccess: openGateAccess });

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "ENCODE_WORK_CONFLICT",
        blockingReasons: [{ code: "ENCODE_WORK_CONFLICT" }],
        current: {
          archiveRecovery: {
            id: recoveryId,
            originalDiscArchiveId: seeded.archive.id,
            work: { status: "claimed" },
          },
          encodeJobs: [],
        },
      },
    });
    expect(JSON.stringify(cli.result)).not.toContain("claimToken");
    expect(JSON.stringify(cli.result)).not.toContain("claimedBy");
  } finally {
    access?.close();
    fixture.dispose();
  }
});

it("blocks Re-archive replacement previews consistently through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedRearchiveCatalogReviewFixture(fixture);
  const access = fixture.openAccess();
  try {
    const review = await fixture.run([
      "catalog-review",
      "show",
      seeded.targetArchive.id,
    ]);
    const initial = (review.result as {
      rearchiveProposal: {
        catalogRevision: string;
        sourceCatalogRevision: string;
        mappings: Array<{
          sourceDiscSelectionId: string;
          proposedMapping: {
            mediaItemId: string;
            sourceIdentity: { kind: "dvd_title"; titleNumber: number };
            label: string | null;
          };
        }>;
      };
    }).rearchiveProposal;
    const save = await fixture.run([
      "catalog-review",
      "save-rearchive-proposal",
      seeded.targetArchive.id,
      "--key",
      "00000000-0000-4000-8000-000000000410",
      "--json",
      JSON.stringify({
        action: "save_rearchive_mapping_proposal",
        catalogRevision: initial.catalogRevision,
        sourceCatalogRevision: initial.sourceCatalogRevision,
        mappings: initial.mappings.map((mapping) => ({
          sourceDiscSelectionId: mapping.sourceDiscSelectionId,
          ...mapping.proposedMapping,
        })),
      }),
    ]);
    const saved = (save.result as {
      proposal: { catalogRevision: string; sourceCatalogRevision: string };
    }).proposal;
    const profile = access.encodingProfiles.create({
      key: "rearchive-evidence-parity",
      displayName: "Re-archive evidence parity",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: seeded.sourceSelection.id,
      encodingProfileId: profile.id,
      outputPath: join(fixture.mediaLibraryPath, "rearchive-evidence.mkv"),
    });
    const command = {
      action: "accept_rearchive" as const,
      catalogRevision: saved.catalogRevision,
      sourceCatalogRevision: saved.sourceCatalogRevision,
      replacementEncodes: [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
      }],
    };
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      seeded.targetArchive.id,
      "rearchive-acceptance-parity",
    );
    const web = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, {
        ...command,
        preview: true,
      }),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
      () => fixture.mediaLibraryPath,
    );
    const cli = await fixture.run([
      "catalog-review",
      "preview-rearchive-acceptance",
      seeded.targetArchive.id,
      "--json",
      JSON.stringify(command),
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE",
        reasons: [{ code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE" }],
      },
    });
    expect(access.catalog.listDiscSelections({
      ids: [seeded.sourceSelection.id],
    })).toEqual([expect.objectContaining({
      id: seeded.sourceSelection.id,
    })]);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: seeded.targetArchive.id,
    })).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: predecessor.id,
        status: "queued",
        reservesOutputPath: true,
        predecessorEncodeJobId: null,
      }),
    ]);
    const sqlite = new DatabaseSync(fixture.databasePath);
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE operation = 'rearchive.accept.preview'
    `).get()).toEqual({ count: 0 });
    sqlite.close();
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("blocks unavailable Re-archive mapping consistently through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedRearchiveCatalogReviewFixture(fixture);
  const shown = await fixture.run([
    "catalog-review",
    "show",
    seeded.targetArchive.id,
  ]);
  const initial = (shown.result as {
    rearchiveProposal: {
      catalogRevision: string;
      sourceCatalogRevision: string;
      mappings: Array<{
        sourceDiscSelectionId: string;
        proposedMapping: {
          mediaItemId: string;
          sourceIdentity: { kind: "dvd_title"; titleNumber: number };
          label: string | null;
        };
      }>;
    };
  }).rearchiveProposal;
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    seeded.targetArchive.id,
    "rearchive-mapping-unavailable-parity",
    { archiveRecovery: { id: "rearchive-mapping-unavailable-recovery" } },
  );
  const access = fixture.openAccess();
  try {
    const previewCommand = {
      action: "preview_rearchive_mapping_proposal" as const,
      catalogRevision: initial.catalogRevision,
      sourceCatalogRevision: initial.sourceCatalogRevision,
      mappings: [],
    };
    const previewWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, previewCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const previewCli = await fixture.run([
      "catalog-review",
      "preview-rearchive-proposal",
      seeded.targetArchive.id,
      "--json",
      JSON.stringify(previewCommand),
    ]);
    expect(previewWeb.status).toBe(409);
    expect(previewCli.exitCode).toBe(2);
    expect(previewCli.result).toEqual(await previewWeb.json());
    expect(previewCli.result).toMatchObject({
      error: {
        code: "CATALOG_MAPPING_UNAVAILABLE",
        reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
      },
    });

    const saveCommand = {
      ...previewCommand,
      action: "save_rearchive_mapping_proposal" as const,
      mutationKey: "00000000-0000-4000-8000-000000000411",
    };
    const saveWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, saveCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const saveCli = await fixture.run([
      "catalog-review",
      "save-rearchive-proposal",
      seeded.targetArchive.id,
      "--key",
      "00000000-0000-4000-8000-000000000412",
      "--json",
      JSON.stringify(saveCommand),
    ]);
    expect(saveWeb.status).toBe(409);
    expect(saveCli.exitCode).toBe(2);
    expect(saveCli.result).toEqual(await saveWeb.json());
    expect(access.catalog.readRearchiveMappingProposal(
      seeded.targetArchive.id,
    )).toMatchObject({ persisted: false });

  } finally {
    access.close();
    fixture.dispose();
  }
});

it("blocks headerless marked Re-archive mapping through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedRearchiveCatalogReviewFixture(fixture);
  const shown = await fixture.run([
    "catalog-review",
    "show",
    seeded.targetArchive.id,
  ]);
  const initial = (shown.result as {
    rearchiveProposal: {
      catalogRevision: string;
      sourceCatalogRevision: string;
    };
  }).rearchiveProposal;
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    seeded.targetArchive.id,
    "rearchive-headerless-parity",
    { omitEvidenceHeader: true },
  );
  const access = fixture.openAccess();
  try {
    const previewCommand = {
      action: "preview_rearchive_mapping_proposal" as const,
      catalogRevision: initial.catalogRevision,
      sourceCatalogRevision: initial.sourceCatalogRevision,
      mappings: [],
    };
    const previewWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, previewCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const previewCli = await fixture.run([
      "catalog-review",
      "preview-rearchive-proposal",
      seeded.targetArchive.id,
      "--json",
      JSON.stringify(previewCommand),
    ]);
    expect(previewWeb.status).toBe(409);
    expect(previewCli.exitCode).toBe(2);
    expect(previewCli.result).toEqual(await previewWeb.json());
    expect(previewCli.result).toMatchObject({
      error: { code: "CATALOG_MAPPING_UNAVAILABLE" },
    });

    const saveCommand = {
      ...previewCommand,
      action: "save_rearchive_mapping_proposal" as const,
      mutationKey: "00000000-0000-4000-8000-000000000413",
    };
    const saveWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, saveCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const saveCli = await fixture.run([
      "catalog-review",
      "save-rearchive-proposal",
      seeded.targetArchive.id,
      "--key",
      "00000000-0000-4000-8000-000000000414",
      "--json",
      JSON.stringify(saveCommand),
    ]);
    expect(saveWeb.status).toBe(409);
    expect(saveCli.exitCode).toBe(2);
    expect(saveCli.result).toEqual(await saveWeb.json());
    expect(saveCli.result).toMatchObject({
      error: { code: "CATALOG_MAPPING_UNAVAILABLE" },
    });
    expect(access.catalog.readRearchiveMappingProposal(
      seeded.targetArchive.id,
    )).toMatchObject({ persisted: false });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("validates Re-archive mapping sources against current evidence through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seeded = seedRearchiveCatalogReviewFixture(fixture);
  const shown = await fixture.run([
    "catalog-review",
    "show",
    seeded.targetArchive.id,
  ]);
  const initial = (shown.result as {
    rearchiveProposal: {
      catalogRevision: string;
      sourceCatalogRevision: string;
      mappings: Array<{
        sourceDiscSelectionId: string;
        proposedMapping: {
          mediaItemId: string;
          label: string | null;
        };
      }>;
    };
  }).rearchiveProposal;
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    seeded.targetArchive.id,
    "rearchive-current-source-parity",
    { archiveRecovery: { id: "rearchive-current-source-recovery" } },
  );
  const access = fixture.openAccess();
  try {
    const checkpoint = access.catalog.findDvdArchiveEvidenceHeader(
      seeded.targetArchive.id,
    )!;
    access.catalog.recordDvdTitleIdentityObservations({
      originalDiscArchiveId: seeded.targetArchive.id,
      checkpoint: {
        manifestId: checkpoint.currentManifestId,
        manifestRevision: checkpoint.currentManifestRevision,
        manifestDigest: checkpoint.currentManifestDigest,
      },
      observations: [{
        displayTitleNumber: 1,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 1,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 1,
        chapterCount: 1,
        sourceExtents: [{ startLba: 0, sectorCount: 1 }],
      }],
    });
    const refreshed = await fixture.run([
      "catalog-review",
      "show",
      seeded.targetArchive.id,
    ]);
    const current = (refreshed.result as { rearchiveProposal: typeof initial })
      .rearchiveProposal;
    const proposedMapping = current.mappings[0]!;
    const baseCommand = {
      action: "preview_rearchive_mapping_proposal" as const,
      catalogRevision: current.catalogRevision,
      sourceCatalogRevision: current.sourceCatalogRevision,
      mappings: [{
        sourceDiscSelectionId: proposedMapping.sourceDiscSelectionId,
        mediaItemId: proposedMapping.proposedMapping.mediaItemId,
        sourceIdentity: { kind: "main_feature" as const },
        label: proposedMapping.proposedMapping.label,
      }],
    };
    const unsupportedWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, baseCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const unsupportedCli = await fixture.run([
      "catalog-review",
      "preview-rearchive-proposal",
      seeded.targetArchive.id,
      "--json",
      JSON.stringify(baseCommand),
    ]);
    expect(unsupportedWeb.status).toBe(200);
    expect(unsupportedCli.exitCode).toBe(0);
    expect(unsupportedCli.result).toEqual(await unsupportedWeb.json());
    expect(unsupportedCli.result).toMatchObject({
      state: "incompatible",
      mappings: [{
        state: "incompatible",
        reason:
          "Current-evidence mapping requires an exact DVD title or chapter range",
      }],
    });

    const absentCommand = {
      ...baseCommand,
      mappings: [{
        ...baseCommand.mappings[0],
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 2 },
      }],
    };
    const absentWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, absentCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const absentCli = await fixture.run([
      "catalog-review",
      "preview-rearchive-proposal",
      seeded.targetArchive.id,
      "--json",
      JSON.stringify(absentCommand),
    ]);
    expect(absentWeb.status).toBe(200);
    expect(absentCli.exitCode).toBe(0);
    expect(absentCli.result).toEqual(await absentWeb.json());
    expect(absentCli.result).toMatchObject({
      state: "incompatible",
      mappings: [{
        state: "incompatible",
        reason:
          "Catalog mapping source is not present in current Title Identity evidence",
      }],
    });

    const saveCommand = {
      ...absentCommand,
      action: "save_rearchive_mapping_proposal" as const,
      mutationKey: "00000000-0000-4000-8000-000000000415",
    };
    const saveWeb = await createCatalogReviewRoute(
      catalogReviewMutationRequest(seeded.targetArchive.id, saveCommand),
      seeded.targetArchive.id,
      () => access,
      () => trustedOrigin,
    );
    const saveCli = await fixture.run([
      "catalog-review",
      "save-rearchive-proposal",
      seeded.targetArchive.id,
      "--key",
      "00000000-0000-4000-8000-000000000416",
      "--json",
      JSON.stringify(saveCommand),
    ]);
    expect(saveWeb.status).toBe(409);
    expect(saveCli.exitCode).toBe(2);
    expect(saveCli.result).toEqual(await saveWeb.json());
    expect(saveCli.result).toMatchObject({
      error: { code: "REARCHIVE_PROPOSAL_INCOMPATIBLE" },
    });
    expect(access.catalog.readRearchiveMappingProposal(
      seeded.targetArchive.id,
    )).toMatchObject({ persisted: false });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("shares Encode Job validation and keyed outcomes across web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, correctedSelection } = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.list({ mediaDomain: "dvd_video", activeOnly: true })[0]!;
    const outputPath = join(fixture.mediaLibraryPath, "synthetic-parity.mkv");
    const key = "synthetic-encode-parity-key";
    const config = () => ({
      mediaLibraryPath: fixture.mediaLibraryPath,
      webTrustedOrigin: "http://localhost:3000",
    });
    const request = (body: object, method = "POST") => new Request("http://localhost:3000/api/encode-jobs", {
      method,
      headers: { "Content-Type": "application/json", Host: "localhost:3000", Origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    });
    const web = await createEncodeJobsRoute(request({
      mutationKey: key,
      discSelectionId: correctedSelection.id,
      encodingProfileId: profile.id,
      outputPath,
    }), () => access, config);
    expect(web.status).toBe(200);
    const webResult = await web.json();
    const cli = await fixture.run([
      "encode-enqueue", "--key", key,
      "--disc-selection-id", correctedSelection.id,
      "--encoding-profile-id", profile.id,
      "--output-path", outputPath,
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toMatchObject({ job: webResult.job });
    const conflict = await fixture.run([
      "encode-enqueue", "--key", key,
      "--disc-selection-id", correctedSelection.id,
      "--encoding-profile-id", profile.id,
      "--output-path", join(fixture.mediaLibraryPath, "different.mkv"),
    ]);
    expect(conflict.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
    const jobId = webResult.job.id as string;
    const cancelled = await fixture.run([
      "encode-cancel", "--key", "synthetic-encode-parity-cancel",
      "--encode-job-id", jobId,
    ]);
    expect(cancelled.exitCode).toBe(0);
    const webCancelled = await createEncodeJobsRoute(request({
      action: "cancel", encodeJobId: jobId,
      mutationKey: "synthetic-encode-parity-cancel",
    }, "PATCH"), () => access, config);
    expect(webCancelled.status).toBe(200);
    expect(await webCancelled.json()).toMatchObject({ job: (cancelled.result as { job: object }).job });
    const webRequeued = await createEncodeJobsRoute(request({
      action: "requeue", encodeJobId: jobId,
      mutationKey: "synthetic-encode-parity-requeue",
    }, "PATCH"), () => access, config);
    expect(webRequeued.status).toBe(200);
    const requeued = await fixture.run([
      "encode-requeue", "--key", "synthetic-encode-parity-requeue",
      "--encode-job-id", jobId,
    ]);
    expect(requeued.exitCode).toBe(0);
    expect(requeued.result).toMatchObject({ job: (await webRequeued.json()).job });
    expect(access.encodeJobs.list()).toHaveLength(2);
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("reports Archive Recovery conflicts identically through Encode web and CLI operations", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, correctedSelection, predecessor } =
    seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.list({
      mediaDomain: "dvd_video",
      activeOnly: true,
    })[0]!;
    const recoveryId = "synthetic-encode-conflict-recovery";
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      archive.id,
      "encode-conflict-parity",
      {
        archiveRecovery: {
          id: recoveryId,
          workStatus: "claimed",
        },
      },
    );
    const mutationKey = "synthetic-encode-conflict-enqueue";
    const outputPath = join(
      fixture.mediaLibraryPath,
      "encode-conflict-parity.mkv",
    );
    const config = () => ({
      mediaLibraryPath: fixture.mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const webPreview = await createEncodeJobsRoute(new Request(
      `${trustedOrigin}/api/encode-jobs`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
        },
        body: JSON.stringify({
          action: "preview_requeue",
          encodeJobId: predecessor.id,
        }),
      },
    ), () => access, config);
    const cliPreview = await fixture.run([
      "encode-requeue-preview",
      "--encode-job-id",
      predecessor.id,
    ]);
    expect(webPreview.status).toBe(409);
    expect(cliPreview.exitCode).toBe(2);
    expect(cliPreview.result).toEqual(await webPreview.json());
    expect(cliPreview.result).toMatchObject({
      error: {
        code: "ENCODE_WORK_CONFLICT",
        current: {
          archiveRecovery: { id: recoveryId },
        },
      },
    });

    const web = await createEncodeJobsRoute(new Request(
      `${trustedOrigin}/api/encode-jobs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
        },
        body: JSON.stringify({
          mutationKey,
          discSelectionId: correctedSelection.id,
          encodingProfileId: profile.id,
          outputPath,
        }),
      },
    ), () => access, config);
    const cli = await fixture.run([
      "encode-enqueue",
      "--key",
      mutationKey,
      "--disc-selection-id",
      correctedSelection.id,
      "--encoding-profile-id",
      profile.id,
      "--output-path",
      outputPath,
    ]);

    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "ENCODE_WORK_CONFLICT",
        blockingReasons: [{ code: "ENCODE_WORK_CONFLICT" }],
        current: {
          archiveRecovery: {
            id: recoveryId,
            originalDiscArchiveId: archive.id,
            work: {
              status: "claimed",
            },
          },
          encodeJobs: [],
        },
      },
    });
    expect(JSON.stringify(cli.result)).not.toContain("claimToken");
    expect(JSON.stringify(cli.result)).not.toContain("claimedBy");
    expect(access.encodeJobs.list()).toHaveLength(1);
    const sqlite = new DatabaseSync(fixture.databasePath);
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE key = ?
    `).get(mutationKey)).toEqual({ count: 0 });
    sqlite.close();

    const archiveWeb = createOperationsResponse(
      access,
      new Request(
        `${trustedOrigin}/api/operations?kind=original-disc-archives&id=${archive.id}`,
      ),
      fixture.originalsLibraryPath,
    );
    const archiveCli = await fixture.run([
      "inspect",
      "original-disc-archives",
      archive.id,
    ]);
    expect(archiveCli.result).toEqual(await archiveWeb.json());
    expect(archiveCli.result).toMatchObject({
      item: {
        archiveRecovery: {
          currentWork: {
            recovery: expect.objectContaining({ status: "claimed" }),
            encodeJobs: [],
          },
        },
      },
    });
    expect(JSON.stringify(archiveCli.result)).not.toContain("claimToken");
    expect(JSON.stringify(archiveCli.result)).not.toContain("claimedBy");

    const encodeWeb = createOperationsResponse(
      access,
      new Request(
        `${trustedOrigin}/api/operations?kind=encode-jobs&id=${predecessor.id}`,
      ),
      fixture.originalsLibraryPath,
    );
    const encodeCli = await fixture.run([
      "inspect",
      "encode-jobs",
      predecessor.id,
    ]);
    expect(encodeCli.result).toEqual(await encodeWeb.json());
    expect(encodeCli.result).toMatchObject({
      item: {
        currentWork: {
          recovery: {
            id: recoveryId,
            work: expect.objectContaining({ status: "claimed" }),
          },
        },
        availableActions: expect.arrayContaining([
          expect.objectContaining({
            name: "requeue",
            eligible: false,
            blockingReasons: [expect.objectContaining({
              code: "ENCODE_WORK_CONFLICT",
            })],
          }),
        ]),
      },
    });
    expect(JSON.stringify(encodeCli.result)).not.toContain("claimToken");
    expect(JSON.stringify(encodeCli.result)).not.toContain("claimedBy");
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("replays persisted Encode enqueue outcomes before DVD evidence blocking", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, correctedSelection } = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.list({
      mediaDomain: "dvd_video",
      activeOnly: true,
    })[0]!;
    const outputPath = join(
      fixture.mediaLibraryPath,
      "evidence-enqueue-replay.mkv",
    );
    const mutationKey = "synthetic-evidence-enqueue-replay";
    const blockedMutationKey = "synthetic-evidence-enqueue-blocked";
    const config = () => ({
      mediaLibraryPath: fixture.mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const request = (key: string, path = outputPath) => new Request(
      `${trustedOrigin}/api/encode-jobs`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
        },
        body: JSON.stringify({
          mutationKey: key,
          discSelectionId: correctedSelection.id,
          encodingProfileId: profile.id,
          outputPath: path,
        }),
      },
    );
    const command = (key: string, path = outputPath) => [
      "encode-enqueue", "--key", key,
      "--disc-selection-id", correctedSelection.id,
      "--encoding-profile-id", profile.id,
      "--output-path", path,
    ];

    const committed = await createEncodeJobsRoute(
      request(mutationKey),
      () => access,
      config,
    );
    expect(committed.status).toBe(200);
    const committedResult = await committed.json() as { job: object };
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      archive.id,
      "encode-enqueue-replay-parity",
    );

    const webReplay = await createEncodeJobsRoute(
      request(mutationKey),
      () => access,
      config,
    );
    const cliReplay = await fixture.run(command(mutationKey));
    expect(webReplay.status).toBe(200);
    expect(cliReplay.exitCode).toBe(0);
    expect(await webReplay.json()).toEqual(committedResult);
    expect(cliReplay.result).toMatchObject(committedResult);

    const changedPath = join(
      fixture.mediaLibraryPath,
      "evidence-enqueue-replay-changed.mkv",
    );
    const webConflict = await createEncodeJobsRoute(
      request(mutationKey, changedPath),
      () => access,
      config,
    );
    const cliConflict = await fixture.run(command(mutationKey, changedPath));
    expect(webConflict.status).toBe(409);
    expect(cliConflict.exitCode).toBe(2);
    expect(cliConflict.result).toEqual(await webConflict.json());
    expect(cliConflict.result).toMatchObject({
      error: { code: "MUTATION_KEY_CONFLICT" },
    });

    const webBlocked = await createEncodeJobsRoute(
      request(blockedMutationKey),
      () => access,
      config,
    );
    const cliBlocked = await fixture.run(command(blockedMutationKey));
    expect(webBlocked.status).toBe(409);
    expect(cliBlocked.exitCode).toBe(2);
    expect(cliBlocked.result).toEqual(await webBlocked.json());
    expect(cliBlocked.result).toEqual(dvdEvidenceEncodingUnavailableError);

    const sqlite = new DatabaseSync(fixture.databasePath);
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE key = ?
    `).get(blockedMutationKey)).toEqual({ count: 0 });
    sqlite.close();
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("replays persisted Encode requeue outcomes before DVD evidence blocking", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive, correctedSelection } = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.list({
      mediaDomain: "dvd_video",
      activeOnly: true,
    })[0]!;
    const original = access.encodeJobs.enqueue({
      discSelectionId: correctedSelection.id,
      encodingProfileId: profile.id,
      outputPath: join(
        fixture.mediaLibraryPath,
        "evidence-requeue-replay.mkv",
      ),
    });
    access.encodeJobs.requestCancellation(original.id);
    const mutationKey = "synthetic-evidence-requeue-replay";
    const blockedMutationKey = "synthetic-evidence-requeue-blocked";
    const config = () => ({
      mediaLibraryPath: fixture.mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const request = (key: string, priority?: number) => new Request(
      `${trustedOrigin}/api/encode-jobs`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
        },
        body: JSON.stringify({
          action: "requeue",
          mutationKey: key,
          encodeJobId: original.id,
          priority,
        }),
      },
    );
    const command = (key: string, priority?: number) => [
      "encode-requeue", "--key", key,
      "--encode-job-id", original.id,
      ...(priority === undefined ? [] : ["--priority", String(priority)]),
    ];

    const committed = await createEncodeJobsRoute(
      request(mutationKey),
      () => access,
      config,
    );
    expect(committed.status).toBe(200);
    const committedResult = await committed.json() as { job: object };
    access.encodeJobs.requestCancellation(original.id);
    markArchiveWithDvdRecoveryEvidence(
      fixture.databasePath,
      archive.id,
      "encode-requeue-replay-parity",
    );

    const webReplay = await createEncodeJobsRoute(
      request(mutationKey),
      () => access,
      config,
    );
    const cliReplay = await fixture.run(command(mutationKey));
    expect(webReplay.status).toBe(200);
    expect(cliReplay.exitCode).toBe(0);
    expect(await webReplay.json()).toEqual(committedResult);
    expect(cliReplay.result).toMatchObject(committedResult);

    const webConflict = await createEncodeJobsRoute(
      request(mutationKey, 7),
      () => access,
      config,
    );
    const cliConflict = await fixture.run(command(mutationKey, 7));
    expect(webConflict.status).toBe(409);
    expect(cliConflict.exitCode).toBe(2);
    expect(cliConflict.result).toEqual(await webConflict.json());
    expect(cliConflict.result).toMatchObject({
      error: { code: "MUTATION_KEY_CONFLICT" },
    });

    const webBlocked = await createEncodeJobsRoute(
      request(blockedMutationKey),
      () => access,
      config,
    );
    const cliBlocked = await fixture.run(command(blockedMutationKey));
    expect(webBlocked.status).toBe(409);
    expect(cliBlocked.exitCode).toBe(2);
    expect(cliBlocked.result).toEqual(await webBlocked.json());
    expect(cliBlocked.result).toEqual(dvdEvidenceEncodingUnavailableError);

    const sqlite = new DatabaseSync(fixture.databasePath);
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE key = ?
    `).get(blockedMutationKey)).toEqual({ count: 0 });
    sqlite.close();
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("shares Catalog Review completion preview and replay across web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  try {
    const revision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt.toISOString();
    const command = {
      action: "complete_review",
      catalogRevision: revision,
      outcome: "reviewed_with_selections",
      replacementEncodes: [],
    } as const;
    const webPreviewResponse = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, { ...command, preview: true }),
      archive.id,
      () => access,
      () => trustedOrigin,
      () => fixture.mediaLibraryPath,
    );
    expect(webPreviewResponse.status).toBe(200);
    const webPreview = await webPreviewResponse.json() as {
      previewToken: string;
      catalogRevision: string;
      [key: string]: unknown;
    };
    const cliPreview = await fixture.run([
      "catalog-review", "preview-completion", archive.id,
      "--json", JSON.stringify(command),
    ]);
    expect(cliPreview.exitCode).toBe(0);
    const cliPreviewResult = cliPreview.result as {
      previewToken: string;
      catalogRevision: string;
      [key: string]: unknown;
    };
    expect({ ...cliPreviewResult, previewToken: "<opaque>" }).toEqual({
      ...webPreview,
      previewToken: "<opaque>",
    });

    const mutationKey = "synthetic-catalog-completion-parity-key";
    const webCompletion = await createCatalogReviewRoute(
      catalogReviewMutationRequest(archive.id, {
        ...command,
        mutationKey,
        acknowledgedRevision: webPreview.catalogRevision,
        previewToken: webPreview.previewToken,
        acknowledge: true,
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
      () => fixture.mediaLibraryPath,
    );
    expect(webCompletion.status).toBe(200);
    const webResult = await webCompletion.json();
    const cliCompletion = await fixture.run([
      "catalog-review", "complete", archive.id,
      "--key", mutationKey,
      "--revision", cliPreviewResult.catalogRevision,
      "--preview-token", cliPreviewResult.previewToken,
      "--acknowledge", "--json", JSON.stringify(command),
    ]);
    expect(cliCompletion.exitCode).toBe(0);
    expect(cliCompletion.result).toEqual(webResult);
    expect(access.encodeJobs.list()).toHaveLength(1);
  } finally {
    access.close();
    fixture.dispose();
  }
});

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

it("shares supported, unsupported, and failed recovery storage preflight through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  const verifiedFacts = {
    filesystemType: "synthetic-local",
    storageClass: "local" as const,
    mutationProtection: {
      status: "verified" as const, contract: "linux-rwf-atomic-v1" as const,
      unitBytes: 4_096, memoryAlignmentBytes: 512,
    },
    journalReservationBytes: 1_048_576,
    journalPayloadBytes: 983_040,
    journalReservation: "verified" as const,
    journalSynchronization: "verified" as const,
    imageSynchronization: "verified" as const,
    checkpointSynchronization: "verified" as const,
    checkpointReplacement: "verified" as const,
    directorySynchronization: "verified" as const,
    crossProcessWriterExclusion: "verified" as const,
    crossHostWriterExclusion: "not_applicable" as const,
    disconnectionBehavior: "not_applicable" as const,
  };
  try {
    const cases = [
      {
        input: {
          contractVersion: "dvd-recovery-storage-preflight-v1" as const,
          status: "supported" as const,
          reasonCode: null,
          facts: verifiedFacts,
        },
        expected: { available: true, blockingReasons: [] },
      },
      {
        input: {
          contractVersion: "dvd-recovery-storage-preflight-v1" as const,
          status: "unsupported" as const,
          reasonCode: "STORAGE_UNSUPPORTED" as const,
          facts: {
            ...verifiedFacts,
            filesystemType: "synthetic-network",
            storageClass: "network" as const,
            journalReservation: "not_tested" as const,
            journalSynchronization: "not_tested" as const,
            imageSynchronization: "not_tested" as const,
            checkpointSynchronization: "not_tested" as const,
            checkpointReplacement: "not_tested" as const,
            directorySynchronization: "not_tested" as const,
            crossProcessWriterExclusion: "not_tested" as const,
            crossHostWriterExclusion: "unproven" as const,
            disconnectionBehavior: "unproven" as const,
          },
        },
        expected: {
          available: false,
          blockingReasons: [expect.objectContaining({
            code: "STORAGE_UNSUPPORTED",
          })],
        },
      },
      {
        input: {
          contractVersion: "dvd-recovery-storage-preflight-v1" as const,
          status: "unsupported" as const,
          reasonCode: "STORAGE_UNSUPPORTED" as const,
          facts: {
            ...verifiedFacts,
            mutationProtection: {
              status: "unproven" as const, contract: null, unitBytes: null,
              memoryAlignmentBytes: null,
            },
            imageSynchronization: "not_tested" as const,
          },
        },
        expected: {
          available: false,
          blockingReasons: [expect.objectContaining({ code: "STORAGE_UNSUPPORTED" })],
        },
      },
      {
        input: {
          contractVersion: "dvd-recovery-storage-preflight-v1" as const,
          status: "failed_prerequisite" as const,
          reasonCode: "JOURNAL_CAPACITY_INSUFFICIENT" as const,
          facts: {
            ...verifiedFacts,
            mutationProtection: {
              ...verifiedFacts.mutationProtection,
              unitBytes: 1_048_576,
            },
            imageSynchronization: "not_tested" as const,
          },
        },
        expected: {
          available: false,
          blockingReasons: [expect.objectContaining({ code: "JOURNAL_CAPACITY_INSUFFICIENT" })],
        },
      },
      {
        input: {
          contractVersion: "dvd-recovery-storage-preflight-v1" as const,
          status: "failed_prerequisite" as const,
          reasonCode: "JOURNAL_SYNC_FAILED" as const,
          facts: {
            ...verifiedFacts,
            journalSynchronization: "failed" as const,
            imageSynchronization: "not_tested" as const,
            checkpointSynchronization: "not_tested" as const,
            checkpointReplacement: "not_tested" as const,
            directorySynchronization: "not_tested" as const,
            crossProcessWriterExclusion: "not_tested" as const,
          },
        },
        expected: {
          available: false,
          blockingReasons: [expect.objectContaining({
            code: "JOURNAL_SYNC_FAILED",
          })],
        },
      },
    ];

    for (const testCase of cases) {
      access.dvdRecoveryStorage.record(testCase.input);
      const web = createDeploymentReadinessResponse(access);
      const cli = await fixture.run(["readiness"]);

      expect(web.status).toBe(200);
      expect(cli.exitCode).toBe(0);
      expect(cli.result).toEqual(await web.json());
      expect(cli.result).toMatchObject({
        dvdRecoveryStorage: testCase.expected,
      });
    }
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
    const evidenceFixture = new DatabaseSync(fixture.databasePath);
    evidenceFixture.prepare(`
      INSERT INTO archive_requests (
        id, detected_disc_id, evidence_format, status, priority,
        fulfilled_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'fulfilled', 0, 1, 1, 1)
    `).run(
      "synthetic-evidence-request",
      archivedDisc.id,
      DVD_RECOVERY_EVIDENCE_FORMAT,
    );
    evidenceFixture.prepare(`
      INSERT INTO archive_jobs (
        id, archive_request_id, disc_inspection_id, detected_disc_id,
        original_disc_archive_id, evidence_format, attempt_ordinal, status,
        priority, progress_phase, progress_percent, progress_bytes,
        last_progress_at, started_at, completed_at, created_at, updated_at
      ) VALUES (?, 'synthetic-evidence-request', ?, ?, ?, ?, 1, 'completed',
        0, 'finalizing', 100, 2048, 1, 1, 1, 1, 1)
    `).run(
      "synthetic-evidence-job",
      completedInspection.id,
      archivedDisc.id,
      archiveId,
      DVD_RECOVERY_EVIDENCE_FORMAT,
    );
    evidenceFixture.prepare(`
      UPDATE original_disc_archives
      SET integrity = 'unknown',
          integrity_policy_version = NULL,
          bad_sector_count = NULL,
          bad_area_count = NULL,
          bad_sector_ranges = NULL,
          bad_sector_counts_by_title = NULL
      WHERE id = ?
    `).run(archiveId);
    const unrecoveredSourceRangeRecords = [{
      startLba: 0,
      sectorCount: 1,
      classification: "skipped_untested",
    }] as const;
    const unrecoveredSourceRanges = JSON.stringify(
      unrecoveredSourceRangeRecords,
    );
    const boundaryEvidence = archiveBoundaryEvidenceFromRecord(revisedArchive);
    if (boundaryEvidence === null) {
      throw new Error("Expected Archive Boundary Evidence");
    }
    const boundaryEvidenceDigest =
      createDvdArchiveBoundaryEvidenceDigest(boundaryEvidence);
    const manifestId = "synthetic-evidence-manifest";
    const {
      unrecoveredSourceRangesDigest: sourceRangesDigest,
      manifestDigest,
    } = createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: archiveId,
      revision: 1,
      previousManifestId: null,
      previousManifestDigest: null,
      recoveryReadId: null,
      recoveryReadEvidenceDigest: null,
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      imageFingerprint: revisedArchive.fingerprint,
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 1,
      boundaryPolicyVersion: revisedArchive.boundaryPolicyVersion!,
      boundaryReportedSizeBytes: revisedArchive.boundaryReportedSizeBytes!,
      boundaryPublishedSizeBytes:
        revisedArchive.boundaryPublishedSizeBytes!,
      boundaryEvidenceDigest,
      unrecoveredSourceRanges: unrecoveredSourceRangeRecords,
    });
    evidenceFixture.prepare(`
      INSERT INTO dvd_archive_evidence_manifests (
        id, original_disc_archive_id, revision, evidence_format,
        image_fingerprint, sector_size_bytes, accepted_end_lba_exclusive,
        boundary_policy_version, boundary_reported_size_bytes,
        boundary_published_size_bytes, boundary_evidence_digest,
        unrecovered_source_ranges, unrecovered_source_ranges_digest,
        manifest_digest, created_at
      )
      SELECT ?, id, 1, ?, fingerprint, 2048, 1,
        boundary_policy_version, boundary_reported_size_bytes,
        boundary_published_size_bytes, ?, ?, ?, ?, 1
      FROM original_disc_archives
      WHERE id = ?
    `).run(
      manifestId,
      DVD_RECOVERY_EVIDENCE_FORMAT,
      boundaryEvidenceDigest,
      unrecoveredSourceRanges,
      sourceRangesDigest,
      manifestDigest,
      archiveId,
    );
    evidenceFixture.prepare(`
      INSERT INTO dvd_archive_evidence_headers (
        original_disc_archive_id, source_archive_job_id, evidence_format,
        boundary_policy_version, boundary_reported_size_bytes,
        boundary_published_size_bytes, boundary_evidence_digest,
        sector_size_bytes, accepted_end_lba_exclusive, current_manifest_id,
        current_manifest_revision, current_manifest_digest, created_at,
        updated_at
      )
      SELECT id, 'synthetic-evidence-job', ?, boundary_policy_version,
        boundary_reported_size_bytes, boundary_published_size_bytes, ?,
        2048, 1, ?, 1, ?, 1, 1
      FROM original_disc_archives
      WHERE id = ?
    `).run(
      DVD_RECOVERY_EVIDENCE_FORMAT,
      boundaryEvidenceDigest,
      manifestId,
      manifestDigest,
      archiveId,
    );
    evidenceFixture.close();
    const laggingProjectionResponse = createOperationsResponse(
      access,
      new Request(
        `http://localhost/api/operations?kind=original-disc-archives&id=${archiveId}`,
      ),
    );
    expect(await laggingProjectionResponse.json()).toMatchObject({
      item: {
        integrity: "incomplete_read",
        badSectorCount: 1,
        badAreaCount: 1,
        badSectorRanges: null,
        structuralAssessment: {
          state: "pending",
          currentAssessmentIdentity: null,
          unavailableReasons: [{ code: "ASSESSMENT_PENDING" }],
        },
      },
    });
    const structuralAssessment = {
      assessment: createDvdStructuralAssessment({
        checkpoint: {
          originalDiscArchiveId: archiveId,
          manifestId,
          manifestRevision: 1,
          manifestDigest,
          acceptedEndLbaExclusive: 1,
        },
        findings: ([
          "filesystem_structure",
          "dvd_navigation",
          "title_enumeration",
        ] as const).map((checkKind) => ({
          checkKind,
          policyVersion: "synthetic-structural-check-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 1,
            observedSectorCount: 1,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: `synthetic-evidence:${checkKind}`,
        })),
      }),
    };
    const structuralFixture = new DatabaseSync(fixture.databasePath);
    structuralFixture.prepare(`
      INSERT INTO dvd_structural_assessments (
        id, original_disc_archive_id, manifest_id, manifest_revision,
        manifest_digest, accepted_end_lba_exclusive, policy_version,
        validity, findings, created_at
      ) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, 2)
    `).run(
      structuralAssessment.assessment.id,
      archiveId,
      manifestId,
      manifestDigest,
      structuralAssessment.assessment.policyVersion,
      structuralAssessment.assessment.validity,
      JSON.stringify(structuralAssessment.assessment.findings),
    );
    structuralFixture.prepare(`
      INSERT INTO dvd_structural_check_attempts (
        original_disc_archive_id, manifest_id, manifest_revision,
        manifest_digest, accepted_end_lba_exclusive, outcome,
        assessment_id, findings, created_at
      ) VALUES (?, ?, 1, ?, 1, 'completed', ?, ?, 2)
    `).run(
      archiveId,
      manifestId,
      manifestDigest,
      structuralAssessment.assessment.id,
      JSON.stringify(structuralAssessment.assessment.findings),
    );
    structuralFixture.close();
    const catalogReviewResponse = await createCatalogReviewRoute(
      new Request(`http://localhost/api/catalog-reviews/${archiveId}`),
      archiveId,
      () => access,
    );
    const catalogReviewCli = await fixture.run([
      "catalog-review",
      "show",
      archiveId,
    ]);
    expect(catalogReviewCli.result).toEqual(
      await catalogReviewResponse.json(),
    );
    expect(catalogReviewCli.result).toMatchObject({
      archive: {
        integrity: "incomplete_read",
        badSectorCount: 1,
        badAreaCount: 1,
        badSectorRanges: null,
      },
    });
    expect(readDashboardSnapshot(access, {
      catalogReviewView: "reviewed",
    }).catalogReview).toMatchObject({
      status: "loaded",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: archiveId,
          integrity: "incomplete_read",
          badSectorCount: 1,
          badAreaCount: 1,
          badSectorRanges: null,
        }),
      ]),
    });
    const projectionFixture = new DatabaseSync(fixture.databasePath);
    projectionFixture.prepare(`
      UPDATE original_disc_archives
      SET integrity_evidence_revision = 1,
          integrity = 'incomplete_read',
          integrity_policy_version = ?,
          bad_sector_count = 1,
          bad_area_count = 1,
          bad_sector_ranges = '[{"startLba":0,"sectorCount":1}]',
          bad_sector_counts_by_title = NULL
      WHERE id = ?
    `).run(DVD_RECOVERY_EVIDENCE_FORMAT, archiveId);
    projectionFixture.prepare(`
      INSERT INTO archive_recoveries (
        id, original_disc_archive_id, attempt_id, attempt_ordinal, status,
        created_at, updated_at
      ) VALUES (
        'synthetic-evidence-recovery', ?,
        'synthetic-evidence-recovery-attempt', 1, 'eligible', 1, 1
      )
    `).run(archiveId);
    projectionFixture.prepare(`
      INSERT INTO archive_requests (
        id, detected_disc_id, evidence_format, status, priority,
        created_at, updated_at
      ) VALUES (
        'synthetic-evidence-pending-request', ?, ?, 'pending', 0, 1, 1
      )
    `).run(archivedDisc.id, DVD_RECOVERY_EVIDENCE_FORMAT);
    projectionFixture.close();
    const markedRequestResponse = createOperationsResponse(
      access,
      new Request(
        "http://localhost/api/operations?kind=archive-requests&id=synthetic-evidence-pending-request",
      ),
    );
    const markedRequestCli = await fixture.run([
      "inspect",
      "archive-requests",
      "synthetic-evidence-pending-request",
    ]);
    expect(markedRequestCli.result).toEqual(
      await markedRequestResponse.json(),
    );
    expect(markedRequestCli.result).toMatchObject({
      item: {
        evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
        waiting: {
          code: "dvd_recovery_evidence_admission_closed",
          message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        },
        availableActions: [
          expect.objectContaining({
            name: "cancel",
            eligible: true,
            blockingReasons: [],
          }),
          expect.objectContaining({
            name: "retry",
            eligible: false,
            blockingReasons: [{
              code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
              message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
            }],
          }),
        ],
      },
    });
    const cancelKey = "00000000-0000-4000-8000-000000000403";
    const cancelRequest = () => new Request(
      "http://localhost/api/archive-requests/synthetic-evidence-pending-request",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ mutationKey: cancelKey }),
      },
    );
    const webCancellation = await createArchiveRequestCancellationRoute(
      cancelRequest(),
      "synthetic-evidence-pending-request",
      () => access,
      () => "http://localhost",
    );
    const cliCancellation = await fixture.run([
      "cancel-archive-request",
      "--key",
      cancelKey,
      "--archive-request-id",
      "synthetic-evidence-pending-request",
    ]);
    expect(webCancellation.status).toBe(200);
    expect(cliCancellation.exitCode).toBe(0);
    expect(cliCancellation.result).toEqual(await webCancellation.json());
    expect(cliCancellation.result).toMatchObject({
      archiveRequest: { status: "cancelled" },
    });
    const replayedCancellation = await createArchiveRequestCancellationRoute(
      cancelRequest(),
      "synthetic-evidence-pending-request",
      () => access,
      () => "http://localhost",
    );
    expect(replayedCancellation.status).toBe(200);
    expect(await replayedCancellation.json()).toEqual(cliCancellation.result);

    const retryKey = "00000000-0000-4000-8000-000000000404";
    const retryRequest = new Request(
      "http://localhost/api/archive-requests/synthetic-evidence-pending-request/retry",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ mutationKey: retryKey }),
      },
    );
    const webRetry = await createArchiveRequestRetryRoute(
      retryRequest,
      "synthetic-evidence-pending-request",
      () => access,
      () => "http://localhost",
    );
    const cliRetry = await fixture.run([
      "retry-archive-request",
      "--key",
      retryKey,
      "--archive-request-id",
      "synthetic-evidence-pending-request",
    ]);
    expect(webRetry.status).toBe(409);
    expect(cliRetry.exitCode).toBe(2);
    expect(cliRetry.result).toEqual(await webRetry.json());
    expect(cliRetry.result).toEqual({
      error: {
        code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
        message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        blockingReasons: [{
          code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
          message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        }],
      },
    });
    expect(access.archiveRequests.find(
      "synthetic-evidence-pending-request" as ArchiveRequestId,
    )).toMatchObject({ status: "cancelled" });
    const replayFixture = new DatabaseSync(fixture.databasePath);
    expect(replayFixture.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE key IN (?, ?)
    `).get(
      "00000000-0000-4000-8000-000000000403",
      "00000000-0000-4000-8000-000000000404",
    )).toEqual({ count: 1 });
    replayFixture.close();
    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: selection.id }),
      ]));
    const unreviewedEvidenceFixture = new DatabaseSync(fixture.databasePath);
    unreviewedEvidenceFixture.prepare(`
      UPDATE original_disc_archives
      SET catalog_review_outcome = 'needs_review',
          catalog_reviewed_at = NULL
      WHERE id = ?
    `).run(archiveId);
    unreviewedEvidenceFixture.close();
    const encodeConfig = () => ({
      mediaLibraryPath: fixture.mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const blockedEncodeError = {
      error: {
        code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
        message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
        blockingReasons: [{
          code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
          message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
        }],
      },
    };
    for (const blockedMutation of [
      {
        command: [
          "encode-requeue-preview", "--encode-job-id", encodeJob.id,
        ],
        method: "PATCH",
        body: {
          action: "preview_requeue",
          encodeJobId: encodeJob.id,
        },
      },
      {
        command: [
          "encode-enqueue", "--key", "synthetic-evidence-encode-enqueue",
          "--disc-selection-id", selection.id,
          "--encoding-profile-id", profile.id,
          "--output-path", join(fixture.mediaLibraryPath, "blocked-evidence.mkv"),
        ],
        method: "POST",
        body: {
          mutationKey: "synthetic-evidence-encode-enqueue",
          discSelectionId: selection.id,
          encodingProfileId: profile.id,
          outputPath: join(fixture.mediaLibraryPath, "blocked-evidence.mkv"),
        },
      },
      {
        command: [
          "encode-requeue", "--key", "synthetic-evidence-encode-requeue",
          "--encode-job-id", encodeJob.id,
        ],
        method: "PATCH",
        body: {
          action: "requeue",
          mutationKey: "synthetic-evidence-encode-requeue",
          encodeJobId: encodeJob.id,
        },
      },
    ] as const) {
      const web = await createEncodeJobsRoute(new Request(
        `${trustedOrigin}/api/encode-jobs`,
        {
          method: blockedMutation.method,
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: trustedOrigin,
          },
          body: JSON.stringify(blockedMutation.body),
        },
      ), () => access, encodeConfig);
      const cli = await fixture.run(blockedMutation.command);
      expect(web.status).toBe(409);
      expect(cli.exitCode).toBe(2);
      expect(cli.result).toEqual(await web.json());
      expect(cli.result).toEqual(blockedEncodeError);
    }
    const encodeReplayFixture = new DatabaseSync(fixture.databasePath);
    expect(encodeReplayFixture.prepare(`
      SELECT count(*) AS count
      FROM mutation_invocations
      WHERE key IN (?, ?)
    `).get(
      "synthetic-evidence-encode-enqueue",
      "synthetic-evidence-encode-requeue",
    )).toEqual({ count: 0 });
    encodeReplayFixture.close();
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
        new Request(`http://localhost/api/operations?kind=${kind}`),
        fixture.originalsLibraryPath);
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
        new Request(`http://localhost/api/operations?kind=${kind}&id=${id}`),
        fixture.originalsLibraryPath);
      expect(response.status).toBe(200);
      expect((await fixture.run(["inspect", kind, id])).result).toEqual(await response.json());
    }
    const encodeHistoryResponse = createOperationsResponse(
      access,
      new Request(
        `http://localhost/api/operations?kind=encode-jobs&id=${encodeJob.id}&limit=1&offset=0`,
      ),
    );
    expect(encodeHistoryResponse.status).toBe(200);
    expect((await fixture.run([
      "inspect",
      "encode-jobs",
      encodeJob.id,
      "--limit",
      "1",
      "--offset",
      "0",
    ])).result).toEqual(await encodeHistoryResponse.json());
    for (const [target, expectedId] of [
      ["original_disc_archive", archiveId],
      ["encode_job_output", encodeJob.id],
    ] as const) {
      const response = createFilesystemVerificationInventoryRoute(
        new Request(
          `http://localhost/api/filesystem-verification?target=${target}&offset=0`,
        ),
        () => access,
      );
      const cli = await fixture.run([
        "filesystem-verification-inventory",
        "--target",
        target,
        "--offset",
        "0",
      ]);
      expect(cli.exitCode).toBe(0);
      expect(cli.result).toEqual(await response.json());
      expect(cli.result).toMatchObject({
        inventory: {
          target,
          items: expect.arrayContaining([
            expect.objectContaining({ id: expectedId, target }),
          ]),
        },
      });
    }
    expect((await fixture.run([
      "filesystem-verification-inventory",
      "--target",
      "unsupported",
    ])).result).toEqual({
      error: {
        code: "INVALID_ARGUMENTS",
        message: "A verification target and nonnegative offset are required.",
      },
    });
    expect((await fixture.run(["inspect", "disc-inspections", started.inspection.id])).result)
      .toMatchObject({ item: {
        attempts: [expect.objectContaining({ reasonCode: "metadata_read_failed" })],
        availableActions: [expect.objectContaining({ eligible: true })],
      } });
    await defaultArchiveImageOwnership.withInitialPublicationWriter({
      archiveId,
      imagePath: join(fixture.originalsLibraryPath, "synthetic.iso"),
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    });
    const archiveInspection = await fixture.run([
      "inspect", "original-disc-archives", archiveId,
    ]);
    expect(archiveInspection.result).toMatchObject({ item: {
        boundaryReportedSizeBytes: 2_048,
        boundaryPublishedSizeBytes: 2_048,
        integrity: "incomplete_read",
        badSectorCount: 1,
        badAreaCount: 1,
        badSectorRanges: null,
        structuralAssessment: {
          state: "current",
          checkpoint: { manifestId, manifestRevision: 1 },
          currentAssessmentIdentity: structuralAssessment.assessment.id,
          assessment: {
            id: structuralAssessment.assessment.id,
            validity: "valid",
            findings: [
              { checkKind: "filesystem_structure", outcome: "valid" },
              { checkKind: "dvd_navigation", outcome: "valid" },
              { checkKind: "title_enumeration", outcome: "valid" },
            ],
          },
          unavailableReasons: [],
        },
        archiveRecovery: {
          available: false,
          blockingReasons: expect.arrayContaining([
            expect.objectContaining({
              code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
            }),
            expect.objectContaining({ code: "STORAGE_UNSUPPORTED" }),
          ]),
          storage: {
            available: false,
            blockingReasons: [expect.objectContaining({
              code: "STORAGE_UNSUPPORTED",
            })],
          },
          ownership: {
            writer: { state: "inactive" },
            workerClaim: { state: "none" },
            stableRead: { available: true, blockingReasons: [] },
          },
        },
      } });
    await defaultArchiveImageOwnership.withInitialPublicationWriter({
      archiveId,
      imagePath: join(fixture.originalsLibraryPath, "synthetic.iso"),
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        const response = createOperationsResponse(
          access,
          new Request(
            `http://localhost/api/operations?kind=original-disc-archives&id=${archiveId}`,
          ),
          fixture.originalsLibraryPath,
        );
        const cli = await fixture.run([
          "inspect",
          "original-disc-archives",
          archiveId,
        ]);
        expect(cli.result).toEqual(await response.json());
        expect(cli.result).toMatchObject({
          item: {
            archiveRecovery: {
              ownership: {
                writer: { state: "active" },
                workerClaim: { state: "active" },
                stableRead: {
                  available: false,
                  blockingReasons: [{ code: "WRITER_NOT_QUIESCENT" }],
                },
              },
            },
          },
        });
        const recoveryResponse = createOperationsResponse(
          access,
          new Request(
            "http://localhost/api/operations?kind=archive-recoveries&id=synthetic-evidence-recovery",
          ),
          fixture.originalsLibraryPath,
        );
        const recoveryCli = await fixture.run([
          "inspect",
          "archive-recoveries",
          "synthetic-evidence-recovery",
        ]);
        expect(recoveryCli.result).toEqual(await recoveryResponse.json());
        expect(recoveryCli.result).toMatchObject({
          item: {
            availableActions: expect.arrayContaining([
              expect.objectContaining({
                name: "resume",
                available: false,
                blockingReasons: expect.arrayContaining([
                  expect.objectContaining({ code: "WRITER_NOT_QUIESCENT" }),
                ]),
              }),
            ]),
          },
        });
      },
    });
    expect(
      (archiveInspection.result as {
        item: object;
      }).item,
    ).not.toHaveProperty("dvdRecoveryEvidence");
    expect(
      (archiveInspection.result as {
        item: object;
      }).item,
    ).not.toHaveProperty("integrityEvidenceRevision");
    expect((await fixture.run(["inspect", "encode-jobs", encodeJob.id])).result)
      .toMatchObject({ item: {
        status: "failed",
        history: [expect.objectContaining({ id: encodeJob.id })],
        correctionLinks: [expect.objectContaining({ id: encodeJob.id })],
        failureReports: [expect.objectContaining({ reasonCode: "command_failed" })],
        availableActions: expect.arrayContaining([
          expect.objectContaining({
            name: "requeue",
            eligible: false,
            blockingReasons: [expect.objectContaining({
              code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
              message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
            })],
          }),
        ]),
      } });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("shares Encoding Profile validation, replay, preview, and state changes between web and CLI", async () => {
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
    const invalidBody = {
      mutationKey: "synthetic-profile-parity-invalid-0001",
      key: "synthetic-invalid", displayName: "Synthetic invalid",
      settings: { preset: "Unsupported preset", container: "mkv" },
    };
    const invalidWeb = await mutate("POST", invalidBody);
    const invalidCli = await fixture.run([
      "create-encoding-profile", "--key", invalidBody.mutationKey,
      "--profile-key", invalidBody.key, "--display-name", invalidBody.displayName,
      "--preset", invalidBody.settings.preset,
    ]);
    expect(invalidWeb.status).toBe(400);
    expect(invalidCli.exitCode).toBe(2);
    expect(invalidCli.result).toMatchObject({
      error: { code: "INVALID_ENCODING_PROFILE", message: (await invalidWeb.json()).error },
    });
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
    const deactivateUrl = `${endpoint}?preview-profile-id=${encodeURIComponent(versionBody.profile.id)}&is-active=false`;
    const webDeactivatePreview = await createEncodingProfilesRoute(
      new Request(deactivateUrl), () => access, trustedOrigin,
    );
    expect(webDeactivatePreview.status).toBe(200);
    const deactivatePreview = await webDeactivatePreview.json() as { revision: string };
    expect((await fixture.run([
      "preview-encoding-profile-state", "--id", versionBody.profile.id, "--active", "false",
    ])).result).toEqual(deactivatePreview);
    const deactivated = await fixture.run([
      "deactivate-encoding-profile", "--key", "synthetic-profile-parity-key-0004",
      "--id", versionBody.profile.id, "--revision", deactivatePreview.revision, "--acknowledge",
    ]);
    expect(deactivated.exitCode).toBe(0);
    const webDeactivationReplay = await mutate("PATCH", {
      mutationKey: "synthetic-profile-parity-key-0004",
      id: versionBody.profile.id, isActive: false,
      expectedRevision: deactivatePreview.revision, acknowledge: true,
    });
    expect(webDeactivationReplay.status).toBe(200);
    expect(await webDeactivationReplay.json()).toEqual(deactivated.result);
    const staleWeb = await mutate("PATCH", {
      mutationKey: "synthetic-profile-parity-key-0005",
      id: versionBody.profile.id, isActive: true,
      expectedRevision: preview.revision, acknowledge: true,
    });
    const staleCli = await fixture.run([
      "activate-encoding-profile", "--key", "synthetic-profile-parity-key-0005",
      "--id", versionBody.profile.id, "--revision", preview.revision, "--acknowledge",
    ]);
    expect(staleWeb.status).toBe(409);
    expect(staleCli.result).toMatchObject({
      error: { code: "STALE_PROFILE_PREVIEW", message: (await staleWeb.json()).error },
    });
    const list = await createEncodingProfilesRoute(
      new Request(endpoint), () => access, trustedOrigin,
    );
    expect((await fixture.run(["list-encoding-profiles"])).result).toEqual(await list.json());
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("shares Media Item search, revision previews, keyed mutations, and replay between web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  const route = (body: unknown) => createCatalogReviewRoute(
    new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    }),
    archive.id,
    () => access,
    () => "http://localhost:3000",
  );
  try {
    const created = await route({
      action: "create_media_item", mutationKey: "media-parity-create",
      mediaItem: { kind: "movie", title: "Synthetic Extra Film", tmdbIdentity: { mediaType: "movie", tmdbId: 123 } },
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const itemId = createdBody.mediaItem.id as string;
    expect((await fixture.run([
      "media-item", "create", "--key", "media-parity-create", "--kind", "movie",
      "--title", "Synthetic Extra Film", "--tmdb-type", "movie", "--tmdb-id", "123",
    ])).result).toEqual(createdBody);
    const search = await createMediaItemSearchRoute(
      new Request("http://localhost:3000/api/media-items?query=Synthetic%20Extra"),
      () => access,
    );
    expect((await fixture.run(["media-item", "search", "--query", "Synthetic Extra"])).result)
      .toEqual(await search.json());
    const preview = await createMediaItemPreviewRoute(
      new Request(`http://localhost:3000/api/media-items/${itemId}?action=update&changes=${encodeURIComponent(JSON.stringify({ title: "Synthetic Revised Film" }))}`),
      itemId,
      () => access,
    );
    const previewBody = await preview.json();
    expect((await fixture.run(["media-item", "preview", "update", itemId,
      "--title", "Synthetic Revised Film"])).result)
      .toEqual(previewBody);
    const missingKey = await route({
      action: "update_media_item", mediaItemId: itemId,
      acknowledgedRevision: previewBody.revision,
      changes: { title: "Unkeyed change" },
    });
    expect(missingKey.status).toBe(400);
    expect(access.catalog.listMediaItems({ ids: [itemId as MediaItemId] })[0]?.title)
      .toBe("Synthetic Extra Film");
    const updated = await fixture.run([
      "media-item", "update", itemId, "--key", "media-parity-update",
      "--acknowledge", previewBody.revision, "--title", "Synthetic Revised Film",
    ]);
    expect(updated.exitCode).toBe(0);
    const webReplay = await route({
      action: "update_media_item", mutationKey: "media-parity-update",
      mediaItemId: itemId,
      acknowledgedRevision: previewBody.revision,
      changes: { title: "Synthetic Revised Film" },
    });
    expect(webReplay.status).toBe(200);
    expect(await webReplay.json()).toEqual(updated.result);
    const stale = await route({
      action: "update_media_item", mutationKey: "media-parity-stale",
      mediaItemId: itemId, acknowledgedRevision: previewBody.revision,
      changes: { title: "Synthetic Revised Film" },
    });
    expect(stale.status).toBe(409);
    expect(access.catalog.listMediaItems({ ids: [itemId as MediaItemId] })[0]?.title)
      .toBe("Synthetic Revised Film");
    const deletePreview = await fixture.run(["media-item", "preview", "delete", itemId]);
    const revision = (deletePreview.result as { revision: string }).revision;
    const deleted = await route({
      action: "delete_media_item", mutationKey: "media-parity-delete",
      mediaItemId: itemId, acknowledgedRevision: revision,
    });
    expect(deleted.status).toBe(200);
    expect((await fixture.run([
      "media-item", "delete", itemId, "--key", "media-parity-delete", "--acknowledge", revision,
    ])).result).toEqual(await deleted.json());
  } finally {
    access.close();
    fixture.dispose();
  }
});

it.each([
  "scsi_capacity_exceeds_cached_size",
  "cached_size_exceeds_scsi_capacity",
] as const)("shares the persistent informational %s notice through web and CLI", async (notice) => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const drive = access.catalog.upsertOpticalDrive({ devicePath: "/dev/sr0", isEnabled: true, isPresent: true });
    const started = access.discInspections.beginOrResume({
      opticalDriveId: drive.id, mediaGeneration: "synthetic-notice-generation", mediaCapacityBytes: 8192,
    });
    access.discInspections.record(started.claim!, { type: "read_path_notice", notice });
    const response = createOperationsResponse(access, new Request(
      `http://localhost/api/operations?kind=disc-inspections&id=${started.inspection.id}`,
    ));
    const cli = await fixture.run(["inspect", "disc-inspections", started.inspection.id]);
    expect(response.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await response.json());
    expect(cli.result).toMatchObject({ item: {
      status: "running", phase: "settling", reasonCode: null, readPathNotice: notice,
    } });
    expect(readDashboardSnapshot(access).opticalDrives).toMatchObject({ items: [
      { currentInspection: { readPathNotice: notice } },
    ] });
  } finally {
    access.close(); fixture.dispose();
  }
});
