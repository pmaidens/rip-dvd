import { describe, expectTypeOf, it } from "vitest";

import type {
  ArchiveJobId,
  BoundedListPolicy,
  DataAccess,
  DetectedDiscId,
  DiscSelectionId,
  EncodeJobId,
  EncodingProfileId,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
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
      access.archiveJobs.enqueue({
        // @ts-expect-error Optical Drive IDs cannot identify Detected Discs.
        detectedDiscId: driveId,
      });
      // @ts-expect-error Chapter selections require a title and range.
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archiveId,
        mediaItemId,
        kind: "dvd_chapters",
        label: "missing coordinates",
      });
    }
  });

  it("makes bounded list policies mutually exclusive", () => {
    const newest = {
      mode: "newest",
      limit: 20,
    } satisfies BoundedListPolicy;
    const activity = {
      mode: "active-and-history",
      activeLimit: 100,
      historyLimit: 20,
    } satisfies BoundedListPolicy;

    expectTypeOf(newest).toMatchTypeOf<BoundedListPolicy>();
    expectTypeOf(activity).toMatchTypeOf<BoundedListPolicy>();

    if (false) {
      const mixed: BoundedListPolicy = {
        mode: "newest",
        limit: 20,
        // @ts-expect-error A newest policy cannot specify activity bounds.
        activeLimit: 100,
        historyLimit: 20,
      };
      // @ts-expect-error Both activity bounds are required together.
      const incomplete: BoundedListPolicy = {
        mode: "active-and-history",
        historyLimit: 20,
      };
      void mixed;
      void incomplete;
    }
  });
});
