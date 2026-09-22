"use client";

import type { CatalogReviewCommand } from "../lib/catalog-review-command";

type CatalogReviewFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscSelectionChangePreview {
  state: "available";
  catalogRevision: string;
  previewToken: string;
  affectedEncodeJobs: readonly { id: string; status: string }[];
  consequences: {
    currentSelection: string;
    createsReplacementSelection: boolean;
    requestsEncodeJobCancellation: readonly string[];
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
  let pending = readPendingCatalogReviewMutation(identity, storage);
  if (isConsequentialSelectionCommand(command)) {
    pending = await prepareDiscSelectionMutation(
      archiveId, command, fetcher, options, identity, storage, pending,
    );
    if (pending === undefined) return { message: null, cancelled: true };
  }
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pending?.preview ? {
        ...command,
        mutationKey: pending.mutationKey,
        expectedCatalogRevision: pending.preview.catalogRevision,
        previewToken: pending.preview.previewToken,
        acknowledge: true,
      } : { ...command, ...(proposalMutationKey ? { mutationKey: proposalMutationKey } : {}) }),
    },
  );
  if (!response.ok) {
    if (!ambiguousMutationResponse(response.status)) {
      deletePendingCatalogReviewMutation(identity, storage);
    }
    throw await catalogReviewMutationError(response);
  }
  if (proposalIdentity !== null) pendingProposalKeys.delete(proposalIdentity);
  deletePendingCatalogReviewMutation(identity, storage);
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

type ConsequentialSelectionCommand = Extract<CatalogReviewCommand, {
  action: "repair_disc_selection" | "correct_disc_selection" | "delete_disc_selection";
}>;

function isConsequentialSelectionCommand(
  command: CatalogReviewCommand,
): command is ConsequentialSelectionCommand {
  return command.action === "repair_disc_selection" ||
    command.action === "correct_disc_selection" ||
    command.action === "delete_disc_selection";
}

async function prepareDiscSelectionMutation(
  archiveId: string,
  command: ConsequentialSelectionCommand,
  fetcher: CatalogReviewFetch,
  options: CatalogReviewMutationOptions,
  identity: string,
  storage: CatalogReviewMutationStorage | null,
  saved: PendingCatalogReviewMutation | undefined,
): Promise<PendingCatalogReviewMutation | undefined> {
  const pending = saved ?? { mutationKey: crypto.randomUUID() };
  writePendingCatalogReviewMutation(identity, pending, storage);
  if (pending.preview === undefined) {
    try {
      pending.preview = await requestDiscSelectionPreview(archiveId, command, fetcher);
    } catch (error) {
      deletePendingCatalogReviewMutation(identity, storage);
      throw error;
    }
    writePendingCatalogReviewMutation(identity, pending, storage);
  }
  if (pending.acknowledged === true) return pending;
  if (options.confirmDiscSelectionPreview === undefined) {
    throw new Error("Disc Selection preview acknowledgement is required");
  }
  if (!await options.confirmDiscSelectionPreview(pending.preview)) {
    deletePendingCatalogReviewMutation(identity, storage);
    return undefined;
  }
  pending.acknowledged = true;
  writePendingCatalogReviewMutation(identity, pending, storage);
  return pending;
}

async function requestDiscSelectionPreview(
  archiveId: string,
  command: ConsequentialSelectionCommand,
  fetcher: CatalogReviewFetch,
): Promise<DiscSelectionChangePreview> {
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...command, preview: true }),
    },
  );
  if (!response.ok) throw await catalogReviewMutationError(response);
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "state" in body &&
      body.state === "blocked") {
    throw new Error("reason" in body && typeof body.reason === "string"
      ? body.reason.slice(0, 512) : "Disc Selection change is blocked");
  }
  const preview = availableDiscSelectionPreview(body);
  if (preview === null) throw new Error("Catalog review mutation failed");
  return preview;
}

const pendingCatalogReviewMutations = new Map<string, PendingCatalogReviewMutation>();
const PENDING_CATALOG_REVIEW_MUTATION_PREFIX = "rip-dvd.catalog-review-mutation.v1:";

