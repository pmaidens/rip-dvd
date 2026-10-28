import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

import {
  archiveBoundaryEvidenceFromRecord,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  createDvdStructuralAssessment,
  createDvdTitleDamageAssessment,
  dvdTitleIdentityCatalogMappingProjectionDigest,
  DVD_RECOVERY_EVIDENCE_FORMAT,
} from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

const databasePath = process.env.RIP_DVD_DATABASE_PATH;
const mediaLibraryPath = process.env.RIP_DVD_MEDIA_LIBRARY_PATH;
const originalsLibraryPath = process.env.RIP_DVD_ORIGINALS_LIBRARY_PATH;

if (!databasePath || !mediaLibraryPath || !originalsLibraryPath) {
  throw new Error("Catalog Review browser fixture paths are required");
}

const expectedFixtureRoot = resolve("test-results/catalog-review-browser-data");
if (
  resolve(databasePath) !== join(expectedFixtureRoot, "rip-dvd.sqlite") ||
  resolve(mediaLibraryPath) !== join(expectedFixtureRoot, "media") ||
  resolve(originalsLibraryPath) !== join(expectedFixtureRoot, "originals")
) {
  throw new Error(
    `Refusing to seed outside the Catalog Review browser fixture root: ${expectedFixtureRoot}`,
  );
}

const fixtureRoot = dirname(databasePath);
rmSync(fixtureRoot, { force: true, recursive: true });
mkdirSync(mediaLibraryPath, { recursive: true });
mkdirSync(originalsLibraryPath, { recursive: true });

const access = createLegacySidecarDataAccess({
  databasePath,
  mediaLibraryPath,
  originalsLibraryPath,
});

const longToken = "UNBROKEN-CATALOG-LABEL-".repeat(8);
const longMediaTitle = "A deliberately long Catalog Review title with edition, language, season, and archival context ";

function createArchive({ key, label, fingerprintFill, titles }) {
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/browser-${key}`,
    displayName: `Browser fixture ${key}`,
    isPresent: true,
  });
  const fingerprint = `sha256:${fingerprintFill.repeat(
    Math.ceil(64 / fingerprintFill.length),
  ).slice(0, 64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: label,
    scanData: {
      schemaVersion: 2,
      contentId: fingerprint,
      titles,
    },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  return access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: join(originalsLibraryPath, `${key}.iso`),
    fingerprint,
  });
}

