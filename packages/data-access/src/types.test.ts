import { describe, expectTypeOf, it } from "vitest";

import type {
  ArchiveJob,
  ArchiveJobStatus,
  ArchiveJobId,
  ArchiveRequestId,
  ArchiveRequestStatus,
  BoundedListPolicy,
  DataAccess,
  DetectedDiscId,
  DiscInspectionId,
  DiscInspectionStatus,
  DiscSelectionId,
  EncodeJob,
  EncodeJobId,
  EncodeJobStatus,
  EncodeOutputFilesystemIdentity,
  EncodingProfileId,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
  RunningEncodeJob,
} from "./types.js";
import type {
  LegacySidecarAccess,
  LegacySidecarDataAccess,
  LegacySidecarImportIssue,
  LegacySidecarImportIssueCode,
  LegacySidecarImportReport,
} from "./legacy-sidecars.js";
// @ts-expect-error Legacy sidecar types are migration-entrypoint only.
import type { LegacySidecarAccess as RootLegacySidecarAccess } from "./index.js";
// @ts-expect-error Legacy sidecar types are migration-entrypoint only.
import type { LegacySidecarDataAccess as RootLegacySidecarDataAccess } from "./index.js";
// @ts-expect-error Legacy sidecar types are migration-entrypoint only.
import type { LegacySidecarImportIssue as RootLegacySidecarImportIssue } from "./index.js";
// @ts-expect-error Legacy sidecar types are migration-entrypoint only.
import type { LegacySidecarImportIssueCode as RootLegacySidecarImportIssueCode } from "./index.js";
// @ts-expect-error Legacy sidecar types are migration-entrypoint only.
import type { LegacySidecarImportReport as RootLegacySidecarImportReport } from "./index.js";

