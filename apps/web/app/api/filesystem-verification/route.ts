import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  RecordNotFoundError,
  type DataAccess,
  type EncodeJobId,
  type FilesystemVerificationStatus,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type VerificationTarget = "original_disc_archive" | "encode_job_output";
const INVENTORY_PAGE_LIMIT = 20;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

function verificationTarget(value: unknown): VerificationTarget | null {
  return value === "original_disc_archive" || value === "encode_job_output"
    ? value
    : null;
}

function inventoryOffset(request: Request): number | null {
  const value = new URL(request.url).searchParams.get("offset");
  if (value === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

export function createFilesystemVerificationInventoryRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
): Response {
  const target = verificationTarget(
    new URL(request.url).searchParams.get("target"),
  );
  const offset = inventoryOffset(request);
  if (target === null || offset === null) {
    return response({ error: "Invalid filesystem verification inventory" }, 400);
  }
  try {
    const access = getAccess();
    if (target === "original_disc_archive") {
      const records = access.filesystemVerification.listOriginalDiscArchives({
        limit: INVENTORY_PAGE_LIMIT + 1,
        offset,
      });
      const pageRecords = records.slice(-INVENTORY_PAGE_LIMIT);
      const discs =
        pageRecords.length === 0
          ? []
          : access.catalog.listDetectedDiscs(undefined, {
              ids: [
                ...new Set(pageRecords.map((record) => record.detectedDiscId)),
              ],
            });
      const discsById = new Map(discs.map((disc) => [disc.id, disc]));
      return response({
        inventory: {
          target,
          items: pageRecords.map((record) => ({
            target,
            id: record.id,
            discLabel:
              discsById.get(record.detectedDiscId)?.volumeLabel ??
              "Unlabeled disc",
            discKind: record.discKind,
            archiveFormat: record.archiveFormat,
            archivedAt: record.archivedAt.toISOString(),
            status: record.verificationStatus,
            message: record.verificationMessage,
            verifiedAt: record.verifiedAt?.toISOString() ?? null,
          })),
          page: {
            offset,
            limit: INVENTORY_PAGE_LIMIT,
            hasPrevious: offset > 0,
            hasNext: records.length > INVENTORY_PAGE_LIMIT,
          },
        },
      });
    }
    const records = access.filesystemVerification.listEncodeJobOutputs({
      limit: INVENTORY_PAGE_LIMIT + 1,
      offset,
    });
    const pageRecords = records.slice(-INVENTORY_PAGE_LIMIT);
    const selections =
      pageRecords.length === 0
        ? []
        : access.catalog.listDiscSelections({
            ids: [...new Set(pageRecords.map((record) => record.discSelectionId))],
          });
    const mediaItems =
      selections.length === 0
        ? []
        : access.catalog.listMediaItems({
            ids: [...new Set(selections.map((selection) => selection.mediaItemId))],
          });
    const profiles =
      pageRecords.length === 0
        ? []
        : access.encodingProfiles.list({
            ids: [...new Set(pageRecords.map((record) => record.encodingProfileId))],
          });
    const selectionsById = new Map(
      selections.map((selection) => [selection.id, selection]),
    );
    const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    return response({
      inventory: {
        target,
        items: pageRecords.map((record) => {
          const selection = selectionsById.get(record.discSelectionId);
          const mediaItem = selection
            ? mediaItemsById.get(selection.mediaItemId)
            : undefined;
          const profile = profilesById.get(record.encodingProfileId);
          return {
            target,
            id: record.id,
            mediaTitle: mediaItem?.title ?? "Unknown Media Item",
            mediaYear: mediaItem?.year ?? null,
            encodingProfileName: profile
              ? `${profile.displayName} · Version ${profile.version}`
              : "Unknown Encoding Profile",
            jobStatus: record.status,
            updatedAt: record.updatedAt.toISOString(),
            status: record.verificationStatus,
            message: record.verificationMessage,
            verifiedAt: record.verifiedAt?.toISOString() ?? null,
          };
        }),
        page: {
          offset,
          limit: INVENTORY_PAGE_LIMIT,
          hasPrevious: offset > 0,
          hasNext: records.length > INVENTORY_PAGE_LIMIT,
        },
      },
    });
  } catch {
    return response({ error: "Filesystem verification is unavailable" }, 503);
  }
}

function serializeVerification(
  target: VerificationTarget,
  record: {
    id: string;
    verificationStatus: FilesystemVerificationStatus | null;
    verificationMessage: string | null;
    verifiedAt: Date | null;
  },
) {
  if (
    record.verificationStatus === null ||
    record.verificationMessage === null ||
    record.verifiedAt === null
  ) {
    throw new Error("Filesystem verification result is incomplete");
  }
  return {
    verification: {
      target,
      id: record.id,
      status: record.verificationStatus,
      message: record.verificationMessage,
      verifiedAt: record.verifiedAt.toISOString(),
    },
  };
}

export async function createFilesystemVerificationRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = getTrustedOrigin();
  } catch {
    return response({ error: "Filesystem verification is unavailable" }, 503);
  }
  const problem = mutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }

  try {
    const body = asRecord(await request.json().catch(() => null));
    const target = verificationTarget(body?.target);
    const id = boundedString(body?.id);
    if (!body || !target || !id) {
      return response({ error: "Invalid filesystem verification" }, 400);
    }
    const access = getAccess();
    const record = await (
      target === "original_disc_archive"
        ? access.filesystemVerification.verifyOriginalDiscArchive(
            id as OriginalDiscArchiveId,
          )
        : access.filesystemVerification.verifyEncodeJobOutput(id as EncodeJobId)
    );
    return response(serializeVerification(target, record));
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Verification target not found" }, 404);
    }
    if (error instanceof DomainInvariantError) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Filesystem verification is unavailable" }, 503);
  }
}

export function POST(request: Request): Promise<Response> {
  return createFilesystemVerificationRoute(request);
}

export function GET(request: Request): Response {
  return createFilesystemVerificationInventoryRoute(request);
}
