import {
  assertDvdSourceSampleManifestProjection,
  RecordNotFoundError,
  StaleDvdDiscVerificationError,
  type ArchiveRecoveryId,
  type DataAccess,
  type DiscInspectionId,
  type DvdSourceSampleManifest,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

function visibleVerification(
  verification: NonNullable<ReturnType<
    DataAccess["dvdDiscVerifications"]["findLatestForRecovery"]
  >>,
  current: boolean,
) {
  const {
    claimToken: _claimToken,
    ...visible
  } = verification;
  return {
    ...visible,
    current,
    claimedAt: verification.claimedAt?.toISOString() ?? null,
    startedAt: verification.startedAt?.toISOString() ?? null,
    completedAt: verification.completedAt?.toISOString() ?? null,
    createdAt: verification.createdAt.toISOString(),
    updatedAt: verification.updatedAt.toISOString(),
  };
}

function authoritativeSourceSampleManifest(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  published: DvdSourceSampleManifest | null,
): DvdSourceSampleManifest | null {
  const projected = access.catalog.findDvdSourceSampleManifest(archiveId);
  assertDvdSourceSampleManifestProjection(published, projected);
  return published;
}

export async function inspectDvdDiscVerification(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const recovery = access.catalog.findArchiveRecoveryById(archiveRecoveryId);
  if (recovery === null) {
    throw new RecordNotFoundError("archive recovery", archiveRecoveryId);
  }
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [recovery.originalDiscArchiveId],
  })[0];
  if (archive === undefined) {
    throw new RecordNotFoundError(
      "original disc archive",
      recovery.originalDiscArchiveId,
    );
  }
  const sourceDisc = access.catalog.listDetectedDiscs(undefined, {
    ids: [archive.detectedDiscId],
  })[0];
  if (sourceDisc === undefined) {
    throw new RecordNotFoundError("detected disc", archive.detectedDiscId);
  }
  const inspectAtCheckpoint = (checkpoint: {
    revision: number;
    digest: string;
  } | null, sourceSampleManifest: DvdSourceSampleManifest | null) => {
    const header = access.catalog.findDvdArchiveEvidenceHeader(archive.id);
    const currentInspections = access.discInspections.list({
      currentOnly: true,
    }).filter((inspection) =>
      inspection.status === "completed" &&
      inspection.detectedDiscId !== null
    );
    const sourceDriveInspection = currentInspections.find((inspection) =>
      inspection.opticalDriveId === sourceDisc.opticalDriveId
    );
    const currentInspection = sourceDriveInspection ??
      (currentInspections.length === 1 ? currentInspections[0]! : null);
    const latest = access.dvdDiscVerifications.findLatestForRecovery(
      recovery.id,
    );
    const latestInspection = latest === null
      ? null
      : access.discInspections.list({ ids: [latest.discInspectionId] })[0] ??
        null;
    const latestCurrent = latest !== null &&
      latestInspection !== null &&
      latestInspection.isCurrent &&
      latestInspection.status === "completed" &&
      latestInspection.detectedDiscId === latest.detectedDiscId &&
      latestInspection.mediaGeneration === latest.mediaGeneration &&
      checkpoint !== null &&
      checkpoint.revision === latest.checkpointRevision &&
      checkpoint.digest === latest.checkpointDigest &&
      header !== null &&
      header.currentManifestRevision === checkpoint.revision &&
      header.currentManifestDigest === checkpoint.digest;
    const blockingReasons: Array<{ code: string; message: string }> = [];
    if (recovery.status === "completed") {
      blockingReasons.push({
        code: "RECOVERY_COMPLETED",
        message: "Archive Recovery has no unresolved source to verify.",
      });
    }
    if (currentInspection === null && currentInspections.length === 0) {
      blockingReasons.push({
        code: "DISC_ABSENT",
        message: "No current completed disc insertion is available.",
      });
    } else if (currentInspection === null) {
      blockingReasons.push({
        code: "DISC_INSERTION_AMBIGUOUS",
        message: "More than one current disc insertion is available.",
      });
    }
    if (
      checkpoint === null ||
      header === null ||
      header.currentManifestRevision !== checkpoint.revision ||
      header.currentManifestDigest !== checkpoint.digest
    ) {
      blockingReasons.push({
        code: "UNSUPPORTED_EVIDENCE_FORMAT",
        message: "The archive has no current DVD recovery checkpoint.",
      });
    }
    const active = latest?.status === "queued" ||
      latest?.status === "running";
    if (active) {
      blockingReasons.push({
        code: "DISC_VERIFICATION_ACTIVE",
        message: "A disc verification is already active.",
      });
    }
    return {
      archiveRecovery: recovery,
      checkpoint,
      insertion: currentInspection === null ? null : {
        discInspectionId: currentInspection.id,
        detectedDiscId: currentInspection.detectedDiscId,
        mediaGeneration: currentInspection.mediaGeneration,
      },
      insertionCandidates: currentInspections.map((inspection) => ({
        discInspectionId: inspection.id,
        detectedDiscId: inspection.detectedDiscId,
        mediaGeneration: inspection.mediaGeneration,
      })),
      sourceSampleManifest,
      verification: latest === null
        ? null
        : visibleVerification(latest, latestCurrent),
      writeAuthority: latestCurrent && latest?.status === "completed" &&
          latest.outcome === "match"
        ? { available: true, blockingReasons: [] }
        : {
            available: false,
            blockingReasons: latest === null
              ? [{
                  code: "DISC_VERIFICATION_REQUIRED",
                  message: "The current insertion has not been verified.",
                }]
              : !latestCurrent
                ? [{
                    code: "DISC_VERIFICATION_STALE",
                    message: "The verification does not match the current insertion and checkpoint.",
                  }]
                : [{
                    code: latest.outcome === "mismatch"
                      ? "DISC_VERIFICATION_MISMATCH"
                      : "DISC_VERIFICATION_INCONCLUSIVE",
                    message: latest.outcome === "mismatch"
                      ? "Automatic verification found conflicting source evidence."
                      : "Automatic verification did not establish a sampled match.",
                  }],
          },
      action: {
        name: "verify-disc",
        available: blockingReasons.length === 0,
        blockingReasons,
        expectedInputs: currentInspection === null || checkpoint === null
          ? null
          : {
              archiveRecoveryId: recovery.id,
              discInspectionId: currentInspection.id,
              checkpointRevision: checkpoint.revision,
              checkpointDigest: checkpoint.digest,
            },
      },
    };
  };
  const inspected = await access.withDvdCurrentCheckpoint(
    archive.id,
    archiveImageOwnership,
    async ({ checkpoint }) => inspectAtCheckpoint({
      revision: checkpoint.currentManifestRevision,
      digest: checkpoint.currentManifestDigest,
    }, authoritativeSourceSampleManifest(
      access,
      archive.id,
      checkpoint.initialEvidence.sourceSampleManifest ?? null,
    )),
  );
  return inspected ?? inspectAtCheckpoint(null, null);
}

