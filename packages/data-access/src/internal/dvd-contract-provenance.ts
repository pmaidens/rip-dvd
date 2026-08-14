import { isDeepStrictEqual } from "node:util";

import { deserializeDiscSelectionSourceIdentity } from "../disc-selection-source-identity.js";
import { decodeDvdTitleMap } from "../dvd-scan.js";
import { DomainInvariantError } from "../errors.js";
import type {
  DetectedDiscStatus,
  DiscKind,
  DiscSelection,
} from "../types.js";
import { createArchivedDvdSelectionValidator } from "./archived-dvd-selection-validator.js";
import { discSelections } from "./schema.js";

export function normalizeDetectedDiscScan({
  discKind,
  fingerprint,
  scanData,
}: {
  discKind: DiscKind;
  fingerprint: string;
  scanData: unknown | undefined;
}): unknown | undefined {
  if (discKind !== "dvd" || scanData === undefined) {
    return scanData;
  }
  const decoded = decodeDvdTitleMap(scanData);
  if (decoded === null) {
    throw new DomainInvariantError(
      "DVD scan data must match the versioned title-map contract",
    );
  }
  if (decoded.contentId !== fingerprint) {
    throw new DomainInvariantError(
      "DVD scan fingerprint must match its Detected Disc fingerprint",
    );
  }
  return decoded;
}

interface ExistingDetectedDiscEvidence {
  id: string;
  discKind: DiscKind;
  scanData: unknown;
  status: DetectedDiscStatus;
  volumeLabel: string | null;
}

interface ContentIdentityArchiveProvenance {
  detectedDiscId: string;
  discKind: DiscKind;
}

export function evaluateDetectedDiscRediscovery({
  discKind,
  existing,
  fingerprintObservationDiscKind,
  isNewMediumObservation,
  contentIdentityArchive,
  scanData,
  volumeLabel,
}: {
  discKind: DiscKind;
  existing?: ExistingDetectedDiscEvidence;
  fingerprintObservationDiscKind?: DiscKind;
  isNewMediumObservation?: boolean;
  contentIdentityArchive?: ContentIdentityArchiveProvenance;
  scanData: unknown | undefined;
  volumeLabel: string | undefined;
}): { observationChanged: boolean; statusChanged: boolean } {
  if (contentIdentityArchive && contentIdentityArchive.discKind !== discKind) {
    throw new DomainInvariantError(
      "Rediscovered disc kind must match existing archive provenance",
    );
  }
  if (
    fingerprintObservationDiscKind !== undefined &&
    fingerprintObservationDiscKind !== discKind
  ) {
    throw new DomainInvariantError(
      "Rediscovered disc kind must match existing fingerprint identity",
    );
  }
  if (
    contentIdentityArchive !== undefined &&
    existing !== undefined &&
    contentIdentityArchive.detectedDiscId === existing.id &&
    scanData !== undefined &&
    !isDeepStrictEqual(existing.scanData, scanData)
  ) {
    throw new DomainInvariantError(
      "Rediscovery cannot change archived scan evidence",
    );
  }
  if (
    contentIdentityArchive === undefined &&
    existing?.status === "approved" &&
    (existing.discKind !== discKind ||
      (scanData !== undefined &&
        !isDeepStrictEqual(existing.scanData, scanData)))
  ) {
    throw new DomainInvariantError(
      "Rediscovery cannot change reviewed data for an approved Detected Disc",
    );
  }

  return {
    observationChanged:
      existing === undefined ||
      isNewMediumObservation === true ||
      existing.discKind !== discKind ||
      existing.volumeLabel !== (volumeLabel ?? null) ||
      !isDeepStrictEqual(existing.scanData, scanData ?? null),
    statusChanged:
      contentIdentityArchive !== undefined && existing?.status !== "archived",
  };
}

export function toDiscSelection(
  row: typeof discSelections.$inferSelect,
): DiscSelection {
  return {
    id: row.id,
    originalDiscArchiveId: row.originalDiscArchiveId,
    mediaItemId: row.mediaItemId,
    sourceIdentity: deserializeDiscSelectionSourceIdentity({
      kind: row.kind,
      titleNumber: row.titleNumber,
      chapterStart: row.chapterStart,
      chapterEnd: row.chapterEnd,
    }),
    label: row.label,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function requiresLegacyDiscSelectionRepair(
  row: typeof discSelections.$inferSelect,
  validator: ReturnType<typeof createArchivedDvdSelectionValidator>,
): boolean {
  try {
    validator.validate(
      toDiscSelection(row).sourceIdentity,
      { persistedSourceKey: row.sourceKey },
    );
    return false;
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      return true;
    }
    throw error;
  }
}
