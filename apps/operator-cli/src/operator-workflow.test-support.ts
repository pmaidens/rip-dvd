import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  archiveBoundaryEvidenceFromRecord,
  createDataAccess,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  encodeOutputFilesystemIdentity,
} from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { seedRearchiveReviewFixtureForTest } from "@rip-dvd/data-access/rearchive-test-support";
import type {
  CatalogMetadataLookup,
  EncodeOutputMediaProbe,
} from "@rip-dvd/application";

import { runCommand } from "./command.js";

export function createOperatorWorkflowFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-operator-cli-"));
  const databasePath = join(directory, "catalog.sqlite");
  const mediaLibraryPath = join(directory, "movies");
  const originalsLibraryPath = join(directory, "originals");
  const operatorHostPath = join(directory, "operator-host");
  mkdirSync(mediaLibraryPath);
  mkdirSync(originalsLibraryPath);
  mkdirSync(operatorHostPath);

  const openAccess = () => createDataAccess({
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
  });

  return {
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
    operatorHostPath,
    openAccess,
    async run(
      args: readonly string[],
      lookup?: CatalogMetadataLookup | null,
      stdin?: string,
      options: {
        encodeOutputMediaProbe?: EncodeOutputMediaProbe;
        openAccess?: () => ReturnType<typeof openAccess>;
      } = {},
    ) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCommand(args, {
        openAccess,
        readFile: (path) => readFileSync(path, "utf8"),
        mediaLibraryPath: () => mediaLibraryPath,
        ...options,
        ...(lookup === undefined ? {} : { getLookup: () => lookup }),
        ...(stdin === undefined ? {} : { readStdin: () => stdin }),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      return {
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        result: JSON.parse(stdout.join("")) as unknown,
      };
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function markArchiveWithDvdRecoveryEvidence(
  databasePath: string,
  originalDiscArchiveId: string,
  fixtureId: string,
): void {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.prepare(`
      UPDATE original_disc_archives
      SET size_bytes = COALESCE(size_bytes, 2048),
          boundary_policy_version = COALESCE(
            boundary_policy_version,
            'dvd-archive-boundary-v1'
          ),
          boundary_reported_size_bytes = COALESCE(
            boundary_reported_size_bytes,
            size_bytes,
            2048
          ),
          boundary_published_size_bytes = COALESCE(
            boundary_published_size_bytes,
            size_bytes,
            2048
          ),
          boundary_excluded_sector_count = COALESCE(
            boundary_excluded_sector_count,
            0
          ),
          integrity = 'unknown',
          integrity_evidence_revision = NULL,
          integrity_policy_version = NULL,
          bad_sector_count = NULL,
          bad_area_count = NULL,
          bad_sector_ranges = NULL,
          bad_sector_counts_by_title = NULL
      WHERE id = ?
    `).run(originalDiscArchiveId);
    sqlite.prepare(`
      UPDATE original_disc_archives
      SET boundary_policy_version = 'dvd-archive-boundary-v2',
          boundary_first_excluded_lba = size_bytes / 2048,
          boundary_maximum_referenced_lba = NULL,
          boundary_read_failure_classifier_version = 'scsi-read-classifier-v2',
          boundary_read_failure_scsi_status = 2,
          boundary_read_failure_host_status = 0,
          boundary_read_failure_driver_status = 8,
          boundary_read_failure_sense_response_code = 114,
          boundary_read_failure_sense_key = 5,
          boundary_read_failure_asc = 33,
          boundary_read_failure_ascq = 0
      WHERE id = ?
        AND boundary_policy_version = 'dvd-archive-boundary-v1'
        AND boundary_excluded_sector_count = 0
    `).run(originalDiscArchiveId);
    const archive = sqlite.prepare(`
      SELECT detected_disc_id, fingerprint, size_bytes,
             boundary_policy_version, boundary_reported_size_bytes,
             boundary_published_size_bytes, boundary_excluded_sector_count,
             boundary_first_excluded_lba, boundary_maximum_referenced_lba,
             boundary_read_failure_classifier_version,
             boundary_read_failure_scsi_status,
             boundary_read_failure_host_status,
             boundary_read_failure_driver_status,
             boundary_read_failure_sense_response_code,
             boundary_read_failure_sense_key, boundary_read_failure_asc,
             boundary_read_failure_ascq
      FROM original_disc_archives
      WHERE id = ?
    `).get(originalDiscArchiveId) as {
      detected_disc_id: string;
      fingerprint: string;
      size_bytes: number;
      boundary_policy_version: string;
      boundary_reported_size_bytes: number;
      boundary_published_size_bytes: number;
      boundary_excluded_sector_count: number;
      boundary_first_excluded_lba: number | null;
      boundary_maximum_referenced_lba: number | null;
      boundary_read_failure_classifier_version: string | null;
      boundary_read_failure_scsi_status: number | null;
      boundary_read_failure_host_status: number | null;
      boundary_read_failure_driver_status: number | null;
      boundary_read_failure_sense_response_code: number | null;
      boundary_read_failure_sense_key: number | null;
      boundary_read_failure_asc: number | null;
      boundary_read_failure_ascq: number | null;
    } | undefined;
    if (archive === undefined) throw new Error("Expected evidence archive");
    const requestId = `${fixtureId}-evidence-request`;
    const jobId = `${fixtureId}-evidence-job`;
    const manifestId = `${fixtureId}-evidence-manifest`;
    const inspectionId = `${fixtureId}-evidence-inspection`;
    const boundaryEvidence = archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: archive.boundary_policy_version,
      boundaryReportedSizeBytes: archive.boundary_reported_size_bytes,
      boundaryPublishedSizeBytes: archive.boundary_published_size_bytes,
      boundaryExcludedSectorCount: archive.boundary_excluded_sector_count,
      boundaryFirstExcludedLba: archive.boundary_first_excluded_lba,
      boundaryMaximumReferencedLba: archive.boundary_maximum_referenced_lba,
      boundaryReadFailureClassifierVersion:
        archive.boundary_read_failure_classifier_version,
      boundaryReadFailureScsiStatus:
        archive.boundary_read_failure_scsi_status,
      boundaryReadFailureHostStatus:
        archive.boundary_read_failure_host_status,
      boundaryReadFailureDriverStatus:
        archive.boundary_read_failure_driver_status,
      boundaryReadFailureSenseResponseCode:
        archive.boundary_read_failure_sense_response_code,
      boundaryReadFailureSenseKey: archive.boundary_read_failure_sense_key,
      boundaryReadFailureAsc: archive.boundary_read_failure_asc,
      boundaryReadFailureAscq: archive.boundary_read_failure_ascq,
    });
    if (boundaryEvidence === null) {
      throw new Error("Expected Archive Boundary Evidence");
    }
    const boundaryDigest =
      createDvdArchiveBoundaryEvidenceDigest(boundaryEvidence);
    const {
      unrecoveredSourceRangesDigest: sourceRangesDigest,
      manifestDigest,
    } = createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId,
      revision: 1,
      previousManifestId: null,
      previousManifestDigest: null,
      recoveryReadId: null,
      recoveryReadEvidenceDigest: null,
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      imageFingerprint: archive.fingerprint,
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: archive.size_bytes / 2_048,
      boundaryPolicyVersion: archive.boundary_policy_version,
      boundaryReportedSizeBytes: archive.boundary_reported_size_bytes,
      boundaryPublishedSizeBytes: archive.boundary_published_size_bytes,
      boundaryEvidenceDigest: boundaryDigest,
      unrecoveredSourceRanges: [],
    });
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
      `${fixtureId}-evidence-generation`,
      archive.boundary_reported_size_bytes,
      archive.detected_disc_id,
    );
    sqlite.prepare(`
      INSERT INTO archive_requests (
        id, detected_disc_id, evidence_format, status, priority,
        fulfilled_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'fulfilled', 0, 1, 1, 1)
    `).run(
      requestId,
      archive.detected_disc_id,
      DVD_RECOVERY_EVIDENCE_FORMAT,
    );
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
      archive.detected_disc_id,
      originalDiscArchiveId,
      DVD_RECOVERY_EVIDENCE_FORMAT,
      archive.boundary_published_size_bytes,
    );
    sqlite.prepare(`
      INSERT INTO dvd_archive_evidence_manifests (
        id, original_disc_archive_id, revision, evidence_format,
        image_fingerprint, sector_size_bytes, accepted_end_lba_exclusive,
        boundary_policy_version, boundary_reported_size_bytes,
        boundary_published_size_bytes, boundary_evidence_digest,
        unrecovered_source_ranges, unrecovered_source_ranges_digest,
        manifest_digest, created_at
      ) VALUES (?, ?, 1, ?, ?, 2048, ?, ?, ?, ?, ?, '[]', ?, ?, 1)
    `).run(
      manifestId,
      originalDiscArchiveId,
      DVD_RECOVERY_EVIDENCE_FORMAT,
      archive.fingerprint,
      archive.size_bytes / 2048,
      archive.boundary_policy_version,
      archive.boundary_reported_size_bytes,
      archive.boundary_published_size_bytes,
      boundaryDigest,
      sourceRangesDigest,
      manifestDigest,
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
      originalDiscArchiveId,
      jobId,
      DVD_RECOVERY_EVIDENCE_FORMAT,
      archive.boundary_policy_version,
      archive.boundary_reported_size_bytes,
      archive.boundary_published_size_bytes,
      boundaryDigest,
      archive.size_bytes / 2048,
      manifestId,
      manifestDigest,
    );
  } finally {
    sqlite.close();
  }
}

