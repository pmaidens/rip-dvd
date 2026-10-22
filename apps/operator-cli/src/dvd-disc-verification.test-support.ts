import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalPublicationJson,
  createDvdInitialPublicationDigest,
  createDvdSourceSampleDigest,
  createDvdSourceSampleManifestDigest,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
  DVD_SOURCE_SAMPLE_SECTOR_COUNT,
  DVD_SOURCE_VERIFICATION_POLICY_VERSION,
  type DvdSourceSampleReference,
} from "@rip-dvd/data-access";
import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";

import { seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

function sampleBytes(index: number): Buffer {
  const bytes = Buffer.alloc(DVD_SOURCE_SAMPLE_BYTE_COUNT, index);
  bytes[bytes.length - 1] = index + 1;
  return bytes;
}

export async function seedDvdDiscVerificationFixture(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
) {
  const seeded = await seedCommittedArchiveEvidence(fixture, [
    { startLba: 900, sectorCount: 1, classification: "skipped_untested" },
  ]);
  const recoveryId = "synthetic-verification-recovery";
  const access = fixture.openAccess();
  access.dvdRecoveryStorage.record({
    contractVersion: "dvd-recovery-storage-preflight-v1",
    status: "supported",
    reasonCode: null,
    facts: {
      filesystemType: "synthetic-local",
      storageClass: "local",
      mutationProtection: {
        status: "verified",
        contract: "linux-rwf-atomic-v1",
        unitBytes: 4_096,
        memoryAlignmentBytes: 4_096,
      },
      journalReservationBytes: 1_048_576,
      journalPayloadBytes: 983_040,
      journalReservation: "verified",
      journalSynchronization: "verified",
      imageSynchronization: "verified",
      checkpointSynchronization: "verified",
      checkpointReplacement: "verified",
      directorySynchronization: "verified",
      crossProcessWriterExclusion: "verified",
      crossHostWriterExclusion: "not_applicable",
      disconnectionBehavior: "not_applicable",
    },
  });
  const sourceDisc = access.catalog.listDetectedDiscs(undefined, {
    ids: [seeded.archive.detectedDiscId],
  })[0]!;
  const drive = access.catalog.listOpticalDrives({
    ids: [sourceDisc.opticalDriveId],
  })[0]!;
  access.catalog.upsertOpticalDrive({
    devicePath: drive.devicePath,
    isEnabled: true,
    isPresent: true,
  });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: sourceDisc.opticalDriveId,
    mediaGeneration: "synthetic-verification-generation",
    mediaCapacityBytes: 1_024 * 2_048,
  });
  access.discInspections.record(started.claim, {
    type: "metadata",
    volumeLabel: "SYNTHETIC_VERIFICATION",
    titleCount: 1,
    chapterCount: 1,
    audioStreamCount: 1,
    subtitleStreamCount: 0,
    totalBytes: 1_024 * 2_048,
  });
  const inspection = access.discInspections.record(started.claim, {
    type: "complete",
    detectedDiscId: sourceDisc.id,
  });
  started.restoreSystemTime();
  access.close();

  const samples: DvdSourceSampleReference[] = Array.from(
    { length: DVD_SOURCE_SAMPLE_BAND_COUNT },
    (_, bandIndex) => ({
      bandIndex,
      startLba: bandIndex * 64,
      sectorCount: DVD_SOURCE_SAMPLE_SECTOR_COUNT,
      digest: createDvdSourceSampleDigest(sampleBytes(bandIndex)),
    }),
  );
  const samplePayload = {
    policyVersion: DVD_SOURCE_VERIFICATION_POLICY_VERSION,
    byteRepresentation: DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
    sourceMetadataFingerprint: seeded.archive.fingerprint,
    acceptedEndLbaExclusive: 1_024,
    checkpointRevision: 1,
    checkpointDigest: seeded.manifest.manifestDigest,
    samples,
  } as const;
  const sampleManifest = {
    ...samplePayload,
    manifestDigest: createDvdSourceSampleManifestDigest(samplePayload),
  };
  const {
    publicationDigest: _publicationDigest,
    ...publicationPayload
  } = seeded.manifest;
  const manifest = {
    ...publicationPayload,
    sourceSampleManifest: sampleManifest,
    publicationDigest: createDvdInitialPublicationDigest({
      ...publicationPayload,
      sourceSampleManifest: sampleManifest,
    }),
  };
  writeFileSync(
    join(seeded.directory, "initial-manifest.json"),
    canonicalPublicationJson(manifest),
  );
  writeFileSync(
    join(seeded.directory, "checkpoint.json"),
    canonicalPublicationJson({
      ...seeded.pointer,
      publicationDigest: manifest.publicationDigest,
    }),
  );
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare(`INSERT INTO archive_recoveries
    (id, original_disc_archive_id, status, created_at, updated_at)
    VALUES (?, ?, 'eligible', 1, 1)`).run(recoveryId, seeded.archive.id);
  sqlite.prepare(`INSERT INTO dvd_source_sample_manifests
    (original_disc_archive_id, manifest, created_at) VALUES (?, ?, 1)`)
    .run(seeded.archive.id, JSON.stringify(sampleManifest));
  sqlite.close();
  return {
    ...seeded,
    manifest,
    pointer: {
      ...seeded.pointer,
      publicationDigest: manifest.publicationDigest,
    },
    recoveryId,
    sourceDisc,
    inspection,
    sampleManifest,
  };
}
