"use client";

import type { CatalogReviewCompletionPreview } from "@rip-dvd/application";
import {
  isCatalogReviewCompletionPreviewToken,
} from "@rip-dvd/application/catalog-review-completion-preview-token";
import { isDiscSelectionPreviewToken } from "@rip-dvd/application/disc-selection-preview-token";
import { parseMutationKey } from "@rip-dvd/application/mutation-key";
import { MEDIA_ITEM_KINDS } from "@rip-dvd/data-access/catalog-kinds";

import {
  discSelectionCommandRequiresPreview,
  isDiscSelectionCommand,
  parseCatalogReviewCommand,
  type CatalogReviewCommand,
  type ConsequentialDiscSelectionCommand,
  type DiscSelectionCommand,
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

function catalogReviewMutationIdentity(
  archiveId: string,
  command: CatalogReviewCommand,
): string {
  return JSON.stringify(canonicalJsonValue([archiveId, command]));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : canonicalJsonValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        })
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
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
  confirmCatalogReviewCompletionPreview?: (
    preview: CatalogReviewCompletionPreview,
  ) => boolean | Promise<boolean>;
  storage?: CatalogReviewMutationStorage | null;
}

interface PendingCatalogReviewMutation {
  archiveId: string;
  command: DiscSelectionCommand;
  identity: string;
  mutationKey: string;
  preview?: DiscSelectionChangePreview;
  acknowledged?: boolean;
}

type CatalogReviewCompletionCommand = Extract<
  CatalogReviewCommand,
  { action: "complete_review" }
>;

interface PendingCatalogReviewCompletion {
  archiveId: string;
  command: CatalogReviewCompletionCommand;
  identity: string;
  mutationKey: string;
  preview: CatalogReviewCompletionPreview;
}

const pendingProposalKeys = new Map<string, string>();
const pendingCompletionInvocations = new Map<
  string,
  PendingCatalogReviewCompletion
>();

export async function mutateCatalogReview(
  archiveId: string,
  command: CatalogReviewCommand,
  fetcher: CatalogReviewFetch = fetch,
  options: CatalogReviewMutationOptions = {},
): Promise<{ message: string | null; cancelled?: true }> {
  const identity = catalogReviewMutationIdentity(archiveId, command);
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
  if (isDiscSelectionCommand(command)) {
    pending = readPendingCatalogReviewMutation(archiveId, storage);
    if (pending?.identity !== identity) {
      if (pending !== undefined && pendingCatalogReviewMutationIsReady(pending)) {
        throw new Error(
          "A pending Disc Selection change must be recovered before another change",
        );
      }
      deletePendingCatalogReviewMutation(archiveId, storage);
      pending = undefined;
    }
    if (discSelectionCommandRequiresPreview(command)) {
      pending = await prepareDiscSelectionMutation(
        archiveId, command, fetcher, options, identity, storage, pending,
      );
      if (pending === undefined) return { message: null, cancelled: true };
    } else {
      pending ??= {
        archiveId,
        command,
        identity,
        mutationKey: crypto.randomUUID(),
      };
      writePendingCatalogReviewMutation(archiveId, pending, storage);
    }
  }
  let completionInvocation: PendingCatalogReviewCompletion | undefined;
  if (command.action === "complete_review") {
    completionInvocation = readPendingCatalogReviewCompletion(
      archiveId,
      storage,
    );
    if (completionInvocation?.identity !== identity) {
      if (completionInvocation !== undefined) {
        throw new Error(
          "A pending Catalog Review completion must be recovered before another change",
        );
      }
      deletePendingCatalogReviewCompletion(archiveId, storage);
      completionInvocation = undefined;
    }
    if (completionInvocation === undefined) {
      const previewResponse = await postCatalogReview(
        archiveId,
        { ...command, preview: true },
        fetcher,
      );
      if (!previewResponse.ok) {
        throw await catalogReviewMutationError(previewResponse);
      }
      const preview = availableCatalogReviewCompletionPreview(
        await previewResponse.json(),
      );
      if (preview === null) {
        throw new Error("Catalog Review completion preview failed");
      }
      const confirm = options.confirmCatalogReviewCompletionPreview;
      if (confirm === undefined) {
        throw new Error(
          "Catalog Review completion preview acknowledgement is required",
        );
      }
      if (!await confirm(preview)) {
        return { message: null, cancelled: true };
      }
      completionInvocation = {
        archiveId,
        command,
        identity,
        mutationKey: crypto.randomUUID(),
        preview,
      };
      writePendingCatalogReviewCompletion(
        archiveId,
        completionInvocation,
        storage,
      );
    }
  }
  const response = pending !== undefined
    ? await applyPendingCatalogReviewMutation(pending, fetcher)
    : completionInvocation !== undefined
      ? await postCatalogReview(archiveId, {
        ...completionInvocation.command,
        mutationKey: completionInvocation.mutationKey,
        acknowledgedRevision: completionInvocation.preview.catalogRevision,
        previewToken: completionInvocation.preview.previewToken,
        acknowledge: true,
      }, fetcher)
    : await postCatalogReview(archiveId, {
      ...command,
      ...(proposalMutationKey ? { mutationKey: proposalMutationKey } : {}),
    }, fetcher);
  if (!response.ok) {
    if (completionInvocation !== undefined &&
        !ambiguousMutationResponse(response.status)) {
      deletePendingCatalogReviewCompletion(archiveId, storage);
    }
    if (pending !== undefined && !ambiguousMutationResponse(response.status)) {
      deletePendingCatalogReviewMutation(archiveId, storage);
    }
    throw await catalogReviewMutationError(response);
  }
  if (proposalIdentity !== null) pendingProposalKeys.delete(proposalIdentity);
  if (completionInvocation !== undefined) {
    deletePendingCatalogReviewCompletion(archiveId, storage);
  }
  if (pending !== undefined) deletePendingCatalogReviewMutation(archiveId, storage);
  return { message: await catalogReviewMutationMessage(response) };
}