function browserMutationStorage(): CatalogReviewMutationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function pendingCatalogReviewMutationKey(identity: string): string {
  return `${PENDING_CATALOG_REVIEW_MUTATION_PREFIX}${identity}`;
}

function readPendingCatalogReviewMutation(
  identity: string,
  storage: CatalogReviewMutationStorage | null,
): PendingCatalogReviewMutation | undefined {
  if (storage === null) return pendingCatalogReviewMutations.get(identity);
  try {
    const saved = storage.getItem(pendingCatalogReviewMutationKey(identity));
    if (saved === null) return pendingCatalogReviewMutations.get(identity);
    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed !== "object" || parsed === null ||
        !("mutationKey" in parsed) || typeof parsed.mutationKey !== "string") return undefined;
    const preview = "preview" in parsed && parsed.preview !== undefined
      ? availableDiscSelectionPreview(parsed.preview) : undefined;
    if ("preview" in parsed && parsed.preview !== undefined && preview === null) return undefined;
    return {
      mutationKey: parsed.mutationKey,
      ...(preview ? { preview } : {}),
      ...("acknowledged" in parsed && parsed.acknowledged === true
        ? { acknowledged: true } : {}),
    };
  } catch {
    return pendingCatalogReviewMutations.get(identity);
  }
}

function writePendingCatalogReviewMutation(
  identity: string,
  pending: PendingCatalogReviewMutation,
  storage: CatalogReviewMutationStorage | null,
): void {
  if (storage === null) {
    pendingCatalogReviewMutations.set(identity, pending);
    return;
  }
  try {
    storage.setItem(pendingCatalogReviewMutationKey(identity), JSON.stringify(pending));
    pendingCatalogReviewMutations.delete(identity);
  } catch {
    // Keep the invocation in memory when browser storage is unavailable.
    pendingCatalogReviewMutations.set(identity, pending);
  }
}

function deletePendingCatalogReviewMutation(
  identity: string,
  storage: CatalogReviewMutationStorage | null,
): void {
  pendingCatalogReviewMutations.delete(identity);
  if (storage === null) return;
  try {
    storage.removeItem(pendingCatalogReviewMutationKey(identity));
  } catch {
    // A failed storage cleanup leaves the durable replay identity available.
  }
}

function availableDiscSelectionPreview(value: unknown): DiscSelectionChangePreview | null {
  if (typeof value !== "object" || value === null || !("state" in value) ||
      value.state !== "available" || !("catalogRevision" in value) ||
      typeof value.catalogRevision !== "string" || !("previewToken" in value) ||
      typeof value.previewToken !== "string" || !("affectedEncodeJobs" in value) ||
      !Array.isArray(value.affectedEncodeJobs) || !("consequences" in value) ||
      typeof value.consequences !== "object" || value.consequences === null) return null;
  const affectedEncodeJobs = value.affectedEncodeJobs;
  if (!affectedEncodeJobs.every((job) => typeof job === "object" && job !== null &&
      "id" in job && typeof job.id === "string" && "status" in job &&
      typeof job.status === "string")) return null;
  const consequences = value.consequences;
  if (!("currentSelection" in consequences) || typeof consequences.currentSelection !== "string" ||
      !("createsReplacementSelection" in consequences) ||
      typeof consequences.createsReplacementSelection !== "boolean" ||
      !("requestsEncodeJobCancellation" in consequences) ||
      !Array.isArray(consequences.requestsEncodeJobCancellation) ||
      !consequences.requestsEncodeJobCancellation.every((id) => typeof id === "string") ||
      !("preservesEncodeJobHistory" in consequences) ||
      typeof consequences.preservesEncodeJobHistory !== "boolean" ||
      !("reopensCatalogReview" in consequences) ||
      typeof consequences.reopensCatalogReview !== "boolean") return null;
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
  return [
    "Review this Disc Selection change before applying it.",
    `Current selection will be ${preview.consequences.currentSelection}.`,
    preview.consequences.createsReplacementSelection
      ? "A replacement Disc Selection will be created."
      : "No replacement Disc Selection will be created.",
    affectedJobs,
    cancellations,
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
