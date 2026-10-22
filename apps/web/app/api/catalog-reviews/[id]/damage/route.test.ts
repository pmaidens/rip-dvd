import { expect, it } from "vitest";

import { createApplicationOperations } from "@rip-dvd/application";
import {
  createCleanReadArchiveIntegrityEvidence,
  type DvdTitleDamageAssessmentInspection,
} from "@rip-dvd/data-access";
import {
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";

import {
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../../../../../test/data-access-fixture";
import { startArchiveJob } from "../../../../../test/archive-job-fixture";
import { createCatalogTitleDamageRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

it("uses the shared paged Title Damage operation and rejects another revision's cursor", async () => {
  const persisted = dataAccessFixture.create();
  const drive = persisted.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-title-damage",
    isEnabled: true,
    isPresent: true,
  });
  const disc = persisted.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: "synthetic-title-damage",
    volumeLabel: "SYNTHETIC_TITLE_DAMAGE",
  });
  persisted.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  const claim = startArchiveJob(persisted, disc, "title-damage-worker");
  persisted.archiveJobs.publish(claim, {
    archivePath: "/media/originals/synthetic-title-damage.iso",
    boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(2_048),
    integrityEvidence: createCleanReadArchiveIntegrityEvidence("test-clean-v1"),
    sizeBytes: 2_048,
  });
  const archive = persisted.catalog.listOriginalDiscArchives()[0]!;
  const assessmentId = `dvd-title-damage-assessment:${"d".repeat(64)}`;
  const item = (number: number) => ({
    titleIdentityId: `synthetic-title-${number}`,
    titleIdentityObservationId: `synthetic-observation-${number}`,
    displayTitleNumber: number,
    selection: {
      selectedPath: [{
        programNumber: 1,
        cellNumber: 1,
        vobId: number,
        cellId: 1,
      }],
      angleNumber: 1,
      chapterStart: 1,
      chapterEnd: 1,
    },
    mappingCoverage: {
      state: "complete",
      policyVersion: "synthetic-title-map-v1",
      unknownReasons: [],
    },
    uniqueSourceRanges: [{ startLba: number * 10, sectorCount: 10 }],
    uniqueSourceSectorCount: 10,
    knownUnrecoveredSourceRanges: [],
    unrecoveredUniqueSourceSectorCount: 0,
    titleMissingSourcePercentage: 0,
  });
  const inspection = {
    schemaVersion: 1,
    policyVersion: "dvd-title-damage-assessment-v1",
    originalDiscArchiveId: archive.id,
    state: "current",
    checkpoint: {
      originalDiscArchiveId: archive.id,
      manifestId: "synthetic-manifest-1",
      manifestRevision: 1,
      manifestDigest: "a".repeat(64),
      acceptedEndLbaExclusive: 1_000,
    },
    currentAssessmentIdentity: assessmentId,
    assessment: {
      id: assessmentId,
      policyVersion: "dvd-title-damage-assessment-v1",
      checkpoint: {
        originalDiscArchiveId: archive.id,
        manifestId: "synthetic-manifest-1",
        manifestRevision: 1,
        manifestDigest: "a".repeat(64),
        acceptedEndLbaExclusive: 1_000,
      },
      titleIdentityReviewSetIdentity: "b".repeat(64),
      structuralAssessmentIdentity:
        `dvd-structural-assessment:${"c".repeat(64)}`,
      structuralFindings: {
        dvdNavigation: "valid",
        titleEnumeration: "valid",
      },
      items: [item(1), item(2)],
      unknownTitleImpact: {
        unrecoveredSourceSectorCount: 0,
        unrecoveredSourceRanges: [],
        reasons: [],
      },
      noTitleMissingSourceProved: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    unavailableReasons: [],
  } as unknown as DvdTitleDamageAssessmentInspection;
  const access = withSnapshotOverrides(persisted, {
    dvdTitleDamageAssessments: { inspect: () => inspection },
  });
  const url = `http://localhost:3000/api/catalog-reviews/${archive.id}/damage?limit=1`;
  const direct = createApplicationOperations(access)
    .inspectCatalogTitleDamage(archive.id, { limit: 1 });
  const response = createCatalogTitleDamageRoute(
    new Request(url),
    archive.id,
    () => access,
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(direct);
  expect(direct).toMatchObject({
    checkpointRevision: 1,
    items: [{ displayTitleNumber: 1 }],
    truncated: true,
    nextCursor: expect.any(String),
  });

  const decoded = JSON.parse(
    Buffer.from(direct.nextCursor!, "base64url").toString(),
  );
  decoded[2] = 2;
  const stale = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  const staleResponse = createCatalogTitleDamageRoute(
    new Request(
      `http://localhost:3000/api/catalog-reviews/${archive.id}/damage?cursor=${stale}`,
    ),
    archive.id,
    () => access,
  );
  expect(staleResponse.status).toBe(409);
  await expect(staleResponse.json()).resolves.toMatchObject({
    error: { code: "TITLE_DAMAGE_CURSOR_STALE" },
  });
});
