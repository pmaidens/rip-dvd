"use client";

import { createMutationKey } from "../lib/mutation-key";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompletedCatalogReviewOutcome } from "@rip-dvd/data-access";

import type { AutomaticCatalogProposal } from "../lib/catalog-automation";
import type { CatalogReviewCommand } from "../lib/catalog-review-command";
import type { CatalogReviewReplacementEncodeInput } from "../lib/catalog-review-command";
import {
  discSelectionPreviewConfirmation,
  mutateCatalogReview,
  rearchiveAcceptancePreviewConfirmation,
  resumePendingCatalogReviewMutation,
} from "./catalog-review-mutation";
import type {
  CatalogReviewDto,
  CatalogReviewRearchiveProposal,
  CatalogReviewLoadState,
  CreateDiscSelectionInput,
  CreateEpisodicMappingProposalInput,
  CreateMappingProposalInput,
  DiscSelectionKind,
  EpisodicMappingProposal,
  MappingProposal,
  SaveMediaItemInput,
  SaveRearchiveMappingProposalInput,
  UpdateDiscSelectionInput,
} from "./catalog-review-model";

export {
  mutateCatalogReview,
  resumePendingCatalogReviewMutation,
} from "./catalog-review-mutation";

type CatalogReviewFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface CatalogReviewPageCoordinates {
  discSelectionOffset: number;
  correctionHistoryOffset?: number;
  correctionEncodeHistoryOffset?: number;
  correctionRetainedOutputHistoryOffset?: number;
  replacementOffset?: number;
  replacementProfileOffset?: number;
}

function createCatalogReviewRequestScope(initialArchiveId: string) {
  let activeArchiveId: string | null = initialArchiveId;
  let currentRequest = Symbol("catalog-review-request");
  return {
    activate(archiveId: string) {
      if (activeArchiveId !== archiveId) {
        activeArchiveId = archiveId;
        currentRequest = Symbol("catalog-review-request");
      }
    },
    begin(archiveId: string): symbol | null {
      if (activeArchiveId !== archiveId) {
        return null;
      }
      currentRequest = Symbol("catalog-review-request");
      return currentRequest;
    },
    invalidate(archiveId: string) {
      if (activeArchiveId === archiveId) {
        currentRequest = Symbol("catalog-review-request");
      }
    },
    deactivate(archiveId: string) {
      if (activeArchiveId === archiveId) {
        activeArchiveId = null;
        currentRequest = Symbol("catalog-review-request");
      }
    },
    isCurrent(archiveId: string, request: symbol): boolean {
      return activeArchiveId === archiveId && currentRequest === request;
    },
  };
}

export async function requestCatalogReview(
  archiveId: string,
  coordinates: CatalogReviewPageCoordinates,
  fetcher: CatalogReviewFetch = fetch,
): Promise<CatalogReviewDto> {
  const {
    discSelectionOffset,
    correctionHistoryOffset = 0,
    correctionEncodeHistoryOffset = 0,
    correctionRetainedOutputHistoryOffset = 0,
    replacementOffset = 0,
    replacementProfileOffset = 0,
  } = coordinates;
  const query = new URLSearchParams({
    selectionOffset: String(discSelectionOffset),
    correctionOffset: String(correctionHistoryOffset),
  });
  if (replacementOffset > 0) {
    query.set("replacementOffset", String(replacementOffset));
  }
  if (correctionEncodeHistoryOffset > 0) {
    query.set("correctionJobOffset", String(correctionEncodeHistoryOffset));
  }
  if (correctionRetainedOutputHistoryOffset > 0) {
    query.set(
      "correctionOutputOffset",
      String(correctionRetainedOutputHistoryOffset),
    );
  }
  if (replacementProfileOffset > 0) {
    query.set("replacementProfileOffset", String(replacementProfileOffset));
  }
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}?${query.toString()}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("Catalog review request failed");
  }
  return response.json() as Promise<CatalogReviewDto>;
}

interface UseCatalogReviewStateOptions {
  archiveId: string;
  activityRevision?: string;
  onCompleted(): void;
}

