import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  mkdirSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  archiveBoundaryEvidenceFromRecord, createDvdArchiveEvidenceManifestDigests,
  createDvdArchiveRecoveryReadEvidenceDigest,
  canonicalPublicationJson, createDvdInitialPublicationDigest,
  createDvdRecoveryCheckpointPublicationDigest,
  dvdEvidenceRangesAfterRecoveryRead,
  type CommittedDvdCheckpointEvidence,
  type DvdUnrecoveredSourceRange,
} from "@rip-dvd/data-access";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { createOperatorWorkflowFixture, markArchiveWithDvdRecoveryEvidence, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

export async function seedCommittedArchiveEvidence(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  ranges: readonly DvdUnrecoveredSourceRange[] = [],
  corrected = false,
  withRecovery = false,
  imageContents?: Uint8Array,
) {
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  const archivePath = join(realpathSync(fixture.originalsLibraryPath), `${archive.id}.iso`);
  const acceptedSectors = Math.max(1024, Math.ceil((imageContents?.byteLength ?? 0) / 4096) * 2);
  const image = Buffer.alloc(acceptedSectors * 2048);
  if (imageContents && imageContents.byteLength > image.byteLength) throw new Error("Synthetic image exceeds its accepted extent");
  if (imageContents) image.set(imageContents);
  writeFileSync(archivePath, image);
  utimesSync(archivePath, 1_700_000_000, 1_700_000_000);
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
  markArchiveWithDvdRecoveryEvidence(
    fixture.databasePath,
    archive.id,
    "synthetic-committed",
    withRecovery
      ? { archiveRecovery: { id: "synthetic-committed-recovery" } }
      : {},
  );
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
  await createArchiveImageOwnership({
    authorityRootPath: fixture.originalsLibraryPath,
  }).withInitialPublicationWriter({
    archiveId: archive.id,
    imagePath: archivePath,
    originalsLibraryPath: fixture.originalsLibraryPath,
    signal: new AbortController().signal,
    async task() {},
  });
  return { archive: recorded, manifest, pointer, directory };
}

export function advanceCommittedArchiveEvidence(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  manifest: CommittedDvdCheckpointEvidence,
  options: {
    publishFilesystemCheckpoint?: boolean;
    outcome?: "failed" | "recovered";
    sourceRangeIndex?: number;
    startLba?: number;
    readId?: string;
    createdAtMs?: number;
    verificationId?: string;
    discConfirmationId?: string;
  } = {},
) {
  const startLba = options.startLba ??
    manifest.unrecoveredSourceRanges[options.sourceRangeIndex ?? 0]?.startLba;
  const sourceRange = manifest.unrecoveredSourceRanges.find((range) =>
    startLba !== undefined && startLba >= range.startLba &&
    startLba < range.startLba + range.sectorCount
  );
  if (sourceRange === undefined) {
    throw new Error("A synthetic Unrecovered Source range is required");
  }
  const outcome = options.outcome ?? "failed";
  const recoveryReadId = options.readId ??
    `synthetic-structural-recovery-read-${manifest.revision + 1}`;
  const recoveryReadInput = {
    originalDiscArchiveId: manifest.originalDiscArchiveId,
    fromManifestId: manifest.id,
    fromManifestRevision: manifest.revision,
    startLba: startLba!,
    sectorCount: 1,
    outcome,
    ...(options.verificationId === undefined
      ? {}
      : { verificationId: options.verificationId }),
    ...(options.discConfirmationId === undefined
      ? {}
      : { discConfirmationId: options.discConfirmationId }),
  };
  const recoveryReadEvidenceDigest =
    createDvdArchiveRecoveryReadEvidenceDigest(recoveryReadInput);
  const recoveryRead = {
    id: recoveryReadId,
    ...recoveryReadInput,
    evidenceDigest: recoveryReadEvidenceDigest,
  };
  const unrecoveredSourceRanges = dvdEvidenceRangesAfterRecoveryRead(
    manifest.unrecoveredSourceRanges,
    startLba!,
    outcome,
  );
  const input = {
    originalDiscArchiveId: manifest.originalDiscArchiveId,
    revision: manifest.revision + 1,
    previousManifestId: manifest.id,
    previousManifestDigest: manifest.manifestDigest,
    recoveryReadId,
    recoveryReadEvidenceDigest,
    evidenceFormat: manifest.evidenceFormat,
    imageFingerprint: manifest.imageFingerprint,
    sectorSizeBytes: manifest.sectorSizeBytes,
    acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
    boundaryPolicyVersion: manifest.boundaryPolicyVersion,
    boundaryReportedSizeBytes: manifest.boundaryReportedSizeBytes,
    boundaryPublishedSizeBytes: manifest.boundaryPublishedSizeBytes,
    boundaryEvidenceDigest: manifest.boundaryEvidenceDigest,
    unrecoveredSourceRanges,
  };
  const digestFields = {
    ...input,
    ...createDvdArchiveEvidenceManifestDigests(input),
    id: `${manifest.originalDiscArchiveId}:recovery:${input.revision}`,
  };
  const previousImage = manifest.image;
  let image = previousImage;
  let journalDigest: string | null = null;
  let protectedRanges: Array<{
    startByte: number;
    byteCount: number;
    unitBytes: number;
    beforeDigest: string;
    afterDigest: string;
  }> = [];
  if (outcome === "recovered") {
    const archivePath = join(
      realpathSync(fixture.originalsLibraryPath),
      `${manifest.originalDiscArchiveId}.iso`,
    );
    const unitBytes = 4_096;
    const sectorStartByte = startLba! * manifest.sectorSizeBytes;
    const startByte = Math.floor(sectorStartByte / unitBytes) * unitBytes;
    const sectorOffset = sectorStartByte - startByte;
    const before = Buffer.alloc(unitBytes);
    const descriptor = openSync(archivePath, "r+");
    try {
      const bytesRead = readSync(
        descriptor,
        before,
        0,
        before.length,
        startByte,
      );
      if (bytesRead !== unitBytes) {
        throw new Error("Synthetic protected range is incomplete");
      }
      const after = Buffer.from(before);
      after.fill(
        (manifest.revision % 254) + 1,
        sectorOffset,
        sectorOffset + manifest.sectorSizeBytes,
      );
      writeSync(descriptor, after, 0, after.length, startByte);
      fsyncSync(descriptor);
      protectedRanges = [{
        startByte,
        byteCount: unitBytes,
        unitBytes,
        beforeDigest: createHash("sha256").update(before).digest("hex"),
        afterDigest: createHash("sha256").update(after).digest("hex"),
      }];
    } finally {
      closeSync(descriptor);
    }
    utimesSync(
      archivePath,
      1_700_000_000 + input.revision,
      1_700_000_000 + input.revision,
    );
    const imageStat = lstatSync(archivePath, { bigint: true });
    image = {
      filesystemIdentity: `${imageStat.dev}:${imageStat.ino}`,
      mtimeNs: imageStat.mtimeNs.toString(),
    };
    journalDigest = createHash("sha256")
      .update(`synthetic-journal-${manifest.revision + 1}`)
      .digest("hex");
  }
  const publicationPayload = {
    ...digestFields,
    checkpointFormat: "dvd-recovery-batch-v1" as const,
    sourceArchiveJobId: manifest.sourceArchiveJobId,
    rootPublicationDigest: "rootPublicationDigest" in manifest
      ? manifest.rootPublicationDigest
      : manifest.publicationDigest,
    previousPublicationDigest: manifest.publicationDigest,
    image,
    previousImage,
    boundaryEvidence: manifest.boundaryEvidence,
    recoveryRead,
    journalDigest,
    protectedRanges,
  };
  const next = {
    ...publicationPayload,
    publicationDigest: createDvdRecoveryCheckpointPublicationDigest(publicationPayload),
  };
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => {
    db.prepare(`
      INSERT INTO dvd_archive_recovery_reads (
        id, original_disc_archive_id, from_manifest_id,
        from_manifest_revision, start_lba, sector_count, outcome,
        from_classification, meaningful_transition,
        verification_id, disc_confirmation_id, evidence_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.recoveryReadId,
      recoveryRead.originalDiscArchiveId,
      recoveryRead.fromManifestId,
      recoveryRead.fromManifestRevision,
      recoveryRead.startLba,
      recoveryRead.outcome,
      sourceRange.classification,
      outcome === "recovered" ||
          sourceRange.classification === "skipped_untested"
        ? 1
        : 0,
      recoveryRead.verificationId ?? null,
      recoveryRead.discConfirmationId ?? null,
      recoveryReadEvidenceDigest,
      options.createdAtMs ?? manifest.revision + 1,
    );
    db.prepare(`
      INSERT INTO dvd_archive_evidence_manifests (
        id, original_disc_archive_id, revision, previous_manifest_id,
        recovery_read_id, evidence_format, image_fingerprint,
        sector_size_bytes, accepted_end_lba_exclusive,
        boundary_policy_version, boundary_reported_size_bytes,
        boundary_published_size_bytes, boundary_evidence_digest,
        unrecovered_source_ranges, unrecovered_source_ranges_digest,
        manifest_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      next.id,
      next.originalDiscArchiveId,
      next.revision,
      next.previousManifestId,
      next.recoveryReadId,
      next.evidenceFormat,
      next.imageFingerprint,
      next.sectorSizeBytes,
      next.acceptedEndLbaExclusive,
      next.boundaryPolicyVersion,
      next.boundaryReportedSizeBytes,
      next.boundaryPublishedSizeBytes,
      next.boundaryEvidenceDigest,
      JSON.stringify(next.unrecoveredSourceRanges),
      next.unrecoveredSourceRangesDigest,
      next.manifestDigest,
      options.createdAtMs ?? manifest.revision + 1,
    );
    db.prepare(`
      UPDATE dvd_archive_evidence_headers
      SET current_manifest_id = ?, current_manifest_revision = ?,
          current_manifest_digest = ?, updated_at = 2
      WHERE original_disc_archive_id = ?
    `).run(
      next.id,
      next.revision,
      next.manifestDigest,
      next.originalDiscArchiveId,
    );
    const badSectorRanges = next.unrecoveredSourceRanges.map(
      ({ startLba, sectorCount }) => ({ startLba, sectorCount }),
    );
    const badSectorCount = badSectorRanges.reduce(
      (total, range) => total + range.sectorCount,
      0,
    );
    db.prepare(`
      UPDATE original_disc_archives
      SET integrity = ?, integrity_evidence_revision = ?,
          bad_sector_count = ?, bad_area_count = ?, bad_sector_ranges = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      badSectorCount === 0 ? "clean_read" : "incomplete_read",
      next.revision,
      badSectorCount,
      badSectorRanges.length,
      JSON.stringify(badSectorRanges),
      options.createdAtMs ?? manifest.revision + 1,
      next.originalDiscArchiveId,
    );
  });
  if (options.publishFilesystemCheckpoint) {
    const directory = join(
      fixture.originalsLibraryPath,
      ".dvd-evidence",
      manifest.originalDiscArchiveId,
    );
    const pointer = {
      originalDiscArchiveId: manifest.originalDiscArchiveId,
      currentManifestId: next.id,
      currentManifestRevision: next.revision,
      currentManifestDigest: next.manifestDigest,
      publicationDigest: next.publicationDigest,
    };
    writeFileSync(
      join(directory, `recovery-manifest-${next.revision}.json`),
      canonicalPublicationJson(next),
    );
    writeFileSync(
      join(directory, "checkpoint.json"),
      canonicalPublicationJson(pointer),
    );
  }
  return next;
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
