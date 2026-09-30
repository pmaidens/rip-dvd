import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  archiveBoundaryEvidenceFromRecord,
  createCleanReadArchiveIntegrityEvidence,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  DVD_RECOVERY_EVIDENCE_ADMISSION,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  DVD_RECOVERY_EVIDENCE_FORMAT,
} from "@rip-dvd/data-access";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import {
  encodeOutputArtifactIdentity,
  type CatalogMetadataLookup,
  type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import type { ArchiveRequestId, MediaItemId } from "@rip-dvd/data-access";

import {
  createOperatorWorkflowFixture,
  markArchiveWithDvdRecoveryEvidence,
  seedCatalogReviewForReadFixture,
  seedRearchiveCatalogReviewFixture,
} from "../../../operator-cli/src/operator-workflow.test-support.js";
import { createCatalogReviewRoute } from "./catalog-reviews/[id]/route";
import { createCatalogSuggestionRoute } from "./catalog-reviews/[id]/suggestion/route";
import { createDeploymentReadinessResponse } from "./deployment-readiness/route";
import { createHealthResponse } from "./health/route";
import { createOperationsResponse } from "./operations/route";
import { createArchiveRequestsRoute } from "./archive-requests/route";
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
    expect(cli.result).toEqual(dvdEvidenceEncodingUnavailableError);
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
      },
    });
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
        id, original_disc_archive_id, status, created_at, updated_at
      ) VALUES ('synthetic-evidence-recovery', ?, 'eligible', 1, 1)
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
      } });
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