async function seedArchiveRequest(variant) {
  const fingerprint = `sha256:${(variant === "desktop" ? "12" : variant === "mobile" ? "34" : "56").repeat(32)}`;
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/browser-intake-${variant}`,
    displayName: `Browser intake ${variant}`,
    isEnabled: true,
    isPresent: true,
  });
  const observation = {
    opticalDriveId: drive.id,
    mediaGeneration: `browser-intake-${variant}`,
    mediaCapacityBytes: 2_048,
  };
  const started = access.discInspections.beginOrResume(observation);
  if (!started.claim) throw new Error("Expected an intake fixture inspection claim");
  let claim = started.claim;
  for (let index = 0; index < 2; index += 1) {
    // Exercise the normal settling contract before completing the inspection.
    await setTimeout(2_500);
    claim = access.discInspections.recordSettlingObservation(claim, observation).claim;
  }
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: variant === "notification" ? "SYNTHETIC_NOTIFICATION_DISC" : `HTTP archive fixture ${variant}`,
    scanData: { schemaVersion: 2, contentId: fingerprint, titles: [detailedTitle(1, 5_400, 14)] },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  const inspection = access.discInspections.record(claim, { type: "complete", detectedDiscId: disc.id });
  if (variant === "notification") {
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const job = access.archiveJobs.startForInspection(inspection.id, "synthetic-notification-worker");
    if (!job) throw new Error("Expected a synthetic notification target Archive Job");
    access.archiveJobs.fail(job, "Synthetic outcome for notification navigation coverage");
  }
}

function completeReview(archiveId) {
  const archive = access.catalog.listOriginalDiscArchives({ ids: [archiveId] })[0];
  if (!archive) throw new Error(`Missing browser fixture archive ${archiveId}`);
  access.catalog.completeCatalogReview(
    archive.id,
    archive.updatedAt,
    "reviewed_with_selections",
  );
}

function detailedTitle(number, durationSeconds, chapters) {
  return {
    number,
    durationSeconds,
    chapters,
    audioStreams: Array.from({ length: 8 }, (_, index) => ({
      id: 128 + index,
      language: `Language-${number}-${index}-${"x".repeat(34)}`,
      format: `DTS-HD-Master-Audio-${"y".repeat(24)}`,
      channels: index % 2 === 0 ? 6 : 2,
    })),
    subtitles: Array.from({ length: 12 }, (_, index) => ({
      id: 32 + index,
      language: `Subtitle-${number}-${index}-${"z".repeat(34)}`,
      content: `Closed-captions-and-forced-narrative-${index}`,
    })),
  };
}

function seedTitleDamagePaging(variant, fingerprintFill) {
  const key = `damage-${variant}`;
  const acceptedEndLbaExclusive = 4_096;
  const archive = createArchive({
    key,
    label: `CATALOG_BROWSER_DAMAGE_${variant.toUpperCase()}`,
    fingerprintFill,
    titles: Array.from({ length: 21 }, (_, index) =>
      detailedTitle(index + 1, 3_600, 4)
    ),
  });
  const fixtureId = `browser-${key}`;
  const requestId = `${fixtureId}-request`;
  const jobId = `${fixtureId}-job`;
  const inspectionId = `${fixtureId}-inspection`;
  const manifestId = `${fixtureId}-manifest`;
  const recoveryId = `${fixtureId}-recovery`;
  const recoveryAttemptId = `${recoveryId}:attempt:1`;
  const unrecoveredSourceRanges = [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }];
  const sqlite = new DatabaseSync(databasePath);
  sqlite.prepare(`
    UPDATE original_disc_archives
    SET size_bytes = ?,
        boundary_policy_version = 'dvd-archive-boundary-v2',
        boundary_reported_size_bytes = ?,
        boundary_published_size_bytes = ?,
        boundary_excluded_sector_count = 0,
        boundary_first_excluded_lba = ?,
        boundary_maximum_referenced_lba = NULL,
        boundary_read_failure_classifier_version = 'scsi-read-classifier-v2',
        boundary_read_failure_scsi_status = 2,
        boundary_read_failure_host_status = 0,
        boundary_read_failure_driver_status = 8,
        boundary_read_failure_sense_response_code = 114,
        boundary_read_failure_sense_key = 5,
        boundary_read_failure_asc = 33,
        boundary_read_failure_ascq = 0,
        integrity = 'unknown',
        integrity_evidence_revision = NULL,
        integrity_policy_version = NULL,
        bad_sector_count = NULL,
        bad_area_count = NULL,
        bad_sector_ranges = NULL,
        bad_sector_counts_by_title = NULL
    WHERE id = ?
  `).run(
    acceptedEndLbaExclusive * 2_048,
    acceptedEndLbaExclusive * 2_048,
    acceptedEndLbaExclusive * 2_048,
    acceptedEndLbaExclusive,
    archive.id,
  );
  const updatedArchive = access.catalog.listOriginalDiscArchives({
    ids: [archive.id],
  })[0];
  if (!updatedArchive) throw new Error("Missing Title Damage fixture archive");
  const boundaryEvidence = archiveBoundaryEvidenceFromRecord(updatedArchive);
  if (!boundaryEvidence) {
    throw new Error("Missing Title Damage fixture boundary evidence");
  }
  const boundaryEvidenceDigest =
    createDvdArchiveBoundaryEvidenceDigest(boundaryEvidence);
  const manifestInput = {
    originalDiscArchiveId: archive.id,
    revision: 1,
    previousManifestId: null,
    previousManifestDigest: null,
    recoveryReadId: null,
    recoveryReadEvidenceDigest: null,
    evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
    imageFingerprint: updatedArchive.fingerprint,
    sectorSizeBytes: 2_048,
    acceptedEndLbaExclusive,
    boundaryPolicyVersion: boundaryEvidence.policyVersion,
    boundaryReportedSizeBytes: boundaryEvidence.reportedSizeBytes,
    boundaryPublishedSizeBytes: boundaryEvidence.publishedSizeBytes,
    boundaryEvidenceDigest,
    unrecoveredSourceRanges,
  };
  const manifestDigests = createDvdArchiveEvidenceManifestDigests(
    manifestInput,
  );
  sqlite.prepare(`
    INSERT INTO disc_inspections (
      id, optical_drive_id, detected_disc_id, media_generation, is_current,
      status, phase, total_bytes, phase_started_at, attempt_started_at,
      started_at, completed_at, created_at, updated_at
    )
    SELECT ?, optical_drive_id, id, ?, 0, 'completed', 'confirming_media', ?,
      1, 1, 1, 1, 1, 1
    FROM detected_discs
    WHERE id = ?
  `).run(
    inspectionId,
    `${fixtureId}-generation`,
    boundaryEvidence.reportedSizeBytes,
    archive.detectedDiscId,
  );
  sqlite.prepare(`
    INSERT INTO archive_requests (
      id, detected_disc_id, evidence_format, status, priority,
      fulfilled_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'fulfilled', 0, 1, 1, 1)
  `).run(requestId, archive.detectedDiscId, DVD_RECOVERY_EVIDENCE_FORMAT);
  sqlite.prepare(`
    INSERT INTO archive_jobs (
      id, archive_request_id, disc_inspection_id, detected_disc_id,
      original_disc_archive_id, evidence_format, attempt_ordinal, status,
      priority, progress_phase, progress_percent, progress_bytes,
      last_progress_at, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'completed', 0, 'finalizing', 100, ?,
      1, 1, 1, 1, 1)
  `).run(
    jobId,
    requestId,
    inspectionId,
    archive.detectedDiscId,
    archive.id,
    DVD_RECOVERY_EVIDENCE_FORMAT,
    boundaryEvidence.publishedSizeBytes,
  );
  sqlite.prepare(`
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, evidence_format,
      image_fingerprint, sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (?, ?, 1, ?, ?, 2048, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    manifestId,
    archive.id,
    DVD_RECOVERY_EVIDENCE_FORMAT,
    updatedArchive.fingerprint,
    acceptedEndLbaExclusive,
    boundaryEvidence.policyVersion,
    boundaryEvidence.reportedSizeBytes,
    boundaryEvidence.publishedSizeBytes,
    boundaryEvidenceDigest,
    JSON.stringify(unrecoveredSourceRanges),
    manifestDigests.unrecoveredSourceRangesDigest,
    manifestDigests.manifestDigest,
  );
  sqlite.prepare(`
    INSERT INTO dvd_archive_evidence_headers (
      original_disc_archive_id, source_archive_job_id, evidence_format,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      sector_size_bytes, accepted_end_lba_exclusive, current_manifest_id,
      current_manifest_revision, current_manifest_digest, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 2048, ?, ?, 1, ?, 1, 1)
  `).run(
    archive.id,
    jobId,
    DVD_RECOVERY_EVIDENCE_FORMAT,
    boundaryEvidence.policyVersion,
    boundaryEvidence.reportedSizeBytes,
    boundaryEvidence.publishedSizeBytes,
    boundaryEvidenceDigest,
    acceptedEndLbaExclusive,
    manifestId,
    manifestDigests.manifestDigest,
  );
  sqlite.prepare(`
    INSERT INTO archive_recoveries (
      id, original_disc_archive_id, attempt_id, attempt_ordinal, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'eligible', 1, 1)
  `).run(recoveryId, archive.id, recoveryAttemptId);
  sqlite.prepare(`
    INSERT INTO archive_recovery_work (
      archive_recovery_id, original_disc_archive_id, attempt_id, status,
      requested_at, claimed_by, claim_token, claimed_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, 'claimed', NULL, ?, ?, 1, 1, 1)
  `).run(
    recoveryId,
    archive.id,
    recoveryAttemptId,
    "synthetic-browser-recovery-worker",
    "synthetic-browser-recovery-claim",
  );
  sqlite.prepare(`
    UPDATE archive_recoveries
    SET status = 'running', updated_at = 2
    WHERE id = ?
  `).run(recoveryId);
  sqlite.close();

  const checkpoint = {
    originalDiscArchiveId: archive.id,
    manifestId,
    manifestRevision: 1,
    manifestDigest: manifestDigests.manifestDigest,
    acceptedEndLbaExclusive,
  };
  const reviewSet = access.catalog.recordDvdTitleIdentityObservations({
    originalDiscArchiveId: archive.id,
    checkpoint,
    observations: Array.from({ length: 21 }, (_, index) => ({
      displayTitleNumber: index + 1,
      navigation: {
        videoTitleSetNumber: index + 1,
        titleSetTitleNumber: 1,
        programChainNumber: 1,
      },
      selectedPath: [{
        programNumber: 1,
        cellNumber: 1,
        vobId: index + 1,
        cellId: 1,
      }],
      angleNumber: 1,
      angleCount: 1,
      chapterStart: 1,
      chapterEnd: 4,
      chapterCount: 4,
      sourceExtents: [{ startLba: index * 100, sectorCount: 50 }],
    })),
  });
  const structuralFindings = [
    "filesystem_structure",
    "dvd_navigation",
    "title_enumeration",
  ].map((checkKind) => ({
    checkKind,
    policyVersion: `synthetic-${checkKind}-v1`,
    testedExtent: {
      startLba: 0,
      endLbaExclusive: acceptedEndLbaExclusive,
      observedSectorCount: 100,
    },
    outcome: "valid",
    reason: null,
    evidenceReference: `synthetic:${checkKind}`,
  }));
  const structural = createDvdStructuralAssessment({
    checkpoint,
    findings: structuralFindings,
  });
  const currentItems = reviewSet.items.filter((item) =>
    item.presentAtCurrentCheckpoint
  );
  const storedMappings = currentItems.map((item, index) => ({
    titleIdentityObservationId: item.observation.id,
    sourceReferences: item.observation.sourceExtents.map((range) => ({
      kind: "multiplexed_content",
      ...range,
    })),
    mappingCoverage: {
      state: "complete",
      policyVersion: "synthetic-title-map-v1",
      unknownReasons: [],
    },
    timingEvidence: {
      policyVersion: "dvd-title-damage-timing-v1",
      occurrences: index === 0
        ? [
          {
            playbackOccurrence: 1,
            spans: [{
              sourceRange: item.observation.sourceExtents[0],
              startMilliseconds: 62_000,
              endMilliseconds: 65_000,
              timingMethod: "synthetic-vobu-timing-v1",
              coverage: "source_span",
            }],
            unknownReasons: [],
          },
          {
            playbackOccurrence: 2,
            spans: [{
              sourceRange: item.observation.sourceExtents[0],
              startMilliseconds: 120_000,
              endMilliseconds: 130_000,
              timingMethod: "synthetic-cell-timing-v1",
              coverage: "whole_cell",
            }],
            unknownReasons: [],
          },
        ]
        : [{
          playbackOccurrence: 1,
          spans: [{
            sourceRange: item.observation.sourceExtents[0],
            startMilliseconds: index * 60_000,
            endMilliseconds: index * 60_000 + 10_000,
            timingMethod: "synthetic-cell-timing-v1",
            coverage: "whole_cell",
          }],
          unknownReasons: [],
        }],
    },
  }));
  const catalogMappingProjectionId =
    dvdTitleIdentityCatalogMappingProjectionDigest(
      reviewSet.checkpoint,
      reviewSet.items,
    );
  const sourceContinuity = {
    policyVersion: "dvd-title-source-continuity-v1",
    provenance: [{
      discConfirmationId: `${fixtureId}-confirmation`,
      archiveRecoveryId: recoveryId,
      archiveRecoveryAttemptId: recoveryAttemptId,
      verificationId: `${fixtureId}-verification`,
      verificationOutcome: "mismatch",
      verificationResultDigest: "d".repeat(64),
      confirmationCheckpoint: {
        manifestRevision: 1,
        manifestDigest: "e".repeat(64),
      },
      recoveredSourceRanges: [
        { startLba: 25, sectorCount: 2 },
        { startLba: 3_500, sectorCount: 2 },
      ],
    }],
  };
  const assessment = createDvdTitleDamageAssessment({
    checkpoint,
    titleIdentityReviewSetIdentity: reviewSet.reviewSetIdentity,
    catalogMappingProjectionId,
    structuralAssessmentIdentity: structural.id,
    structuralFindings: {
      dvdNavigation: "valid",
      titleEnumeration: "valid",
    },
    unrecoveredSourceRanges,
    sourceContinuity,
    titles: currentItems.map((item, index) => ({
      titleIdentityId: item.titleIdentityId,
      titleIdentityObservationId: item.observation.id,
      displayTitleNumber: item.observation.displayTitleNumber,
      selection: {
        selectedPath: item.observation.selectedPath,
        angleNumber: item.observation.angleNumber,
        chapterStart: item.observation.chapterStart,
        chapterEnd: item.observation.chapterEnd,
      },
      ...storedMappings[index],
    })),
  });
  const evidenceSqlite = new DatabaseSync(databasePath);
  evidenceSqlite.prepare(`
    INSERT INTO dvd_structural_assessments (
      id, original_disc_archive_id, manifest_id, manifest_revision,
      manifest_digest, accepted_end_lba_exclusive, policy_version, validity,
      findings, created_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 1)
  `).run(
    structural.id,
    archive.id,
    manifestId,
    manifestDigests.manifestDigest,
    acceptedEndLbaExclusive,
    structural.policyVersion,
    structural.validity,
    JSON.stringify(structural.findings),
  );
  evidenceSqlite.prepare(`
    INSERT INTO dvd_structural_check_attempts (
      original_disc_archive_id, manifest_id, manifest_revision,
      manifest_digest, accepted_end_lba_exclusive, outcome, assessment_id,
      findings, failure_code, failure_message, created_at
    ) VALUES (?, ?, 1, ?, ?, 'completed', ?, ?, NULL, NULL, 1)
  `).run(
    archive.id,
    manifestId,
    manifestDigests.manifestDigest,
    acceptedEndLbaExclusive,
    structural.id,
    JSON.stringify(structural.findings),
  );
  evidenceSqlite.prepare(`
    INSERT INTO dvd_title_damage_assessments (
      id, original_disc_archive_id, manifest_id, manifest_revision,
      manifest_digest, accepted_end_lba_exclusive,
      title_identity_review_set_identity, catalog_mapping_projection_id,
      structural_assessment_identity, policy_version, title_mappings,
      source_continuity, created_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    assessment.id,
    archive.id,
    manifestId,
    manifestDigests.manifestDigest,
    acceptedEndLbaExclusive,
    reviewSet.reviewSetIdentity,
    catalogMappingProjectionId,
    structural.id,
    assessment.policyVersion,
    JSON.stringify(storedMappings),
    JSON.stringify(sourceContinuity),
  );
  evidenceSqlite.prepare(`
    INSERT INTO dvd_title_damage_assessment_attempts (
      original_disc_archive_id, assessment_id, created_at
    ) VALUES (?, ?, 1)
  `).run(archive.id, assessment.id);
  evidenceSqlite.close();
  return { archive, recoveryId };
}

function seedKeyboardJourney(variant, fingerprintFill) {
  createArchive({
    key: `keyboard-${variant}`,
    label: `CATALOG_BROWSER_KEYBOARD_${variant.toUpperCase()}`,
    fingerprintFill,
    titles: [
      detailedTitle(1, 5_400, 14),
      detailedTitle(2, 2_400, 8),
    ],
  });
}

function seedComplexLayout(variant, fingerprintFill) {
  const key = `layout-${variant}`;
  const archive = createArchive({
    key,
    label: `CATALOG_BROWSER_LAYOUT_${variant.toUpperCase()}_${longToken}`.slice(0, 256),
    fingerprintFill,
    titles: [
      detailedTitle(1, 7_200, 18),
      detailedTitle(2, 5_100, 16),
      detailedTitle(3, 2_400, 10),
      detailedTitle(4, 2_360, 9),
      detailedTitle(5, 2_320, 9),
      detailedTitle(6, 75, 2),
    ],
  });
  const mistakenItem = access.catalog.createMediaItem({
    kind: "movie",
    title: `${longMediaTitle}mistaken ${variant} ${longToken}`.slice(0, 256),
  });
  const correctedItem = access.catalog.createMediaItem({
    kind: "movie",
    title: `${longMediaTitle}corrected ${variant} ${longToken}`.slice(0, 256),
  });
  const lockedItem = access.catalog.createMediaItem({
    kind: "bonus_feature",
    title: `${longMediaTitle}locked provenance ${variant} ${longToken}`.slice(0, 256),
  });
  const partialItem = access.catalog.createMediaItem({
    kind: "other",
    title: `${longMediaTitle}partial chapter selection ${variant}`,
  });
  const correctedSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: mistakenItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    label: `${longToken} corrected source`.slice(0, 256),
  });
  const lockedSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: lockedItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
    label: `${longToken} locked source`.slice(0, 256),
  });
  access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: partialItem.id,
    sourceIdentity: {
      kind: "dvd_chapters",
      titleNumber: 3,
      chapterStart: 1,
      chapterEnd: 4,
    },
    label: `${longToken} partial source`.slice(0, 256),
  });
  completeReview(archive.id);

  const profile = access.encodingProfiles.create({
    key: `browser-${variant}`,
    displayName: `Browser replacement profile with long descriptive context ${variant}`,
    mediaDomain: "dvd_video",
    settings: { preset: "HQ 480p30 Surround" },
  });
  const correctedJob = access.encodeJobs.enqueue({
    discSelectionId: correctedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `${key}-corrected-output.mkv`),
  });
  access.encodeJobs.enqueue({
    discSelectionId: lockedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `${key}-locked-output.mkv`),
  });
  for (let index = 0; index < 2; index += 1) {
    const claim = access.encodeJobs.claimNext(`browser-seed-${variant}-${index}`);
    if (!claim) throw new Error(`Missing browser fixture Encode Job ${index}`);
    access.encodeJobs.complete(claim);
  }
  const currentArchive = access.catalog.listOriginalDiscArchives({
    ids: [archive.id],
  })[0];
  if (!currentArchive) throw new Error(`Missing browser fixture archive ${archive.id}`);
  access.catalog.correctDiscSelection(correctedSelection.id, {
    originalDiscArchiveId: archive.id,
    catalogRevision: currentArchive.updatedAt,
    mediaItemId: correctedItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    reason: "The completed encode used the mistaken Catalog Review mapping.",
  });

  const plan = access.catalog.listCorrectedEncodeReplacementPlans({
    originalDiscArchiveId: archive.id,
    limit: 10,
  });
  if (plan[0]?.predecessorEncodeJobId !== correctedJob.id) {
    throw new Error("Browser fixture replacement plan was not created");
  }
}

function createEncodeQueueSelection({ key, label, fingerprintFill, title }) {
  const archive = createArchive({
    key,
    label,
    fingerprintFill,
    titles: [detailedTitle(1, 5_400, 14)],
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title,
    year: 2026,
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  completeReview(archive.id);
  return selection;
}

function seedEncodeQueue(variant, fingerprintFills) {
  const profile = access.encodingProfiles.create({
    key: `queue-${variant}`,
    displayName: `Queue browser profile ${variant}`,
    mediaDomain: "dvd_video",
    settings: { preset: "HQ 480p30 Surround", container: "mkv" },
  });
  const alternateProfile = access.encodingProfiles.create({
    key: `queue-alternate-${variant}`,
    displayName: `Queue alternate profile ${variant}`,
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30", container: "mkv" },
  });
  const newSelection = createEncodeQueueSelection({
    key: `queue-new-${variant}`,
    label: `ENCODE_QUEUE_NEW_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.newSelection,
    title: `Queue new ${variant}`,
  });
  const alternateRetryJob = access.encodeJobs.enqueue({
    discSelectionId: newSelection.id,
    encodingProfileId: alternateProfile.id,
    outputPath: join(
      mediaLibraryPath,
      `Queue new ${variant} alternate authoritative.mkv`,
    ),
    priority: 30,
  });
  const alternateRetryClaim = access.encodeJobs.claimNext(
    `queue-alternate-retry-${variant}`,
  );
  if (alternateRetryClaim?.id !== alternateRetryJob.id) {
    throw new Error(`Missing alternate retry queue fixture for ${variant}`);
  }
  access.encodeJobs.fail(alternateRetryClaim, "Alternate browser fixture failure");
  const completedSelection = createEncodeQueueSelection({
    key: `queue-completed-${variant}`,
    label: `ENCODE_QUEUE_COMPLETED_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.completedSelection,
    title: `Queue completed ${variant}`,
  });
  const completedJob = access.encodeJobs.enqueue({
    discSelectionId: completedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(
      mediaLibraryPath,
      `Queue completed ${variant} authoritative.mkv`,
    ),
    priority: 10,
  });
  const claim = access.encodeJobs.claimNext(`queue-completed-${variant}`);
  if (claim?.id !== completedJob.id) {
    throw new Error(`Missing completed queue fixture for ${variant}`);
  }
  access.encodeJobs.complete(claim);

  const activeSelection = createEncodeQueueSelection({
    key: `queue-active-${variant}`,
    label: `ENCODE_QUEUE_ACTIVE_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.activeSelection,
    title: `Queue active ${variant}`,
  });
  access.encodeJobs.enqueue({
    discSelectionId: activeSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `Queue active ${variant}.mkv`),
  });

  const failedSelection = createEncodeQueueSelection({
    key: `queue-failed-${variant}`,
    label: `ENCODE_QUEUE_FAILED_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.failedSelection,
    title: `Queue failed ${variant}`,
  });
  const failedJob = access.encodeJobs.enqueue({
    discSelectionId: failedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `Queue failed ${variant}.mkv`),
    priority: 20,
  });
  const failedClaim = access.encodeJobs.claimNext(`queue-failed-${variant}`);
  if (failedClaim?.id !== failedJob.id) {
    throw new Error(`Missing failed queue fixture for ${variant}`);
  }
  access.encodeJobs.fail(failedClaim, "Browser fixture failure");

  const batchArchive = createArchive({
    key: `queue-batch-${variant}`,
    label: `ENCODE_QUEUE_BATCH_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.batchSelections,
    titles: [
      detailedTitle(1, 5_400, 14),
      detailedTitle(2, 5_400, 14),
    ],
  });
  let secondSelection;
  for (const [titleNumber, title] of [
    [1, `Queue second ${variant}`],
    [2, `Queue conflict ${variant}`],
  ]) {
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title,
      year: 2026,
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: batchArchive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "dvd_title", titleNumber },
    });
    if (titleNumber === 1) secondSelection = selection;
  }
  completeReview(batchArchive.id);
  if (!secondSelection) {
    throw new Error(`Missing second queue fixture for ${variant}`);
  }
  access.encodeJobs.enqueue({
    discSelectionId: secondSelection.id,
    encodingProfileId: alternateProfile.id,
    outputPath: join(mediaLibraryPath, `Queue second ${variant} active.mkv`),
  });

  const overflowArchive = createArchive({
    key: `queue-overflow-${variant}`,
    label: `ENCODE_QUEUE_OVERFLOW_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.overflowSelection,
    titles: Array.from({ length: 101 }, (_, index) =>
      detailedTitle(index + 1, 5_400, 14)
    ),
  });
  for (let index = 0; index < 101; index += 1) {
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: `Queue filler ${variant} ${String(index).padStart(3, "0")}`,
      year: 2026,
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: overflowArchive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: index + 1 },
    });
  }
  completeReview(overflowArchive.id);

  const sqlite = new DatabaseSync(databasePath);
  sqlite.prepare(`
    update original_disc_archives
    set catalog_reviewed_at = 1
    where id = ?
  `).run(newSelection.originalDiscArchiveId);
  sqlite.close();
}

try {
  await Promise.all([seedArchiveRequest("desktop"), seedArchiveRequest("mobile"), seedArchiveRequest("notification")]);
  seedTitleDamagePaging("desktop", "ab");
  seedTitleDamagePaging("mobile", "cd");
  seedTitleDamagePaging("notification", "ef");
  const recoveryAlert = seedTitleDamagePaging("recovery-alert", "fa");
  const recovery = access.catalog.findArchiveRecoveryById(recoveryAlert.recoveryId);
  access.archiveRecoveryWork.release(recovery.work);
  const reconciliation = access.dvdRecoveryReconciliations.submit({
    mutationKey: "synthetic-browser-notification-reconciliation",
    archiveRecoveryId: recoveryAlert.recoveryId,
  });
  const reconciliationClaim = access.dvdRecoveryReconciliations.claimNext("synthetic-browser-notification-worker");
  if (reconciliationClaim?.id !== reconciliation.id) throw new Error("Expected synthetic notification reconciliation claim");
  access.dvdRecoveryReconciliations.fail(reconciliationClaim, "CONSISTENCY_FAULT");
  seedKeyboardJourney("desktop", "1");
  seedComplexLayout("desktop", "2");
  seedKeyboardJourney("mobile", "3");
  seedComplexLayout("mobile", "4");
  seedEncodeQueue("desktop", {
    newSelection: "5",
    completedSelection: "6",
    activeSelection: "7",
    failedSelection: "f",
    overflowSelection: "b",
    batchSelections: "d",
  });
  seedEncodeQueue("mobile", {
    newSelection: "8",
    completedSelection: "9",
    activeSelection: "a",
    failedSelection: "0",
    overflowSelection: "c",
    batchSelections: "e",
  });
} finally {
  access.close();
}
