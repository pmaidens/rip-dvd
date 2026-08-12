import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";
import type {
  CatalogReviewOutcome,
  DiscSelectionSourceIdentityInput,
  DiscSelectionKind,
  MediaItemKind,
} from "@rip-dvd/data-access";
import { MEDIA_ITEM_KINDS } from "@rip-dvd/data-access/catalog-kinds";

import type {
  CatalogReviewEpisodicEpisodeInput,
  CatalogReviewEpisodicSeasonTarget,
  CatalogReviewEpisodicTvShowTarget,
  CatalogReviewDiscSelectionInput,
  CatalogReviewMappingTarget,
  CatalogReviewMediaItemInput,
  CatalogReviewProposedDiscSelectionInput,
} from "../lib/catalog-review-command";
import type { CatalogReviewCoverage } from "../lib/catalog-review-coverage";

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
  maintenance?: MediaItemMaintenance;
}

export interface MediaItemMaintenance {
  childCount: number;
  discSelectionReferenceCount: number;
  referencedArchiveCount: number;
  otherArchiveCount: number;
  deletionAvailability:
    | { state: "available"; reason: null }
    | { state: "unavailable"; reason: string };
}

export interface CatalogReviewDiscSelection {
  id: string;
  mediaItemId: string;
  sourceIdentity: DiscSelectionSourceIdentityInput;
  label: string | null;
  actionAvailability: CatalogReviewDiscSelectionActionAvailability;
}

export type CatalogReviewDiscSelectionActionAvailability =
  | {
    state: "editable";
    availableActions: readonly ["correct", "edit_label", "remove"];
    reason: null;
    relatedEncodeJob: null;
  }
  | {
    state: "locked_provenance";
    availableActions: readonly [];
    reason: string;
    relatedEncodeJob: {
      id: string;
      status: "queued" | "running" | "completed" | "failed";
    };
  }
  | {
    state: "needs_repair";
    availableActions: readonly ["repair", "remove"] | readonly [];
    reason: string;
    relatedEncodeJob: {
      id: string;
      status: "queued" | "running";
    } | null;
  }
  | {
    state: "changes_unavailable";
    availableActions: readonly [];
    reason: string;
    relatedEncodeJob: null;
  };

export interface CatalogReviewDto {
  catalogRevision: string;
  archive: {
    id: string;
    discLabel: string;
    discKind: string;
    archiveFormat: string;
    archivedAt: string;
    catalogReviewedAt: string | null;
    catalogReviewOutcome: CatalogReviewOutcome;
  };
  reviewOutcome: CatalogReviewOutcome;
  rawScan: { titles: DvdTitle[] };
  coverage: CatalogReviewCoverage;
  mediaItems: CatalogReviewMediaItem[];
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

export type MappingProposalAction =
  | "movie"
  | "bonus_feature"
  | "trailer"
  | "chapters"
  | "other"
  | "main_feature";

export interface MappingProposal {
  action: MappingProposalAction;
  sourceIdentity: DiscSelectionSourceIdentityInput;
}

export interface CreateMappingProposalInput {
  target: CatalogReviewMappingTarget;
  discSelection: CatalogReviewProposedDiscSelectionInput;
}

export interface EpisodicMappingProposal {
  episodes: CatalogReviewEpisodicEpisodeInput[];
}

export interface CreateEpisodicMappingProposalInput {
  tvShow: CatalogReviewEpisodicTvShowTarget;
  season: CatalogReviewEpisodicSeasonTarget;
  episodes: CatalogReviewEpisodicEpisodeInput[];
}

export interface MediaItemSearchResult {
  mediaItem: CatalogReviewMediaItem;
  ancestors: CatalogReviewMediaItem[];
  maintenance: MediaItemMaintenance;
  suggestion: "exact" | "normalized" | null;
}

export interface MediaItemSearchDto {
  results: MediaItemSearchResult[];
  page: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}
