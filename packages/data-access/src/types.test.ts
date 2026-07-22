import { describe, expectTypeOf, it } from "vitest";

import type {
  ArchiveJobId,
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

describe("data-access domain identifiers", () => {
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
      const archiveClaim = undefined as unknown as RunningArchiveJob;

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
        sourceKey: "dvd:chapters",
        kind: "dvd_chapters",
        label: "missing coordinates",
      });
      // @ts-expect-error Archive completion always requires its resulting archive.
      access.archiveJobs.complete(archiveClaim);
    }
  });
});