function availableCatalogReviewCompletionPreview(
  value: unknown,
): CatalogReviewCompletionPreview | null {
  if (typeof value !== "object" || value === null ||
      !("state" in value) || value.state !== "available" ||
      !("catalogRevision" in value) || typeof value.catalogRevision !== "string" ||
      !("previewToken" in value) ||
      !isCatalogReviewCompletionPreviewToken(value.previewToken) ||
      !("consequences" in value) || typeof value.consequences !== "object" ||
      value.consequences === null) {
    return null;
  }
  return value as CatalogReviewCompletionPreview;
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
  if (pending !== undefined && pendingCatalogReviewMutationIsReady(pending)) {
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
  const completion = readPendingCatalogReviewCompletion(archiveId, storage);
  if (completion === undefined) return null;
  const resolved = await applyPendingCatalogReviewCompletion(completion, fetcher);
  if (!resolved.ok) {
    if (!ambiguousMutationResponse(resolved.status)) {
      deletePendingCatalogReviewCompletion(archiveId, storage);
    }
    throw await catalogReviewMutationError(resolved);
  }
  deletePendingCatalogReviewCompletion(archiveId, storage);
  return { message: await catalogReviewMutationMessage(resolved) };
}

function applyPendingCatalogReviewCompletion(
  pending: PendingCatalogReviewCompletion,
  fetcher: CatalogReviewFetch,
): Promise<Response> {
  return postCatalogReview(pending.archiveId, {
    ...pending.command,
    mutationKey: pending.mutationKey,
    acknowledgedRevision: pending.preview.catalogRevision,
    previewToken: pending.preview.previewToken,
    acknowledge: true,
  }, fetcher);
}

function applyPendingCatalogReviewMutation(
  pending: PendingCatalogReviewMutation,
  fetcher: CatalogReviewFetch,
): Promise<Response> {
  if (!discSelectionCommandRequiresPreview(pending.command)) {
    return postCatalogReview(pending.archiveId, {
      ...pending.command,
      mutationKey: pending.mutationKey,
    }, fetcher);
  }
  const preview = pending.preview;
  if (pending.acknowledged !== true || preview === undefined) {
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

function pendingCatalogReviewMutationIsReady(
  pending: PendingCatalogReviewMutation,
): boolean {
  return !discSelectionCommandRequiresPreview(pending.command) ||
    (pending.acknowledged === true && pending.preview !== undefined);
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
const PENDING_CATALOG_REVIEW_COMPLETION_PREFIX =
  "rip-dvd.catalog-review-completion.v1:";

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

function pendingCatalogReviewCompletionKey(archiveId: string): string {
  return `${PENDING_CATALOG_REVIEW_COMPLETION_PREFIX}${encodeURIComponent(archiveId)}`;
}

function readPendingCatalogReviewCompletion(
  archiveId: string,
  storage: CatalogReviewMutationStorage | null,
): PendingCatalogReviewCompletion | undefined {
  if (storage === null) return pendingCompletionInvocations.get(archiveId);
  let saved: string | null;
  try {
    saved = storage.getItem(pendingCatalogReviewCompletionKey(archiveId));
  } catch {
    return pendingCompletionInvocations.get(archiveId);
  }
  if (saved === null) return pendingCompletionInvocations.get(archiveId);
  const discard = () => {
    try {
      storage.removeItem(pendingCatalogReviewCompletionKey(archiveId));
    } catch {
      // Keep any in-memory recovery command when storage cleanup fails.
    }
    return pendingCompletionInvocations.get(archiveId);
  };
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    return discard();
  }
  if (typeof value !== "object" || value === null ||
      !("archiveId" in value) || value.archiveId !== archiveId ||
      !("identity" in value) || typeof value.identity !== "string" ||
      !("mutationKey" in value) || typeof value.mutationKey !== "string" ||
      !("command" in value) || !("preview" in value)) {
    return discard();
  }
  let mutationKey: string;
  try {
    mutationKey = parseMutationKey(value.mutationKey);
  } catch {
    return discard();
  }
  const parsed = parseCatalogReviewCommand(value.command, {
    mediaItemKinds: MEDIA_ITEM_KINDS,
  });
  if (!parsed.ok || parsed.command.action !== "complete_review" ||
      value.identity !== catalogReviewMutationIdentity(
        archiveId,
        parsed.command,
      )) {
    return discard();
  }
  const preview = availableCatalogReviewCompletionPreview(value.preview);
  if (preview === null || preview.archiveId !== archiveId ||
      preview.catalogRevision !== parsed.command.catalogRevision ||
      preview.outcome !== parsed.command.outcome) {
    return discard();
  }
  return {
    archiveId,
    command: parsed.command,
    identity: value.identity,
    mutationKey,
    preview,
  };
}

function writePendingCatalogReviewCompletion(
  archiveId: string,
  pending: PendingCatalogReviewCompletion,
  storage: CatalogReviewMutationStorage | null,
): void {
  if (storage === null) {
    pendingCompletionInvocations.set(archiveId, pending);
    return;
  }
  try {
    storage.setItem(
      pendingCatalogReviewCompletionKey(archiveId),
      JSON.stringify(pending),
    );
    pendingCompletionInvocations.delete(archiveId);
  } catch {
    pendingCompletionInvocations.set(archiveId, pending);
  }
}

function deletePendingCatalogReviewCompletion(
  archiveId: string,
  storage: CatalogReviewMutationStorage | null,
): void {
  pendingCompletionInvocations.delete(archiveId);
  if (storage === null) return;
  try {
    storage.removeItem(pendingCatalogReviewCompletionKey(archiveId));
  } catch {
    // A failed cleanup retains only the already committed replay command.
  }
}

function readPendingCatalogReviewMutation(
  archiveId: string,
  storage: CatalogReviewMutationStorage | null,
): PendingCatalogReviewMutation | undefined {
  if (storage === null) return pendingCatalogReviewMutations.get(archiveId);
  let saved: string | null;
  try {
    saved = storage.getItem(pendingCatalogReviewMutationKey(archiveId));
  } catch {
    return pendingCatalogReviewMutations.get(archiveId);
  }
  if (saved === null) return pendingCatalogReviewMutations.get(archiveId);
  const discardStored = () => {
    try {
      storage.removeItem(pendingCatalogReviewMutationKey(archiveId));
    } catch {
      // Ignore cleanup failure and retain any in-memory recovery command.
    }
    return pendingCatalogReviewMutations.get(archiveId);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return discardStored();
  }
  if (typeof parsed !== "object" || parsed === null ||
      !("archiveId" in parsed) || parsed.archiveId !== archiveId ||
      !("identity" in parsed) || typeof parsed.identity !== "string" ||
      !("command" in parsed) || !("mutationKey" in parsed) ||
      typeof parsed.mutationKey !== "string") return discardStored();
  let mutationKey: string;
  try {
    mutationKey = parseMutationKey(parsed.mutationKey);
  } catch {
    return discardStored();
  }
  const command = storedDiscSelectionCommand(parsed.command);
  if (command === null || parsed.identity !== catalogReviewMutationIdentity(archiveId, command)) {
    return discardStored();
  }
  const requiresPreview = discSelectionCommandRequiresPreview(command);
  const previewValue = "preview" in parsed ? parsed.preview : undefined;
  const hasPreview = previewValue !== undefined;
  const preview = hasPreview && requiresPreview
    ? availableDiscSelectionPreview(previewValue, command.action) : undefined;
  if ((hasPreview && preview === null) ||
      (!requiresPreview && ("preview" in parsed || "acknowledged" in parsed)) ||
      ("acknowledged" in parsed && parsed.acknowledged === true && preview === undefined)) {
    return discardStored();
  }
  return {
    archiveId,
    command,
    identity: parsed.identity,
    mutationKey,
    ...(preview ? { preview } : {}),
    ...("acknowledged" in parsed && parsed.acknowledged === true
      ? { acknowledged: true } : {}),
  };
}

function storedDiscSelectionCommand(
  value: unknown,
): DiscSelectionCommand | null {
  const parsed = parseCatalogReviewCommand(value, { mediaItemKinds: MEDIA_ITEM_KINDS });
  return parsed.ok && isDiscSelectionCommand(parsed.command) ? parsed.command : null;
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
      !validCatalogRevision(value.catalogRevision) || !("previewToken" in value) ||
      !isDiscSelectionPreviewToken(value.previewToken) || !("affectedEncodeJobs" in value) ||
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

function validCatalogRevision(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isSafeInteger(parsed.getTime()) && parsed.toISOString() === value;
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