export async function requestDvdDiscVerification(
  access: DataAccess,
  input: {
    mutationKey: string;
    archiveRecoveryId: ArchiveRecoveryId;
    discInspectionId: DiscInspectionId;
    checkpointRevision: number;
    checkpointDigest: string;
  },
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const recovery = access.catalog.findArchiveRecoveryById(
    input.archiveRecoveryId,
  );
  if (recovery === null) {
    throw new RecordNotFoundError("archive recovery", input.archiveRecoveryId);
  }
  const submitted = await access.withDvdCurrentCheckpoint(
    recovery.originalDiscArchiveId,
    archiveImageOwnership,
    async ({ checkpoint, assertOwned }) => {
      if (
        checkpoint.currentManifestRevision !== input.checkpointRevision ||
        checkpoint.currentManifestDigest !== input.checkpointDigest
      ) {
        throw new StaleDvdDiscVerificationError(
          "DISC_CHECKPOINT_CHANGED",
        );
      }
      authoritativeSourceSampleManifest(
        access,
        recovery.originalDiscArchiveId,
        checkpoint.initialEvidence.sourceSampleManifest ?? null,
      );
      assertOwned();
      const verification = access.dvdDiscVerifications.submit(input);
      assertOwned();
      return {
        verification: visibleVerification(verification, true),
      };
    },
  );
  if (submitted === null) {
    throw new StaleDvdDiscVerificationError(
      "DISC_CHECKPOINT_CHANGED",
    );
  }
  return submitted;
}
