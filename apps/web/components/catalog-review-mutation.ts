"use client";

import {
  discSelectionCommandRequiresPreview,
  type CatalogReviewCommand,
  type ConsequentialDiscSelectionCommand,
} from "../lib/catalog-review-command";

type CatalogReviewFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function postCatalogReview(
  archiveId: string,
  body: unknown,
  fetcher: CatalogReviewFetch,
): Promise<Response> {
  return fetcher(`/api/catalog-reviews/${encodeURIComponent(archiveId)}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface DiscSelectionChangePreview {
  state: "available";
  action: ConsequentialDiscSelectionCommand["action"];
  catalogRevision: string;
  previewToken: string;
  affectedEncodeJobs: readonly { id: string; status: string }[];
  outputReservationReleaseJobs: readonly { id: string; status: "failed" }[];
  consequences: {
    currentSelection: string;
    createsReplacementSelection: boolean;
    requestsEncodeJobCancellation: readonly string[];
    releasesOutputReservations: readonly string[];
    preservesEncodeJobHistory: boolean;
    reopensCatalogReview: boolean;
  };
}

interface CatalogReviewMutationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CatalogReviewMutationOptions {
  confirmDiscSelectionPreview?: (
    preview: DiscSelectionChangePreview,
  ) => boolean | Promise<boolean>;
  storage?: CatalogReviewMutationStorage | null;
}

interface PendingCatalogReviewMutation {
  archiveId: string;
  command: ConsequentialDiscSelectionCommand;
  identity: string;
  mutationKey: string;
  preview?: DiscSelectionChangePreview;
  acknowledged?: boolean;
}

const pendingProposalKeys = new Map<string, string>();

export async function mutateCatalogReview(
  archiveId: string,
  command: CatalogReviewCommand,
  fetcher: CatalogReviewFetch = fetch,
  options: CatalogReviewMutationOptions = {},
): Promise<{ message: string | null; cancelled?: true }> {
  const identity = JSON.stringify([archiveId, command]);
  const proposalIdentity = command.action === "create_mapping_proposal" ||
      command.action === "create_episodic_mapping_proposal"
    ? JSON.stringify({ archiveId, command }) : null;
  let proposalMutationKey: string | undefined;
  if (proposalIdentity !== null) {
    proposalMutationKey = pendingProposalKeys.get(proposalIdentity) ?? crypto.randomUUID();
    pendingProposalKeys.set(proposalIdentity, proposalMutationKey);
  }
  const storage = options.storage === undefined
    ? browserMutationStorage() : options.storage;
  let pending: PendingCatalogReviewMutation | undefined;
  if (discSelectionCommandRequiresPreview(command)) {
    pending = readPendingCatalogReviewMutation(archiveId, storage);
    if (pending?.identity !== identity) {
      if (pending?.acknowledged === true) {
        throw new Error(
          "A previously acknowledged Disc Selection change must be recovered before another change",
        );
      }
      deletePendingCatalogReviewMutation(archiveId, storage);
      pending = undefined;
    }
    pending = await prepareDiscSelectionMutation(
      archiveId, command, fetcher, options, identity, storage, pending,
    );
    if (pending === undefined) return { message: null, cancelled: true };
  }
  const response = pending?.preview
    ? await applyPendingCatalogReviewMutation(pending, fetcher)
    : await postCatalogReview(archiveId, {
      ...command,
      ...(proposalMutationKey ? { mutationKey: proposalMutationKey } : {}),
    }, fetcher);
  if (!response.ok) {
    if (pending !== undefined && !ambiguousMutationResponse(response.status)) {
      deletePendingCatalogReviewMutation(archiveId, storage);
    }
    throw await catalogReviewMutationError(response);
  }
  if (proposalIdentity !== null) pendingProposalKeys.delete(proposalIdentity);
  if (pending !== undefined) deletePendingCatalogReviewMutation(archiveId, storage);
  return { message: await catalogReviewMutationMessage(response) };
}

async function prepareDiscSelectionMutation(
  archiveId: string,
  command: ConsequentialDiscSelectionCommand,
  fetcher: CatalogReviewFetch,
  options: CatalogReviewMutationOptions,
  identity: string,
  storage: CatalogReviewMutationStorage | null,
  saved: PendingCatalogReviewMutation | undefined,
): Promise<PendingCatalogReviewMutation | undefined> {
  const pending = saved ?? {
    archiveId,
    command,
    identity,
    mutationKey: crypto.randomUUID(),
  };
  writePendingCatalogReviewMutation(archiveId, pending, storage);
  if (pending.preview === undefined) {
    try {
      pending.preview = await requestDiscSelectionPreview(archiveId, command, fetcher);
    } catch (error) {
      deletePendingCatalogReviewMutation(archiveId, storage);
      throw error;
    }
    writePendingCatalogReviewMutation(archiveId, pending, storage);
  }
  if (pending.acknowledged === true) return pending;
  if (options.confirmDiscSelectionPreview === undefined) {
    throw new Error("Disc Selection preview acknowledgement is required");
  }
  if (!await options.confirmDiscSelectionPreview(pending.preview)) {
    deletePendingCatalogReviewMutation(archiveId, storage);
    return undefined;
  }
  pending.acknowledged = true;
  writePendingCatalogReviewMutation(archiveId, pending, storage);
  return pending;
}

export async function resumePendingCatalogReviewMutation(
  archiveId: string,
  fetcher: CatalogReviewFetch = fetch,
  options: Pick<CatalogReviewMutationOptions, "storage"> = {},
): Promise<{ message: string | null } | null> {
  const storage = options.storage === undefined
    ? browserMutationStorage() : options.storage;
  const pending = readPendingCatalogReviewMutation(archiveId, storage);
  if (pending?.acknowledged !== true || pending.preview === undefined) return null;
  const response = await applyPendingCatalogReviewMutation(pending, fetcher);
  if (!response.ok) {
    if (!ambiguousMutationResponse(response.status)) {
      deletePendingCatalogReviewMutation(archiveId, storage);
    }
    throw await catalogReviewMutationError(response);
  }
  deletePendingCatalogReviewMutation(archiveId, storage);
  return { message: await catalogReviewMutationMessage(response) };
}

function applyPendingCatalogReviewMutation(
  pending: PendingCatalogReviewMutation,
  fetcher: CatalogReviewFetch,
): Promise<Response> {
  const preview = pending.preview;
  if (preview === undefined) {
    throw new Error("Disc Selection preview acknowledgement is required");
  }
  return postCatalogReview(pending.archiveId, {
    ...pending.command,
    mutationKey: pending.mutationKey,
    expectedCatalogRevision: preview.catalogRevision,
    previewToken: preview.previewToken,
    acknowledge: true,
  }, fetcher);
}

async function requestDiscSelectionPreview(
  archiveId: string,
  command: ConsequentialDiscSelectionCommand,
  fetcher: CatalogReviewFetch,
): Promise<DiscSelectionChangePreview> {
  const response = await postCatalogReview(archiveId, { ...command, preview: true }, fetcher);
  if (!response.ok) throw await catalogReviewMutationError(response);
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "state" in body &&
      body.state === "blocked") {
    throw new Error("reason" in body && typeof body.reason === "string"
      ? body.reason.slice(0, 512) : "Disc Selection change is blocked");
  }
  const preview = availableDiscSelectionPreview(body, command.action);
  if (preview === null) throw new Error("Catalog review mutation failed");
  return preview;
}

const pendingCatalogReviewMutations = new Map<string, PendingCatalogReviewMutation>();
const PENDING_CATALOG_REVIEW_MUTATION_PREFIX = "rip-dvd.catalog-review-mutation.v2:";

function browserMutationStorage(): CatalogReviewMutationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function pendingCatalogReviewMutationKey(archiveId: string): string {
  return `${PENDING_CATALOG_REVIEW_MUTATION_PREFIX}${encodeURIComponent(archiveId)}`;
}

function readPendingCatalogReviewMutation(
  archiveId: string,
  storage: CatalogReviewMutationStorage | null,
): PendingCatalogReviewMutation | undefined {
  if (storage === null) return pendingCatalogReviewMutations.get(archiveId);
  try {
    const saved = storage.getItem(pendingCatalogReviewMutationKey(archiveId));
    if (saved === null) return pendingCatalogReviewMutations.get(archiveId);
    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed !== "object" || parsed === null ||
        !("archiveId" in parsed) || parsed.archiveId !== archiveId ||
        !("identity" in parsed) || typeof parsed.identity !== "string" ||
        !("command" in parsed) || !("mutationKey" in parsed) ||
        typeof parsed.mutationKey !== "string") return undefined;
    const command = storedConsequentialSelectionCommand(parsed.command);
    if (command === null || parsed.identity !== JSON.stringify([archiveId, command])) return undefined;
    const preview = "preview" in parsed && parsed.preview !== undefined
      ? availableDiscSelectionPreview(parsed.preview, command.action) : undefined;
    if ("preview" in parsed && parsed.preview !== undefined && preview === null) return undefined;
    return {
      archiveId,
      command,
      identity: parsed.identity,
      mutationKey: parsed.mutationKey,
      ...(preview ? { preview } : {}),
      ...("acknowledged" in parsed && parsed.acknowledged === true
        ? { acknowledged: true } : {}),
    };
  } catch {
    return pendingCatalogReviewMutations.get(archiveId);
  }
}

function storedConsequentialSelectionCommand(
  value: unknown,
): ConsequentialDiscSelectionCommand | null {
  if (typeof value !== "object" || value === null || !("action" in value) ||
      !("discSelectionId" in value) || typeof value.discSelectionId !== "string") return null;
  const command = value as CatalogReviewCommand;
  return discSelectionCommandRequiresPreview(command) ? command : null;
}

function writePendingCatalogReviewMutation(
  archiveId: string,
  pending: PendingCatalogReviewMutation,
  storage: CatalogReviewMutationStorage | null,
): void {
  if (storage === null) {
    pendingCatalogReviewMutations.set(archiveId, pending);
    return;
  }
  try {
    storage.setItem(pendingCatalogReviewMutationKey(archiveId), JSON.stringify(pending));
    pendingCatalogReviewMutations.delete(archiveId);
  } catch {
    // Keep the invocation in memory when browser storage is unavailable.
    pendingCatalogReviewMutations.set(archiveId, pending);
  }
}

function deletePendingCatalogReviewMutation(
  archiveId: string,
  storage: CatalogReviewMutationStorage | null,
): void {
  pendingCatalogReviewMutations.delete(archiveId);
  if (storage === null) return;
  try {
    storage.removeItem(pendingCatalogReviewMutationKey(archiveId));
  } catch {
    // A failed storage cleanup leaves the durable replay identity available.
  }
}

function availableDiscSelectionPreview(
  value: unknown,
  expectedAction: ConsequentialDiscSelectionCommand["action"],
): DiscSelectionChangePreview | null {
  if (typeof value !== "object" || value === null || !("state" in value) ||
      value.state !== "available" || !("action" in value) || value.action !== expectedAction ||
      !("catalogRevision" in value) ||
      typeof value.catalogRevision !== "string" || !("previewToken" in value) ||
      typeof value.previewToken !== "string" || !("affectedEncodeJobs" in value) ||
      !Array.isArray(value.affectedEncodeJobs) ||
      !("outputReservationReleaseJobs" in value) ||
      !Array.isArray(value.outputReservationReleaseJobs) || !("consequences" in value) ||
      typeof value.consequences !== "object" || value.consequences === null) return null;
  const affectedEncodeJobs = value.affectedEncodeJobs;
  if (!affectedEncodeJobs.every((job) => typeof job === "object" && job !== null &&
      "id" in job && typeof job.id === "string" && "status" in job &&
      typeof job.status === "string")) return null;
  const outputReservationReleaseJobs = value.outputReservationReleaseJobs;
  if (!outputReservationReleaseJobs.every((job) =>
    typeof job === "object" && job !== null && "id" in job &&
    typeof job.id === "string" && "status" in job && job.status === "failed")) return null;
  const consequences = value.consequences;
  if (!("currentSelection" in consequences) || typeof consequences.currentSelection !== "string" ||
      !("createsReplacementSelection" in consequences) ||
      typeof consequences.createsReplacementSelection !== "boolean" ||
      !("requestsEncodeJobCancellation" in consequences) ||
      !Array.isArray(consequences.requestsEncodeJobCancellation) ||
      !consequences.requestsEncodeJobCancellation.every((id) => typeof id === "string") ||
      !("releasesOutputReservations" in consequences) ||
      !Array.isArray(consequences.releasesOutputReservations) ||
      !consequences.releasesOutputReservations.every((id) => typeof id === "string") ||
      !("preservesEncodeJobHistory" in consequences) ||
      typeof consequences.preservesEncodeJobHistory !== "boolean" ||
      !("reopensCatalogReview" in consequences) ||
      typeof consequences.reopensCatalogReview !== "boolean") return null;
  const releasedReservationIds = expectedAction === "repair_disc_selection" ||
      expectedAction === "delete_disc_selection"
    ? outputReservationReleaseJobs.map((job) => job.id) : [];
  if (JSON.stringify(consequences.releasesOutputReservations) !==
      JSON.stringify(releasedReservationIds)) return null;
  return value as unknown as DiscSelectionChangePreview;
}

function ambiguousMutationResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function discSelectionPreviewConfirmation(preview: DiscSelectionChangePreview): string {
  const affectedJobs = preview.affectedEncodeJobs.length === 0
    ? "No active Encode Jobs are affected."
    : `Affected Encode Jobs: ${preview.affectedEncodeJobs.map(
      (job) => `${job.id} (${job.status})`,
    ).join(", ")}.`;
  const cancellations = preview.consequences.requestsEncodeJobCancellation.length === 0
    ? "No Encode Job cancellation will be requested."
    : `Cancellation will be requested for: ${
      preview.consequences.requestsEncodeJobCancellation.join(", ")}.`;
  const reservationReleases = preview.consequences.releasesOutputReservations.length === 0
    ? "No output reservations will be released."
    : `Output reservations will be released for: ${
      preview.consequences.releasesOutputReservations.join(", ")}.`;
  return [
    "Review this Disc Selection change before applying it.",
    `Current selection will be ${preview.consequences.currentSelection}.`,
    preview.consequences.createsReplacementSelection
      ? "A replacement Disc Selection will be created."
      : "No replacement Disc Selection will be created.",
    affectedJobs,
    cancellations,
    reservationReleases,
    preview.consequences.preservesEncodeJobHistory
      ? "Encode Job history will be preserved."
      : "There is no Encode Job history to preserve.",
    preview.consequences.reopensCatalogReview
      ? "Catalog review will be reopened."
      : "Catalog review will remain unchanged.",
    "Apply this exact preview?",
  ].join("\n");
}

async function catalogReviewMutationError(response: Response): Promise<Error> {
  let message = "Catalog review mutation failed";
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body &&
        typeof body.error === "string" && body.error.trim() !== "") {
      message = body.error.trim().slice(0, 512);
    }
  } catch {
    // Keep the bounded generic message for non-JSON error responses.
  }
  return new Error(message);
}

async function catalogReviewMutationMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "message" in body &&
        typeof body.message === "string" && body.message.trim() !== ""
      ? body.message.trim().slice(0, 512)
      : null;
  } catch {
    return null;
  }
}
