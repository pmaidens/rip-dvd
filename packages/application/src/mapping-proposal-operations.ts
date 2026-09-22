import {
  type DataAccess,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import type { CatalogReviewCommand } from "./catalog-review-command.js";
import { serializeDiscSelection, serializeMediaItem } from "./catalog-review-read.js";
import { catalogReviewMediaItemInput } from "./media-item-operations.js";
import { parseMutationKey } from "./mutation-key.js";

export type MappingProposalCommand = Extract<CatalogReviewCommand, {
  action: "create_mapping_proposal" | "create_episodic_mapping_proposal";
}>;

export function applyMappingProposal(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  command: MappingProposalCommand,
  mutationKey: string,
) {
  const key = parseMutationKey(mutationKey);
  if (command.action === "create_mapping_proposal") {
    const proposal = access.catalog.createMappingProposal({
      originalDiscArchiveId: archiveId,
      mutationKey: key,
      catalogRevision: new Date(command.catalogRevision),
      ...(command.target.choice === "create_new"
        ? { mediaItem: catalogReviewMediaItemInput(command.target.mediaItem) }
        : {
            existingMediaItemId: command.target.mediaItemId as MediaItemId,
            ...(command.target.tmdbIdentity === undefined ? {} : {
              existingMediaItemTmdbIdentity: command.target.tmdbIdentity,
            }),
          }),
      discSelection: command.discSelection,
      ...(command.completeReview ? { completeReview: true } : {}),
    });
    return {
      message: command.completeReview
        ? "Cataloged and review completed" : "Mapping changed; review required",
      mediaItem: serializeMediaItem(proposal.mediaItem),
      discSelection: serializeDiscSelection(proposal.discSelection),
    };
  }

  const proposal = access.catalog.createEpisodicMappingProposal({
    originalDiscArchiveId: archiveId,
    mutationKey: key,
    catalogRevision: new Date(command.catalogRevision),
    tvShow: command.tvShow.choice === "create_new"
      ? {
          choice: "create_new",
          title: command.tvShow.title,
          ...(command.tvShow.year === null || command.tvShow.year === undefined
            ? {} : { year: command.tvShow.year }),
          ...(command.tvShow.tmdbIdentity === undefined
            ? {} : { tmdbIdentity: command.tvShow.tmdbIdentity }),
        }
      : {
          choice: "use_existing",
          mediaItemId: command.tvShow.mediaItemId as MediaItemId,
          ...(command.tvShow.tmdbIdentity === undefined
            ? {} : { tmdbIdentity: command.tvShow.tmdbIdentity }),
        },
    season: command.season.choice === "create_new" ? command.season : {
      choice: "use_existing",
      mediaItemId: command.season.mediaItemId as MediaItemId,
    },
    episodes: command.episodes.map(({ existingMediaItemId, ...episode }) => ({
      ...episode,
      ...(existingMediaItemId === undefined ? {} : {
        existingMediaItemId: existingMediaItemId as MediaItemId,
      }),
    })),
    ...(command.completeReview ? { completeReview: true } : {}),
  });
  return {
    message: command.completeReview
      ? "Cataloged and review completed" : "Mapping changed; review required",
    tvShow: serializeMediaItem(proposal.tvShow),
    season: serializeMediaItem(proposal.season),
    episodes: proposal.episodes.map((episode) => ({
      mediaItem: serializeMediaItem(episode.mediaItem),
      discSelection: serializeDiscSelection(episode.discSelection),
    })),
  };
}
