import type { DiscSelectionSourceIdentityInput, MediaItemKind, TmdbIdentity } from "@rip-dvd/data-access";

export interface CatalogReviewMediaItemInput {
  parentId?: string | null;
  kind: MediaItemKind;
  title: string;
  year?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  tmdbIdentity?: TmdbIdentity;
}

export interface CatalogReviewProposedDiscSelectionInput {
  sourceIdentity: DiscSelectionSourceIdentityInput;
  label?: string;
}

export type CatalogReviewMappingTarget =
  | {
    choice: "create_new";
    mediaItem: CatalogReviewMediaItemInput;
  }
  | {
    choice: "use_existing";
    mediaItemId: string;
    tmdbIdentity?: TmdbIdentity;
  };

export type CatalogReviewEpisodicTvShowTarget =
  | {
    choice: "create_new";
    title: string;
    year?: number | null;
    tmdbIdentity?: TmdbIdentity;
  }
  | {
    choice: "use_existing";
    mediaItemId: string;
    tmdbIdentity?: TmdbIdentity;
  };

export type CatalogReviewEpisodicSeasonTarget =
  | {
    choice: "create_new";
    title: string;
    seasonNumber: number;
  }
  | {
    choice: "use_existing";
    mediaItemId: string;
  };