describe("data-access domain identifiers", () => {
  it("exposes legacy sidecar contracts only from the migration entrypoint", () => {
    expectTypeOf<LegacySidecarImportIssueCode>().toMatchTypeOf<string>();
    expectTypeOf<LegacySidecarImportIssue>().toHaveProperty("code");
    expectTypeOf<LegacySidecarImportReport>().toHaveProperty("issues");
    expectTypeOf<LegacySidecarAccess>().toHaveProperty("importLibrary");
    expectTypeOf<LegacySidecarDataAccess>().toHaveProperty("legacySidecars");
  });

  it("keeps direct archive provenance publication migration-only", () => {
    expectTypeOf<LegacySidecarDataAccess["catalog"]>()
      .toHaveProperty("createOriginalDiscArchive");

    if (false) {
      const access = undefined as unknown as DataAccess;
      const discId = undefined as unknown as DetectedDiscId;
      // @ts-expect-error Standard callers must publish through a claimed Archive Job.
      access.catalog.createOriginalDiscArchive({
        detectedDiscId: discId,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: "/media/originals/unverified.iso",
        fingerprint: `sha256:${"a".repeat(64)}`,
        sizeBytes: 1,
      });
    }
  });

  it("keeps direct Archive Job completion migration-only", () => {
    expectTypeOf<LegacySidecarDataAccess["archiveJobs"]>()
      .toHaveProperty("complete");

    if (false) {
      const access = undefined as unknown as DataAccess;
      const archiveId = undefined as unknown as OriginalDiscArchiveId;
      const archiveClaim = undefined as unknown as RunningArchiveJob;
      // @ts-expect-error Standard callers must complete by publishing verified archive output.
      access.archiveJobs.complete(archiveClaim, archiveId);
    }
  });

  it("keeps aggregate and foreign-key identifiers opaque", () => {
    expectTypeOf<OpticalDriveId>().not.toEqualTypeOf<DetectedDiscId>();
    expectTypeOf<DetectedDiscId>().not.toEqualTypeOf<OriginalDiscArchiveId>();
    expectTypeOf<MediaItemId>().not.toEqualTypeOf<DiscSelectionId>();
    expectTypeOf<EncodingProfileId>().not.toEqualTypeOf<EncodeJobId>();
    expectTypeOf<ArchiveJobId>().not.toEqualTypeOf<EncodeJobId>();
    expectTypeOf<DiscInspectionId>().not.toEqualTypeOf<OpticalDriveId>();
    expectTypeOf<ArchiveRequestId>().not.toEqualTypeOf<DetectedDiscId>();
  });

  it("keeps inspection, request, archive-attempt, and encode statuses distinct", () => {
    expectTypeOf<DiscInspectionStatus>()
      .toEqualTypeOf<"running" | "completed" | "failed" | "aborted">();
    expectTypeOf<ArchiveRequestStatus>()
      .toEqualTypeOf<
        | "pending"
        | "running"
        | "needs_attention"
        | "cancellation_requested"
        | "fulfilled"
        | "cancelled"
      >();
    expectTypeOf<ArchiveJobStatus>()
      .toEqualTypeOf<"running" | "completed" | "failed" | "aborted">();
    expectTypeOf<EncodeJobStatus>()
      .toEqualTypeOf<
        "queued" | "running" | "completed" | "failed" | "cancelled"
      >();
  });

  it("keeps Cancelled specific to Encode Job outcomes", () => {
    expectTypeOf<ArchiveJob["status"]>().toEqualTypeOf<ArchiveJobStatus>();
    expectTypeOf<EncodeJob["status"]>().toEqualTypeOf<EncodeJobStatus>();

    if (false) {
      const access = undefined as unknown as DataAccess;
      access.encodeJobs.list(["cancelled"]);
      // @ts-expect-error Archive Jobs do not have a cancelled outcome.
      access.archiveJobs.list(["cancelled"]);
    }
  });

  it("keeps Encode output filesystem identities opaque", () => {
    expectTypeOf<EncodeOutputFilesystemIdentity>()
      .toMatchTypeOf<string>();
    expectTypeOf<string>()
      .not.toMatchTypeOf<EncodeOutputFilesystemIdentity>();

    if (false) {
      const access = undefined as unknown as DataAccess;
      const claim = undefined as unknown as RunningEncodeJob;
      // @ts-expect-error Filesystem identities must come from the Encode codec.
      access.encodeJobs.recordReplacementOutputIdentity(claim, "raw");
    }
  });

  it("rejects cross-wired identifiers at facade command boundaries", () => {
    if (false) {
      const access = undefined as unknown as DataAccess;
      const driveId = undefined as unknown as OpticalDriveId;
      const archiveId = undefined as unknown as OriginalDiscArchiveId;
      const mediaItemId = undefined as unknown as MediaItemId;

      access.catalog.registerDetectedDisc({
        // @ts-expect-error Media Item IDs cannot identify Optical Drives.
        opticalDriveId: mediaItemId,
        discKind: "dvd",
        fingerprint: "fingerprint",
      });
      access.archiveRequests.create({
        // @ts-expect-error Optical Drive IDs cannot identify Detected Discs.
        detectedDiscId: driveId,
      });
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archiveId,
        mediaItemId,
        // @ts-expect-error Chapter source identities require a title and range.
        sourceIdentity: { kind: "dvd_chapters" },
        label: "missing coordinates",
      });
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archiveId,
        mediaItemId,
        // @ts-expect-error Source coordinates cannot be passed as parallel fields.
        kind: "dvd_title",
        titleNumber: 1,
      });
    }
  });

  it("exposes only supported bounded list policies", () => {
    const activity = {
      mode: "active-and-history",
      activeLimit: 100,
      historyLimit: 20,
    } satisfies BoundedListPolicy;

    expectTypeOf(activity).toMatchTypeOf<BoundedListPolicy>();

    if (false) {
      const newest: BoundedListPolicy = {
        // @ts-expect-error The unsupported newest list policy is not public.
        mode: "newest",
        limit: 20,
      };
      // @ts-expect-error Both activity bounds are required together.
      const incomplete: BoundedListPolicy = {
        mode: "active-and-history",
        historyLimit: 20,
      };
      void newest;
      void incomplete;
    }
  });
});
