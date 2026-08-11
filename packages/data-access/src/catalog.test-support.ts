import type {
  DataAccess,
  OriginalDiscArchiveId,
} from "./types.js";

export function completeCatalogReview(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
) {
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [archiveId],
  })[0]!;
  return access.catalog.completeCatalogReview(archiveId, archive.updatedAt);
}
