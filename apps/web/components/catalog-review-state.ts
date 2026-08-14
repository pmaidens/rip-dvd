"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompletedCatalogReviewOutcome } from "@rip-dvd/data-access";

import type { CatalogReviewCommand } from "../lib/catalog-review-command";
import type { CatalogReviewReplacementEncodeInput } from "../lib/catalog-review-command";
import type {
  CatalogReviewDto,
  CatalogReviewLoadState,
  CreateDiscSelectionInput,
  CreateEpisodicMappingProposalInput,
  CreateMappingProposalInput,
  DiscSelectionKind,
  EpisodicMappingProposal,
  MappingProposal,
  SaveMediaItemInput,
  UpdateDiscSelectionInput,
} from "./catalog-review-model";

type CatalogReviewFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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
  discSelectionOffset: number,
  fetcher: CatalogReviewFetch = fetch,
  correctionHistoryOffset = 0,
  replacementOffset = 0,
  replacementProfileOffset = 0,
): Promise<CatalogReviewDto> {
  const query = new URLSearchParams({
    selectionOffset: String(discSelectionOffset),
    correctionOffset: String(correctionHistoryOffset),
  });
  if (replacementOffset > 0) {
    query.set("replacementOffset", String(replacementOffset));
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

export async function mutateCatalogReview(
  archiveId: string,
  command: CatalogReviewCommand,
  fetcher: CatalogReviewFetch = fetch,
): Promise<{ message: string | null }> {
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    },
  );
  if (!response.ok) {
    let message = "Catalog review mutation failed";
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error.trim() !== ""
      ) {
        message = body.error.trim().slice(0, 512);
      }
    } catch {
      // Keep the bounded generic message for non-JSON error responses.
    }
    throw new Error(message);
  }
  try {
    const body: unknown = await response.json();
    return {
      message:
        typeof body === "object" && body !== null && "message" in body &&
          typeof body.message === "string" && body.message.trim() !== ""
          ? body.message.trim().slice(0, 512)
          : null,
    };
  } catch {
    return { message: null };
  }
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

  const load = useCallback(async () => {
    const request = requestScope.current?.begin(archiveId);
    if (request === null || request === undefined) {
      return;
    }
    try {
      const review = await requestCatalogReview(
        archiveId,
        discSelectionOffset,
        fetch,
        correctionHistoryOffset,
        replacementOffset,
        replacementProfileOffset,
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
    complete = false,
    afterMutation?: () => void,
    errorTarget: "editor" | "mapping_proposal" = "editor",
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
    try {
      const result = await mutateCatalogReview(archiveId, command);
      setMutationNotice(result.message);
      setEditingMediaItemId(null);
      afterMutation?.();
      if (complete) {
        onCompleted();
      } else {
        await load();
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Catalog review mutation failed";
      if (complete) {
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
    void mutate({
      action: "create_mapping_proposal",
      catalogRevision: state.review.catalogRevision,
      ...input,
    }, false, () => {
      setMappingProposalError(null);
      setActiveMappingProposal(null);
    }, "mapping_proposal");
  }

  function createEpisodicMappingProposal(
    input: CreateEpisodicMappingProposalInput,
  ) {
    if (state.status !== "loaded") {
      return;
    }
    void mutate({
      action: "create_episodic_mapping_proposal",
      catalogRevision: state.review.catalogRevision,
      ...input,
    }, false, () => {
      setMappingProposalError(null);
      setActiveEpisodicMappingProposal(null);
    }, "mapping_proposal");
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
        void mutate({
          action: "complete_review",
          catalogRevision: state.review.catalogRevision,
          outcome,
          replacementEncodes,
        }, true);
      }
    },
  };
}