export function seedCatalogReviewForReadFixture(
  current: ReturnType<typeof createOperatorWorkflowFixture>,
  options: {
    predecessorOutcome?: "completed" | "running" | "failed_cleanup_pending";
    validatedOutputContents?: string;
  } = {},
) {
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  try {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/synthetic-disc",
      isPresent: true,
    });
    const contentId = `sha256:${"a".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "EXAMPLE_FILM_2020",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 5_400,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/example-film.iso",
      fingerprint: contentId,
    });
    const previousItem = access.catalog.createMediaItem({ kind: "movie", title: "Previous Film" });
    const correctedItem = access.catalog.createMediaItem({ kind: "movie", title: "Corrected Film" });
    const previousSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: previousItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "synthetic-review-profile",
      displayName: "Synthetic review profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });
    access.encodeJobs.enqueue({
      discSelectionId: previousSelection.id,
      encodingProfileId: profile.id,
      outputPath: join(current.mediaLibraryPath, "previous-film.mkv"),
    });
    const claim = access.encodeJobs.claimNext("synthetic-review-worker");
    if (!claim) throw new Error("Expected synthetic Encode Job claim");
    const runningClaim = options.predecessorOutcome === "running"
      ? claim
      : undefined;
    const partialCleanupClaim =
      options.predecessorOutcome === "failed_cleanup_pending"
        ? access.encodeJobs.registerPartialCleanup(claim)
        : undefined;
    let predecessor;
    if (options.predecessorOutcome === "running") {
      predecessor = claim;
    } else if (options.predecessorOutcome === "failed_cleanup_pending") {
      predecessor = access.encodeJobs.fail(claim, "Synthetic predecessor failure");
    } else if (options.validatedOutputContents === undefined) {
      predecessor = access.encodeJobs.complete(claim);
    } else {
      writeFileSync(claim.outputPath, options.validatedOutputContents);
      const cleanup = access.encodeJobs.registerPartialCleanup(claim, {
        publicationPending: true,
      });
      const publication = access.encodeJobs.beginPublicationMutation(
        claim,
        cleanup,
      );
      predecessor = access.encodeJobs.completePublishedClaim(
        claim,
        publication,
        () => true,
        {
          publishedOutputValidation: {
            result: "passed",
            filesystemIdentity: encodeOutputFilesystemIdentity(
              lstatSync(claim.outputPath),
            ),
            completeness: "complete",
          },
        },
      );
      access.encodeJobs.completePartialCleanup(publication);
    }
    const correction = access.catalog.correctDiscSelection(previousSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
      reason: "Correct the synthetic mapping.",
    });
    return {
      archive,
      previousSelection,
      correctedSelection: correction.discSelection,
      predecessor,
      runningClaim,
      partialCleanupClaim,
    };
  } finally {
    access.close();
  }
}

export function seedRearchiveCatalogReviewFixture(
  current: ReturnType<typeof createOperatorWorkflowFixture>,
) {
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  try {
    return seedRearchiveReviewFixtureForTest(access, {
      fixtureId: "operator-rearchive-review",
      mutationKey: "00000000-0000-4000-8000-000000000548",
      sourceArchivePath: join(
        current.originalsLibraryPath,
        "rearchive-cli-source.iso",
      ),
      targetArchivePath: join(
        current.originalsLibraryPath,
        "rearchive-cli-target.iso",
      ),
      volumeLabel: "SYNTHETIC_REARCHIVE_CLI",
      mediaItemTitle: "Synthetic re-archive feature",
      integrityPolicyVersion: "dvd-recovery-v1",
    });
  } finally {
    access.close();
  }
}
