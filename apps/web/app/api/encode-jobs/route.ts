import { loadConfig } from "@rip-dvd/config";
import {
  createApplicationOperations,
  generateMutationKey,
  InvalidEncodeJobInputError,
  InvalidMutationKeyError,
  parseMutationKey,
  parseEncodeEnqueueInput,
  readQueueOptions,
  resolveQueueLogicalJobs,
  serializeJob,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
  validateEncodeQueueSearchQuery,
  type DataAccess,
  type DiscSelectionId,
  type EncodeQueueHistoryGroup,
  type EncodingProfileId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import {
  trustedMutationRequestProblem,
} from "../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENCODE_SELECTION_PAGE_SIZE = 100;

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
      const resolveSelectionValues = parameters.getAll(
        "resolveDiscSelectionId",
      );
      const resolveSelectionIds = resolveSelectionValues.map((value) =>
        boundedString(value)
      );
      if (
        resolveSelectionValues.length > ENCODE_SELECTION_PAGE_SIZE ||
        resolveSelectionIds.some((id) => id === null) ||
        (resolveSelectionValues.length > 0 && encodingProfileId === undefined)
      ) {
        return response({ error: "Invalid Disc Selection resolution" }, 400);
      }
      let config: EncodeJobsRuntimeConfig;
      try {
        config = getRuntimeConfig();
      } catch {
        return response({ error: "Encoding options are unavailable" }, 503);
      }
      if (resolveSelectionIds.length > 0) {
        const resolvedDiscSelections = resolveQueueLogicalJobs(
          getAccess(),
          resolveSelectionIds as DiscSelectionId[],
          encodingProfileId as EncodingProfileId,
        );
        return response({
          resolvedDiscSelections,
          conflictingDiscSelectionIds: resolvedDiscSelections.flatMap(
            (resolution) =>
              resolution.logicalJob === null
                ? []
                : [resolution.discSelectionId],
          ),
        });
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
    const mutationKey = body?.mutationKey === undefined
      ? generateMutationKey()
      : parseMutationKey(body.mutationKey);
    if (request.method === "PATCH") {
      const encodeJobId = boundedString(body?.encodeJobId);
      const action = body?.action === undefined ? "requeue" : body.action;
      if (
        !body ||
        !encodeJobId ||
        (action !== "cancel" && action !== "requeue" &&
          action !== "preview_requeue")
      ) {
        return response({ error: "Invalid Encode Job command" }, 400);
      }
      const operations = createApplicationOperations(getAccess());
      if (action === "preview_requeue") {
        return response({
          preview: operations.previewEncodeRequeue({ encodeJobId }),
        });
      }
      const job = action === "cancel"
        ? operations.cancelEncodeJob({ encodeJobId, mutationKey })
        : operations.requeueEncodeJob({
          encodeJobId,
          outputPath: body.outputPath,
          priority: body.priority,
          mutationKey,
          expectedRevision: body.expectedRevision,
          acknowledgeReplacement: body.acknowledgeReplacement,
          mediaLibraryPath: config.mediaLibraryPath,
        });
      return response({ job: serializeJob(job) });
    }
    if (!body) return response({ error: "Invalid Encode Job" }, 400);
    const input = parseEncodeEnqueueInput(config.mediaLibraryPath, {
      discSelectionId: body.discSelectionId,
      encodingProfileId: body.encodingProfileId,
      outputPath: body.outputPath,
      priority: body.priority,
      mutationKey,
    });
    const job = createApplicationOperations(getAccess()).enqueueEncodeJob({
      ...input, mediaLibraryPath: config.mediaLibraryPath,
    });
    return response({ job: serializeJob(job) });
  } catch (error) {
    if (error instanceof InvalidEncodeJobInputError || error instanceof InvalidMutationKeyError) {
      return response({ error: "Invalid Encode Job" }, 400);
    }
    if (error instanceof MutationKeyConflictError) {
      return response({ error: error.message }, 409);
    }
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
