import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  type DataAccess,
  type DiscSelection,
  type DiscSelectionId,
  type EncodeJob,
  type EncodeJobId,
  type EncodingProfileId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

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

function optionOffset(request: Request, parameter: string): number | null {
  const value = new URL(request.url).searchParams.get(parameter);
  if (value === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

function headerOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  return url.origin;
}

function mutationRequestProblem(
  request: Request,
  trustedOrigin: string,
): Response | null {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return response({ error: "JSON content type required" }, 415);
  }
  const origin = request.headers.get("Origin");
  const host = request.headers.get("Host")?.trim().toLowerCase();
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  const trustedUrl = new URL(trustedOrigin);
  if (
    origin === null ||
    headerOrigin(origin) !== trustedUrl.origin ||
    host === undefined ||
    host !== trustedUrl.host.toLowerCase() ||
    (fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    return response({ error: "Cross-origin mutation rejected" }, 403);
  }
  return null;
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

function normalizedAbsolutePath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0")) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

function mediaOutputPath(value: unknown, mediaLibraryPath: string): string | null {
  const requested = boundedString(value, 4_096);
  if (!requested) {
    return null;
  }
  const library = normalizedAbsolutePath(mediaLibraryPath);
  const outputPath = normalizedAbsolutePath(requested);
  if (
    library === null ||
    outputPath === null ||
    library === "/" ||
    !outputPath.startsWith(`${library}/`) ||
    !outputPath.toLowerCase().endsWith(".mkv")
  ) {
    return null;
  }
  return outputPath;
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

function sourceDescription(selection: DiscSelection): string {
  if (selection.kind === "main_feature") {
    return "DVD main feature";
  }
  if (selection.kind === "dvd_title") {
    return `DVD title ${selection.titleNumber}`;
  }
  return `DVD title ${selection.titleNumber}, chapters ${selection.chapterStart}–${selection.chapterEnd}`;
}

function readQueueOptions(
  access: DataAccess,
  selectionOffset: number,
  profileOffset: number,
) {
  return access.readConsistentSnapshot((snapshot) => {
    const selectionRecords = snapshot.catalog.listDiscSelections({
      encodeEligibleOnly: true,
      limit: ENCODE_SELECTION_PAGE_SIZE + 1,
      offset: selectionOffset,
    });
    const hasNextSelection =
      selectionRecords.length > ENCODE_SELECTION_PAGE_SIZE;
    const selections = selectionRecords.slice(0, ENCODE_SELECTION_PAGE_SIZE);
    const profileRecords = snapshot.encodingProfiles.list({
      mediaDomain: "dvd_video",
      activeOnly: true,
      limit: ENCODE_PROFILE_PAGE_SIZE + 1,
      offset: profileOffset,
    });
    const hasNextProfile = profileRecords.length > ENCODE_PROFILE_PAGE_SIZE;
    const profiles = profileRecords.slice(0, ENCODE_PROFILE_PAGE_SIZE);
    const mediaItems = snapshot.catalog.listMediaItems({
      ids: [...new Set(selections.map((selection) => selection.mediaItemId))],
    });
    const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
    return {
      selections: selections.map((selection) => {
        const mediaItem = mediaItemsById.get(selection.mediaItemId);
        return {
          id: selection.id,
          mediaItemId: selection.mediaItemId,
          mediaTitle: mediaItem?.title ?? "Unknown Media Item",
          mediaYear: mediaItem?.year ?? null,
          sourceDescription: sourceDescription(selection),
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
        hasPrevious: selectionOffset > 0,
        hasNext: hasNextSelection,
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
      const selectionOffset = optionOffset(request, "selectionOffset");
      if (selectionOffset === null) {
        return response({ error: "Invalid Disc Selection offset" }, 400);
      }
      const profileOffset = optionOffset(request, "profileOffset");
      if (profileOffset === null) {
        return response({ error: "Invalid Encoding Profile offset" }, 400);
      }
      return response(
        readQueueOptions(getAccess(), selectionOffset, profileOffset),
      );
    }

    let config: EncodeJobsRuntimeConfig;
    try {
      config = getRuntimeConfig();
    } catch {
      return response({ error: "Encode Job queueing is unavailable" }, 503);
    }
    const problem = mutationRequestProblem(request, config.webTrustedOrigin);
    if (problem) {
      return problem;
    }
    const body = asRecord(await request.json().catch(() => null));
    if (request.method === "PATCH") {
      const encodeJobId = boundedString(body?.encodeJobId);
      if (!body || !encodeJobId) {
        return response({ error: "Invalid Encode Job retry" }, 400);
      }
      const job = getAccess().encodeJobs.requeue(encodeJobId as EncodeJobId);
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
