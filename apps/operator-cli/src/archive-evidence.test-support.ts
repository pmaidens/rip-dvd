import { lstatSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  archiveBoundaryEvidenceFromRecord, createDvdArchiveEvidenceManifestDigests,
  canonicalPublicationJson, createDvdInitialPublicationDigest,
  type DvdUnrecoveredSourceRange,
} from "@rip-dvd/data-access";
import { createOperatorWorkflowFixture, markArchiveWithDvdRecoveryEvidence, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

export function seedCommittedArchiveEvidence(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  ranges: readonly DvdUnrecoveredSourceRange[] = [],
  corrected = false,
) {
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  const archivePath = join(realpathSync(fixture.originalsLibraryPath), `${archive.id}.iso`);
  const acceptedSectors = 1024;
  writeFileSync(archivePath, Buffer.alloc(acceptedSectors * 2048));
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare(`UPDATE original_disc_archives SET archive_path = ?, size_bytes = ?,
    boundary_policy_version = ?, boundary_reported_size_bytes = ?,
    boundary_published_size_bytes = ?, boundary_excluded_sector_count = ?,
    boundary_first_excluded_lba = ?, boundary_maximum_referenced_lba = ?,
    boundary_read_failure_classifier_version = 'scsi-read-classifier-v2',
    boundary_read_failure_scsi_status = 2, boundary_read_failure_host_status = 0,
    boundary_read_failure_driver_status = 8, boundary_read_failure_sense_response_code = 114,
    boundary_read_failure_sense_key = 5, boundary_read_failure_asc = 33, boundary_read_failure_ascq = 0
    WHERE id = ?`).run(archivePath, acceptedSectors * 2048, corrected ? "dvd-archive-boundary-v1" : "dvd-archive-boundary-v2", (corrected ? 1280 : acceptedSectors) * 2048,
      acceptedSectors * 2048, corrected ? 256 : 0, acceptedSectors, corrected ? 1023 : null, archive.id);
  sqlite.close();
  markArchiveWithDvdRecoveryEvidence(fixture.databasePath, archive.id, "synthetic-committed");
  const access = fixture.openAccess();
  const recorded = access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!;
  const header = access.catalog.findDvdArchiveEvidenceHeader(archive.id)!;
  access.close();
  const boundaryEvidence = archiveBoundaryEvidenceFromRecord(recorded)!;
  const stat = lstatSync(archivePath, { bigint: true });
  const count = ranges.reduce((n, range) => n + range.sectorCount, 0);
  const input = {
    originalDiscArchiveId: archive.id, revision: 1, previousManifestId: null,
    previousManifestDigest: null, recoveryReadId: null, recoveryReadEvidenceDigest: null,
    evidenceFormat: "dvd-recovery-evidence-v1" as const, imageFingerprint: recorded.fingerprint,
    sectorSizeBytes: 2048, acceptedEndLbaExclusive: acceptedSectors,
    boundaryPolicyVersion: boundaryEvidence.policyVersion,
    boundaryReportedSizeBytes: boundaryEvidence.reportedSizeBytes,
    boundaryPublishedSizeBytes: boundaryEvidence.publishedSizeBytes,
    boundaryEvidenceDigest: header.boundaryEvidenceDigest, unrecoveredSourceRanges: ranges,
  };
  const payload = {
    ...input, ...createDvdArchiveEvidenceManifestDigests(input), id: `${archive.id}:initial`,
    sourceArchiveJobId: header.sourceArchiveJobId,
    image: { filesystemIdentity: `${stat.dev}:${stat.ino}`, mtimeNs: stat.mtimeNs.toString() },
    boundaryEvidence,
    initialCopy: {
      copyPolicyVersion: "dvd-initial-copy-v1", declaredByteCount: boundaryEvidence.reportedSizeBytes,
      recoveredByteCount: (acceptedSectors - count) * 2048, skippedRequestCount: ranges.length,
      diagnosticsTruncated: ranges.length > 64,
      diagnostics: ranges.slice(0, 64).map(range => ({
        classification: "tolerable_medium_error", classifierVersion: "scsi-read-classifier-v2",
        requestedLba: range.startLba, requestedBlockCount: range.sectorCount, retryOrdinal: 0,
        scsiStatus: 2, hostStatus: 0, driverStatus: 8, senseResponseCode: 112,
        senseKey: 3, asc: 17, ascq: 0, informationLba: range.startLba,
      })), unrecoveredSourceRanges: ranges,
    },
    metadataDecision: corrected ? null : { policyVersion: "dvd-full-extent-metadata-v1", decision: "publishable", impact: "listed_checks_agree", observations: [], blockers: [] },
    integrity: { integrity: count ? "incomplete_read" : "clean_read", policyVersion: "dvd-recovery-evidence-v1", badSectorCount: count, badAreaCount: ranges.length, badSectorRanges: ranges.map(({ startLba, sectorCount }) => ({ startLba, sectorCount })) },
    policies: { publication: "dvd-initial-publication-v1", copy: "dvd-initial-copy-v1", metadata: corrected ? null : "dvd-full-extent-metadata-v1" },
  };
  const manifest = { ...payload, publicationDigest: createDvdInitialPublicationDigest(payload) };
  withEvidenceGuardsDisabled(fixture.databasePath, db => {
    db.prepare(`UPDATE dvd_archive_evidence_manifests SET id = ?, unrecovered_source_ranges = ?,
      unrecovered_source_ranges_digest = ?, manifest_digest = ? WHERE id = ?`).run(
      manifest.id, JSON.stringify(ranges), manifest.unrecoveredSourceRangesDigest, manifest.manifestDigest, header.currentManifestId);
    db.prepare(`UPDATE dvd_archive_evidence_headers SET current_manifest_id = ?, current_manifest_digest = ? WHERE original_disc_archive_id = ?`).run(manifest.id, manifest.manifestDigest, archive.id);
  });
  const directory = join(fixture.originalsLibraryPath, ".dvd-evidence", archive.id);
  mkdirSync(directory, { recursive: true });
  const pointer = { originalDiscArchiveId: archive.id, currentManifestId: manifest.id, currentManifestRevision: 1, currentManifestDigest: manifest.manifestDigest, publicationDigest: manifest.publicationDigest };
  writeFileSync(join(directory, "initial-manifest.json"), canonicalPublicationJson(manifest));
  writeFileSync(join(directory, "checkpoint.json"), canonicalPublicationJson(pointer));
  return { archive: recorded, manifest, pointer, directory };
}

export function withEvidenceGuardsDisabled(databasePath: string, change: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = OFF");
  const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  try {
    for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
    change(db);
  } finally {
    for (const guard of guards) db.exec(String(guard.sql));
    db.close();
  }
}
