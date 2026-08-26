import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  discSelectionSourceDescription,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  validateEncodeQueueSearchQuery,
  type DataAccess,
  type DiscSelection,
  type DiscSelectionId,
  type EncodeQueueHistoryGroup,
  type EncodeJob,
  type EncodeJobId,
  type EncodingProfileId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { readMediaItemsWithAncestors } from "../../../lib/media-item-ancestor-context";
import {
  trustedMutationRequestProblem,
} from "../../../lib/server/trusted-mutation-request";
import {
  mediaOutputPath,
  suggestedMediaOutputPath,
} from "../../../lib/server/media-output-path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENCODE_SELECTION_PAGE_SIZE = 100;
const ENCODE_PROFILE_PAGE_SIZE = 100;

interface EncodeJobsRuntimeConfig {
  mediaLibraryPath: string;
  webTrustedOrigin: string;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function optionOffset(
  parameters: URLSearchParams,
  parameter: string,
): number | null {
  const values = parameters.getAll(parameter);
  if (values.length === 0) {
    return 0;
  }
  const value = values[0]!;
  if (
    values.length !== 1 ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 16
  ) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

function encodeQueueHistoryGroup(
  parameters: URLSearchParams,
): EncodeQueueHistoryGroup | null {
  const values = parameters.getAll("historyGroup");
  if (values.length === 0) {
    return "not_encoded";
  }
  if (values.length !== 1) {
    return null;
  }
  const value = values[0];
  if (value === "not_encoded") {
    return value;
  }
  return value === "re_encode" ? value : null;
}

function encodeQueueSearchQuery(
  parameters: URLSearchParams,
): string | undefined | null {
  const values = parameters.getAll("query");
  if (values.length === 0) {
    return undefined;
  }
  if (values.length !== 1) {
    return null;
  }
  const validation = validateEncodeQueueSearchQuery(values[0]!);
  return validation.valid ? validation.query : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function serializeJob(job: EncodeJob) {
  return {
    id: job.id,
    discSelectionId: job.discSelectionId,
    encodingProfileId: job.encodingProfileId,
    outputPath: job.outputPath,
    status: job.status,
    priority: job.priority,
    progressPhase: job.progressPhase,
    progressPercent: job.progressPercent,
    progressEtaSeconds: job.progressEtaSeconds,
    claimedAt: job.claimedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function outputPathSelectionQualifier(
  selection: DiscSelection,
  hasMultipleSelections: boolean,
): string | null {
  if (!hasMultipleSelections) {
    return null;
  }
  const description = selection.label?.trim() ||
    discSelectionSourceDescription(selection.sourceIdentity);
  return `${description} ${selection.id.slice(-8)}`;
}

function readQueueOptions(
  access: DataAccess,
  selectionOffset: number,
  profileOffset: number,
  mediaLibraryPath: string,
  historyGroup: EncodeQueueHistoryGroup,
  query?: string,
  encodingProfileId?: EncodingProfileId,
) {
  return access.readConsistentSnapshot((snapshot) => {
    if (
      encodingProfileId !== undefined &&
      snapshot.encodingProfiles.list({
        ids: [encodingProfileId],
        mediaDomain: "dvd_video",
        activeOnly: true,
      }).length !== 1
    ) {
      throw new RecordNotFoundError(
        "active DVD video Encoding Profile",
        encodingProfileId,
      );
    }
    const selectionPage = snapshot.encodeJobs.listQueueDiscSelections({
      historyGroup,
      encodingProfileId,
      query,
      limit: ENCODE_SELECTION_PAGE_SIZE,
      offset: selectionOffset,
    });
    const selections = selectionPage.selections.map(({ selection }) => selection);
    const profileRecords = snapshot.encodingProfiles.list({
      mediaDomain: "dvd_video",
      activeOnly: true,
      limit: ENCODE_PROFILE_PAGE_SIZE + 1,
      offset: profileOffset,
    });
    const hasNextProfile = profileRecords.length > ENCODE_PROFILE_PAGE_SIZE;
    const profiles = profileRecords.slice(0, ENCODE_PROFILE_PAGE_SIZE);
    const mediaItemIds = [
      ...new Set(selections.map((selection) => selection.mediaItemId)),
    ];
    const mediaItems = readMediaItemsWithAncestors(
      snapshot.catalog,
      mediaItemIds,
    );
    const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
    const mediaItemIdsWithMultipleSelections = new Set(
      snapshot.catalog.listMediaItemMaintenance({ ids: mediaItemIds })
        .filter((item) => item.discSelectionReferenceCount > 1)
        .map((item) => item.mediaItemId),
    );
    return {
      historyGroup,
      query: query ?? "",
      counts: selectionPage.counts,
      selections: selectionPage.selections.map((queueSelection) => {
        const selection = queueSelection.selection;
        const mediaItem = mediaItemsById.get(selection.mediaItemId);
        const priorCompletedJob = queueSelection.priorCompletedJob;
        const priorCompletedProfile = queueSelection.priorCompletedProfile;
        const logicalJob = queueSelection.logicalJob;
        return {
          id: selection.id,
          mediaItemId: selection.mediaItemId,
          mediaTitle: mediaItem?.title ?? "Unknown Media Item",
          mediaYear: mediaItem?.year ?? null,
          sourceDescription: discSelectionSourceDescription(
            selection.sourceIdentity,
          ),
          hasCompletedEncode: queueSelection.hasCompletedEncode,
          priorCompletedJob:
            priorCompletedJob === null || priorCompletedProfile === null
              ? null
              : {
                id: priorCompletedJob.id,
                status: priorCompletedJob.status,
                profile: {
                  id: priorCompletedProfile.id,
                  displayName: priorCompletedProfile.displayName,
                  version: priorCompletedProfile.version,
                },
              },
          logicalJob: logicalJob === null
            ? null
            : {
              id: logicalJob.id,
              encodingProfileId: logicalJob.encodingProfileId,
              outputPath: logicalJob.outputPath,
              status: logicalJob.status,
              queueAvailable: logicalJob.queueAvailable,
            },
          suggestedOutputPath: mediaItem === undefined
            ? null
            : suggestedMediaOutputPath({
              item: mediaItem,
              mediaItemsById,
              mediaLibraryPath,
              selectionQualifier: outputPathSelectionQualifier(
                selection,
                mediaItemIdsWithMultipleSelections.has(selection.mediaItemId),
              ),
            }),
        };
      }),
      profiles: profiles.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        version: profile.version,
      })),
      page: {
        offset: selectionOffset,
        limit: ENCODE_SELECTION_PAGE_SIZE,
        total: selectionPage.total,
        hasPrevious: selectionOffset > 0,
        hasNext: selectionOffset + selections.length < selectionPage.total,
      },
      profilePage: {
        offset: profileOffset,
        limit: ENCODE_PROFILE_PAGE_SIZE,
        hasPrevious: profileOffset > 0,
        hasNext: hasNextProfile,
      },
    };
  });
}

export async function createEncodeJobsRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getRuntimeConfig: () => EncodeJobsRuntimeConfig = loadConfig,
): Promise<Response> {
  if (
    request.method !== "GET" &&
    request.method !== "POST" &&
    request.method !== "PATCH"
  ) {
    return response({ error: "Method not allowed" }, 405);
  }
  try {
    if (request.method === "GET") {
      const parameters = new URL(request.url).searchParams;
      const historyGroup = encodeQueueHistoryGroup(parameters);
      if (historyGroup === null) {
        return response({ error: "Invalid Encode Job history group" }, 400);
      }
      const query = encodeQueueSearchQuery(parameters);
      if (query === null) {
        return response({ error: "Invalid Disc Selection search query" }, 400);
      }
      const selectionOffset = optionOffset(parameters, "selectionOffset");
      if (selectionOffset === null) {
        return response({ error: "Invalid Disc Selection offset" }, 400);
      }
      const profileOffset = optionOffset(parameters, "profileOffset");
      if (profileOffset === null) {
        return response({ error: "Invalid Encoding Profile offset" }, 400);
      }
      const encodingProfileValues = parameters.getAll("encodingProfileId");
      const encodingProfileValue = encodingProfileValues[0];
      const encodingProfileId = encodingProfileValue === undefined
        ? undefined
        : boundedString(encodingProfileValue);
      if (
        encodingProfileValues.length > 1 ||
        (encodingProfileValue !== undefined && encodingProfileId === null)
      ) {
        return response({ error: "Invalid Encoding Profile" }, 400);
      }
      let config: EncodeJobsRuntimeConfig;
      try {
        config = getRuntimeConfig();
      } catch {
        return response({ error: "Encoding options are unavailable" }, 503);
      }
      return response(
        readQueueOptions(
          getAccess(),
          selectionOffset,
          profileOffset,
          config.mediaLibraryPath,
          historyGroup,
          query,
          encodingProfileId as EncodingProfileId | undefined,
        ),
      );
    }

    let config: EncodeJobsRuntimeConfig;
    try {
      config = getRuntimeConfig();
    } catch {
      return response({ error: "Encode Job queueing is unavailable" }, 503);
    }
    const problem = trustedMutationRequestProblem(
      request,
      config.webTrustedOrigin,
    );
    if (problem) {
      return problem;
    }
    const body = asRecord(await request.json().catch(() => null));
    if (request.method === "PATCH") {
      const encodeJobId = boundedString(body?.encodeJobId);
      const action = body?.action === undefined ? "requeue" : body.action;
      if (
        !body ||
        !encodeJobId ||
        (action !== "cancel" && action !== "requeue")
      ) {
        return response({ error: "Invalid Encode Job command" }, 400);
      }
      const job = action === "cancel"
        ? getAccess().encodeJobs.requestCancellation(encodeJobId as EncodeJobId)
        : getAccess().encodeJobs.requeue(encodeJobId as EncodeJobId);
      return response({ job: serializeJob(job) });
    }
    const discSelectionId = boundedString(body?.discSelectionId);
    const encodingProfileId = boundedString(body?.encodingProfileId);
    const outputPath = mediaOutputPath(
      body?.outputPath,
      config.mediaLibraryPath,
    );
    const priority = body?.priority === undefined ? 0 : body.priority;
    if (
      !body ||
      !discSelectionId ||
      !encodingProfileId ||
      !outputPath ||
      !Number.isSafeInteger(priority)
    ) {
      return response({ error: "Invalid Encode Job" }, 400);
    }
    const job = getAccess().encodeJobs.enqueue({
      discSelectionId: discSelectionId as DiscSelectionId,
      encodingProfileId: encodingProfileId as EncodingProfileId,
      outputPath,
      priority: priority as number,
    });
    return response({ job: serializeJob(job) });
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: error.message }, 404);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Encode Jobs are unavailable" }, 503);
  }
}

export function GET(request: Request): Promise<Response> {
  return createEncodeJobsRoute(request);
}

export function POST(request: Request): Promise<Response> {
  return createEncodeJobsRoute(request);
}

export function PATCH(request: Request): Promise<Response> {
  return createEncodeJobsRoute(request);
}
