import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";
import type {
  DiscSelectionSourceIdentityInput,
  DiscSelectionKind,
  MediaItemKind,
} from "@rip-dvd/data-access";
import { MEDIA_ITEM_KINDS } from "@rip-dvd/data-access/catalog-kinds";

import type {
  CatalogReviewDiscSelectionInput,
  CatalogReviewMediaItemInput,
} from "../lib/catalog-review-command";

export const mediaItemKinds = MEDIA_ITEM_KINDS;
export type { DiscSelectionKind, MediaItemKind };

export interface CatalogReviewMediaItem {
  id: string;
  parentId: string | null;
  kind: MediaItemKind;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface CatalogReviewDiscSelection {
  id: string;
  mediaItemId: string;
  sourceIdentity: DiscSelectionSourceIdentityInput;
  label: string | null;
}

export interface CatalogReviewDto {
  catalogRevision: string;
  archive: {
    id: string;
    discLabel: string;
    discKind: string;
    archiveFormat: string;
    archivedAt: string;
    catalogReviewedAt: string | null;
  };
  reviewStatus: "needs_review" | "reviewed";
  rawScan: { titles: DvdTitle[] };
  mediaItems: CatalogReviewMediaItem[];
  mediaItemsPage: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasNext: boolean;
    itemIds: string[];
  };
  discSelections: CatalogReviewDiscSelection[];
  discSelectionsPage: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export type CatalogReviewLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; review: CatalogReviewDto };

export type SaveMediaItemInput = CatalogReviewMediaItemInput & {
  id?: string;
};

export type CreateDiscSelectionInput = CatalogReviewDiscSelectionInput & {
  replacesDiscSelectionId?: string;
};
