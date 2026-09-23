import type {
  DataAccess,
  FilesystemVerificationTarget,
} from "@rip-dvd/data-access";

export const FILESYSTEM_VERIFICATION_INVENTORY_PAGE_LIMIT = 20;

export interface FilesystemVerificationInventoryInput {
  offset: number;
  target: FilesystemVerificationTarget;
}

export function readFilesystemVerificationInventory(
  access: DataAccess,
  input: FilesystemVerificationInventoryInput,
) {
  if (
    (input.target !== "original_disc_archive" &&
      input.target !== "encode_job_output") ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0
  ) {
    throw new RangeError("Invalid filesystem verification inventory.");
  }
  const limit = FILESYSTEM_VERIFICATION_INVENTORY_PAGE_LIMIT;
  if (input.target === "original_disc_archive") {
    const records = access.filesystemVerification.listOriginalDiscArchives({
      limit: limit + 1,
      offset: input.offset,
    });
    const pageRecords = records.slice(-limit);
    const discs = pageRecords.length === 0
      ? []
      : access.catalog.listDetectedDiscs(undefined, {
          ids: [
            ...new Set(pageRecords.map((record) => record.detectedDiscId)),
          ],
        });
    const discsById = new Map(discs.map((disc) => [disc.id, disc]));
    return {
      inventory: {
        target: input.target,
        items: pageRecords.map((record) => ({
          target: input.target,
          id: record.id,
          discLabel:
            discsById.get(record.detectedDiscId)?.volumeLabel ??
            "Unlabeled disc",
          discKind: record.discKind,
          archiveFormat: record.archiveFormat,
          archivedAt: record.archivedAt.toISOString(),
          status: record.verificationStatus,
          message: record.verificationMessage,
          verifiedAt: record.verifiedAt?.toISOString() ?? null,
        })),
        page: {
          offset: input.offset,
          limit,
          hasPrevious: input.offset > 0,
          hasNext: records.length > limit,
        },
      },
    };
  }

  const records = access.filesystemVerification.listEncodeJobOutputs({
    limit: limit + 1,
    offset: input.offset,
  });
  const pageRecords = records.slice(-limit);
  const selections = pageRecords.length === 0
    ? []
    : access.catalog.listDiscSelections({
        ids: [
          ...new Set(pageRecords.map((record) => record.discSelectionId)),
        ],
      });
  const mediaItems = selections.length === 0
    ? []
    : access.catalog.listMediaItems({
        ids: [
          ...new Set(selections.map((selection) => selection.mediaItemId)),
        ],
      });
  const profiles = pageRecords.length === 0
    ? []
    : access.encodingProfiles.list({
        ids: [
          ...new Set(pageRecords.map((record) => record.encodingProfileId)),
        ],
      });
  const selectionsById = new Map(
    selections.map((selection) => [selection.id, selection]),
  );
  const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  return {
    inventory: {
      target: input.target,
      items: pageRecords.map((record) => {
        const selection = selectionsById.get(record.discSelectionId);
        const mediaItem = selection
          ? mediaItemsById.get(selection.mediaItemId)
          : undefined;
        const profile = profilesById.get(record.encodingProfileId);
        return {
          target: input.target,
          id: record.id,
          mediaTitle: mediaItem?.title ?? "Unknown Media Item",
          mediaYear: mediaItem?.year ?? null,
          encodingProfileName: profile
            ? `${profile.displayName} · Version ${profile.version}`
            : "Unknown Encoding Profile",
          jobStatus: record.status,
          updatedAt: record.updatedAt.toISOString(),
          status: record.verificationStatus,
          message: record.verificationMessage,
          verifiedAt: record.verifiedAt?.toISOString() ?? null,
        };
      }),
      page: {
        offset: input.offset,
        limit,
        hasPrevious: input.offset > 0,
        hasNext: records.length > limit,
      },
    },
  };
}