export function useCatalogReviewState({
  archiveId,
  activityRevision,
  onCompleted,
}: UseCatalogReviewStateOptions) {
  const [state, setState] = useState<CatalogReviewLoadState>({
    status: "loading",
  });
  const [editingMediaItemId, setEditingMediaItemId] = useState<string | null>(
    null,
  );
  const [discSelectionOffset, setDiscSelectionOffset] = useState(0);
  const [correctionHistoryOffset, setCorrectionHistoryOffset] = useState(0);
  const [correctionEncodeHistoryOffset, setCorrectionEncodeHistoryOffset] =
    useState(0);
  const [
    correctionRetainedOutputHistoryOffset,
    setCorrectionRetainedOutputHistoryOffset,
  ] = useState(0);
  const [replacementOffset, setReplacementOffset] = useState(0);
  const [replacementProfileOffset, setReplacementProfileOffset] = useState(0);
  const [selectionKind, setSelectionKind] =
    useState<DiscSelectionKind>("main_feature");
  const [archiveOnlySelected, setArchiveOnlySelected] = useState(false);
  const [activeMappingProposal, setActiveMappingProposal] =
    useState<MappingProposal | null>(null);
  const [activeEpisodicMappingProposal, setActiveEpisodicMappingProposal] =
    useState<EpisodicMappingProposal | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [mappingProposalError, setMappingProposalError] = useState<
    string | null
  >(null);
  const requestScope = useRef<
    ReturnType<typeof createCatalogReviewRequestScope> | null
  >(null);
  requestScope.current ??= createCatalogReviewRequestScope(archiveId);
  requestScope.current.activate(archiveId);
  const observedActivityRevision = useRef(activityRevision);
  const pendingMediaItemKeys = useRef(new Map<string, {
    key: string;
    revision?: string;
  }>());

  const load = useCallback(async () => {
    const request = requestScope.current?.begin(archiveId);
    if (request === null || request === undefined) {
      return;
    }
    try {
      const recovered = await resumePendingCatalogReviewMutation(archiveId);
      if (!requestScope.current?.isCurrent(archiveId, request)) {
        return;
      }
      if (recovered !== null) {
        setMutationNotice(recovered.message);
      }
      const review = await requestCatalogReview(
        archiveId,
        {
          discSelectionOffset,
          correctionHistoryOffset,
          correctionEncodeHistoryOffset,
          correctionRetainedOutputHistoryOffset,
          replacementOffset,
          replacementProfileOffset,
        },
        fetch,
      );
      if (!requestScope.current?.isCurrent(archiveId, request)) {
        return;
      }
      setState({ status: "loaded", review });
      setRequestError(null);
    } catch {
      if (!requestScope.current?.isCurrent(archiveId, request)) {
        return;
      }
      setState({ status: "error" });
    }
  }, [
    archiveId,
    discSelectionOffset,
    correctionHistoryOffset,
    correctionEncodeHistoryOffset,
    correctionRetainedOutputHistoryOffset,
    replacementOffset,
    replacementProfileOffset,
  ]);

  useEffect(() => {
    setState((current) => current.status === "loaded"
      ? current
      : { status: "loading" });
    void load();
  }, [load]);

  useEffect(() => {
    if (
      activityRevision !== undefined &&
      observedActivityRevision.current !== activityRevision
    ) {
      observedActivityRevision.current = activityRevision;
      void load();
    }
  }, [activityRevision, load]);

  useEffect(() => {
    setActiveMappingProposal(null);
    setActiveEpisodicMappingProposal(null);
  }, [archiveId]);

  useEffect(() => setArchiveOnlySelected(false), [archiveId]);

  useEffect(() => {
    if (
      state.status === "loaded" &&
      (state.review.coverage.discSelectionCount > 0 ||
        state.review.reviewOutcome !== "needs_review")
    ) {
      setArchiveOnlySelected(false);
    }
  }, [state]);

  useEffect(
    () => () => requestScope.current?.deactivate(archiveId),
    [archiveId],
  );

  async function mutate(
    command: CatalogReviewCommand,
    {
      closeAfterMutation = false,
      afterMutation,
      errorTarget = "editor",
    }: {
      closeAfterMutation?: boolean;
      afterMutation?: () => void;
      errorTarget?: "editor" | "mapping_proposal";
    } = {},
  ) {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    setRequestError(null);
    setMutationNotice(null);
    if (errorTarget === "mapping_proposal") {
      setMappingProposalError(null);
    }
    let pendingKey: string | null = null;
    try {
      let submittedCommand: CatalogReviewCommand & {
        mutationKey?: string;
        acknowledgedRevision?: string;
      } = command;
      if (command.action === "create_media_item" ||
          command.action === "update_media_item" ||
          command.action === "delete_media_item") {
        pendingKey = `${archiveId}:${JSON.stringify(command)}`;
        let pending = pendingMediaItemKeys.current.get(pendingKey);
        if (!pending) {
          pending = { key: createMutationKey() };
          pendingMediaItemKeys.current.set(pendingKey, pending);
        }
        if (command.action !== "create_media_item" && pending.revision === undefined) {
          const changes = command.action === "update_media_item"
            ? `&changes=${encodeURIComponent(JSON.stringify(command.changes))}` : "";
          const preview = await fetch(
            `/api/media-items/${encodeURIComponent(command.mediaItemId)}?action=${
              command.action === "delete_media_item" ? "delete" : "update"
            }${changes}`,
            { cache: "no-store" },
          );
          if (!preview.ok) throw new Error("Media Item preview failed");
          const details = await preview.json() as {
            revision: string;
            consequence: string;
            maintenance: { referencedArchiveCount: number };
            impact?: { affectedArchiveCount: number };
            availability: { state: string; reason: string | null };
            requiresAcknowledgement: boolean;
          };
          if (details.availability.state !== "available") {
            throw new Error(details.availability.reason ?? "Media Item change is unavailable");
          }
          if (details.requiresAcknowledgement) {
            if (!window.confirm(
              `${details.consequence} Affects ${details.impact?.affectedArchiveCount ?? details.maintenance.referencedArchiveCount} archive(s). Continue?`,
            )) return;
            pending.revision = details.revision;
          }
        }
        submittedCommand = {
          ...command,
          mutationKey: pending.key,
          ...(pending.revision ? { acknowledgedRevision: pending.revision } : {}),
        };
      }
      const result = await mutateCatalogReview(
        archiveId,
        submittedCommand,
        fetch,
        {
          confirmDiscSelectionPreview: (preview) =>
            window.confirm(discSelectionPreviewConfirmation(preview)),
          confirmCatalogReviewCompletionPreview: (preview) =>
            window.confirm(
              `Complete this Catalog Review as ${
                preview.outcome === "archive_only"
                  ? "Archive only"
                  : "reviewed with selections"
              } and queue ${
                preview.consequences.replacementEncodes.length
              } corrected replacement encode(s), omitting ${
                preview.consequences.omittedReplacementEncodeCount
              } eligible replacement(s), and release ${
                preview.consequences
                  .failedOutputReservationReleaseEncodeJobIds.length
              } failed output reservation(s)?`,
            ),
          confirmRearchiveAcceptancePreview: (preview) =>
            window.confirm(
              rearchiveAcceptancePreviewConfirmation(preview),
            ),
        },
      );
      if (result.cancelled) return;
      if (pendingKey !== null) pendingMediaItemKeys.current.delete(pendingKey);
      setMutationNotice(result.message);
      setEditingMediaItemId(null);
      afterMutation?.();
      if (closeAfterMutation) {
        onCompleted();
      } else {
        await load();
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Catalog review mutation failed";
      if (pendingKey !== null && message.includes("changed; preview")) {
        pendingMediaItemKeys.current.delete(pendingKey);
      }
      if (closeAfterMutation) {
        await load();
      }
      if (errorTarget === "mapping_proposal") {
        setMappingProposalError(message);
      } else {
        setRequestError(message);
      }
    } finally {
      setIsSaving(false);
    }
  }

  function changeEditingMediaItem(id: string | null) {
    if (editingMediaItemId === id) {
      return;
    }
    setEditingMediaItemId(id);
  }

  function changeDiscSelectionOffset(offset: number) {
    if (discSelectionOffset === offset) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setDiscSelectionOffset(offset);
  }

  function changeCorrectionHistoryOffset(offset: number) {
    if (correctionHistoryOffset === offset) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setCorrectionHistoryOffset(offset);
  }

  function changeCorrectionEncodeHistoryOffset(offset: number) {
    if (correctionEncodeHistoryOffset === offset) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setCorrectionEncodeHistoryOffset(offset);
  }

  function changeCorrectionRetainedOutputHistoryOffset(offset: number) {
    if (correctionRetainedOutputHistoryOffset === offset) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setCorrectionRetainedOutputHistoryOffset(offset);
  }

  function changeReplacementOffset(offset: number) {
    if (replacementOffset === offset) return;
    requestScope.current?.invalidate(archiveId);
    setReplacementOffset(offset);
  }

  function changeReplacementProfileOffset(offset: number) {
    if (replacementProfileOffset === offset) return;
    requestScope.current?.invalidate(archiveId);
    setReplacementProfileOffset(offset);
  }

  function saveMediaItem(input: SaveMediaItemInput) {
    const { id, ...values } = input;
    void mutate(
      id
        ? { action: "update_media_item", mediaItemId: id, changes: values }
        : { action: "create_media_item", mediaItem: values },
    );
  }

  function createDiscSelection(selection: CreateDiscSelectionInput) {
    const { replacesDiscSelectionId, correctionReason, ...values } = selection;
    if (!replacesDiscSelectionId) {
      void mutate({ action: "create_disc_selection", selection: values });
      return;
    }
    if (state.status !== "loaded") return;
    const target = state.review.discSelections.find(
      (candidate) => candidate.id === replacesDiscSelectionId,
    );
    if (!target) return;
    if (
      target.actionAvailability.state === "locked_provenance" ||
      target.actionAvailability.state === "correction_lineage"
    ) {
      void mutate({
        action: "correct_disc_selection",
        discSelectionId: replacesDiscSelectionId,
        catalogRevision: state.review.catalogRevision,
        ...(correctionReason ? { correctionReason } : {}),
        selection: values,
      });
      return;
    }
    if (target.actionAvailability.state === "needs_repair") {
      void mutate({
        action: "repair_disc_selection",
        discSelectionId: replacesDiscSelectionId,
        selection: values,
      });
    }
  }

  function updateDiscSelection(
    discSelectionId: string,
    changes: UpdateDiscSelectionInput,
  ) {
    void mutate({
      action: "update_disc_selection",
      discSelectionId,
      changes,
    });
  }

  function createMappingProposal(input: CreateMappingProposalInput) {
    if (state.status !== "loaded") {
      return;
    }
    void mutate(
      {
        action: "create_mapping_proposal",
        catalogRevision: state.review.catalogRevision,
        ...input,
      },
      {
        afterMutation: () => {
          setMappingProposalError(null);
          setActiveMappingProposal(null);
        },
        errorTarget: "mapping_proposal",
      },
    );
  }

  function createEpisodicMappingProposal(
    input: CreateEpisodicMappingProposalInput,
  ) {
    if (state.status !== "loaded") {
      return;
    }
    void mutate(
      {
        action: "create_episodic_mapping_proposal",
        catalogRevision: state.review.catalogRevision,
        ...input,
      },
      {
        afterMutation: () => {
          setMappingProposalError(null);
          setActiveEpisodicMappingProposal(null);
        },
        errorTarget: "mapping_proposal",
      },
    );
  }

  function acceptAutomaticCatalogProposal(proposal: AutomaticCatalogProposal) {
    if (state.status !== "loaded") return;
    const command: CatalogReviewCommand = proposal.kind === "movie"
      ? {
        action: "create_mapping_proposal",
        catalogRevision: state.review.catalogRevision,
        ...proposal.input,
        completeReview: true,
      }
      : {
        action: "create_episodic_mapping_proposal",
        catalogRevision: state.review.catalogRevision,
        ...proposal.input,
        completeReview: true,
      };
    void mutate(command, { closeAfterMutation: true });
  }

  async function previewRearchiveMappingProposal(
    input: SaveRearchiveMappingProposalInput,
  ): Promise<CatalogReviewRearchiveProposal> {
    if (state.status !== "loaded" || state.review.rearchiveProposal === undefined) {
      throw new Error("Re-archive Mapping Proposal is unavailable");
    }
    const current = state.review.rearchiveProposal;
    const response = await fetch(
      `/api/catalog-reviews/${encodeURIComponent(archiveId)}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "preview_rearchive_mapping_proposal",
          catalogRevision: current.catalogRevision,
          sourceCatalogRevision: current.sourceCatalogRevision,
          mappings: input.mappings,
        }),
      },
    );
    if (!response.ok) {
      let message = "Re-archive Mapping Proposal preview failed";
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim() !== "") {
          message = body.error.trim().slice(0, 512);
        }
      } catch {
        // Keep the bounded generic message for a non-JSON response.
      }
      throw new Error(message);
    }
    return response.json() as Promise<CatalogReviewRearchiveProposal>;
  }

  function saveRearchiveMappingProposal(
    input: SaveRearchiveMappingProposalInput,
  ) {
    if (state.status !== "loaded" || state.review.rearchiveProposal === undefined) {
      return;
    }
    const current = state.review.rearchiveProposal;
    void mutate({
      action: "save_rearchive_mapping_proposal",
      catalogRevision: current.catalogRevision,
      sourceCatalogRevision: current.sourceCatalogRevision,
      mappings: input.mappings,
    });
  }

  function acceptRearchive(
    replacementEncodes: CatalogReviewReplacementEncodeInput[],
  ) {
    if (
      state.status !== "loaded" ||
      state.review.rearchiveProposal === undefined
    ) {
      return;
    }
    const current = state.review.rearchiveProposal;
    void mutate(
      {
        action: "accept_rearchive",
        catalogRevision: current.catalogRevision,
        sourceCatalogRevision: current.sourceCatalogRevision,
        replacementEncodes,
      },
      { closeAfterMutation: true },
    );
  }

  return {
    state,
    activeMappingProposal,
    activeEpisodicMappingProposal,
    archiveOnlySelected,
    editingMediaItemId,
    isSaving,
    requestError,
    mutationNotice,
    mappingProposalError,
    selectionKind,
    retry: () => void load(),
    editMediaItem: (id: string) => changeEditingMediaItem(id),
    cancelEdit: () => changeEditingMediaItem(null),
    changeDiscSelectionOffset,
    changeCorrectionHistoryOffset,
    changeCorrectionEncodeHistoryOffset,
    changeCorrectionRetainedOutputHistoryOffset,
    changeReplacementOffset,
    changeReplacementProfileOffset,
    changeSelectionKind: setSelectionKind,
    changeArchiveOnlySelected: setArchiveOnlySelected,
    startMappingProposal: (proposal: MappingProposal) => {
      setRequestError(null);
      setMappingProposalError(null);
      setActiveEpisodicMappingProposal(null);
      setActiveMappingProposal(proposal);
    },
    cancelMappingProposal: () => {
      setRequestError(null);
      setMappingProposalError(null);
      setActiveMappingProposal(null);
    },
    startEpisodicMappingProposal: (proposal: EpisodicMappingProposal) => {
      setRequestError(null);
      setMappingProposalError(null);
      setActiveMappingProposal(null);
      setActiveEpisodicMappingProposal(proposal);
    },
    cancelEpisodicMappingProposal: () => {
      setRequestError(null);
      setMappingProposalError(null);
      setActiveEpisodicMappingProposal(null);
    },
    createEpisodicMappingProposal,
    createMappingProposal,
    acceptAutomaticCatalogProposal,
    previewRearchiveMappingProposal,
    saveRearchiveMappingProposal,
    acceptRearchive,
    saveMediaItem,
    deleteMediaItem: (mediaItemId: string) =>
      void mutate({ action: "delete_media_item", mediaItemId }),
    createDiscSelection,
    updateDiscSelection,
    deleteDiscSelection: (discSelectionId: string) =>
      void mutate({ action: "delete_disc_selection", discSelectionId }),
    completeReview: (
      outcome: CompletedCatalogReviewOutcome,
      replacementEncodes: CatalogReviewReplacementEncodeInput[],
    ) => {
      if (state.status === "loaded") {
        void mutate(
          {
            action: "complete_review",
            catalogRevision: state.review.catalogRevision,
            outcome,
            replacementEncodes,
          },
          { closeAfterMutation: true },
        );
      }
    },
  };
}
