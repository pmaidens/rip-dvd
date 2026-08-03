import {
  decodeArchivedDvdTitles,
  DISC_SELECTION_KINDS,
  DomainInvariantError,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  MEDIA_ITEM_KINDS,
  RecordNotFoundError,
  type DataAccess,
  type DiscSelection,
  type MediaItem,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";

import { getDataAccess } from "../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CATALOG_REVIEW_MEDIA_PAGE_SIZE = 100;
const CATALOG_REVIEW_SELECTION_PAGE_SIZE = 100;
const MEDIA_ITEM_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "parentId",
  "kind",
  "title",
  "year",
  "seasonNumber",
  "episodeNumber",
]);

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function headerOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
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
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
    ? value as number
    : undefined;
}

function recordOffset(request: Request, parameter: string): number | null {
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

function optionalRecordId(
  request: Request,
  parameter: string,
): string | null | undefined {
  const value = new URL(request.url).searchParams.get(parameter);
  return value === null ? undefined : boundedString(value);
}

function serializeMediaItem(item: MediaItem) {
  return {
    id: item.id,
    parentId: item.parentId,
    kind: item.kind,
    title: item.title,
    year: item.year,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
  };
}

function serializeDiscSelection(selection: DiscSelection) {
  return {
    id: selection.id,
    mediaItemId: selection.mediaItemId,
    sourceKey: selection.sourceKey,
    kind: selection.kind,
    titleNumber: selection.titleNumber,
    chapterStart: selection.chapterStart,
    chapterEnd: selection.chapterEnd,
    label: selection.label,
  };
}

function readCatalogReview(
  access: DataAccess,
  id: OriginalDiscArchiveId,
  mediaItemOffset: number,
  discSelectionOffset: number,
  editingMediaItemId?: MediaItemId,
) {
  return access.readConsistentSnapshot((snapshot) => {
    const archive = snapshot.catalog.listOriginalDiscArchives({ ids: [id] })[0];
    if (!archive) {
      return null;
    }
    const disc = snapshot.catalog.listDetectedDiscs(undefined, {
      ids: [archive.detectedDiscId],
    })[0];
    if (!disc) {
      throw new DomainInvariantError(
        "Original Disc Archive is missing its Detected Disc provenance",
      );
    }
    const mediaItems = snapshot.catalog.listMediaItems({
      limit: CATALOG_REVIEW_MEDIA_PAGE_SIZE + 1,
      offset: mediaItemOffset,
    });
    const discSelections = snapshot.catalog.listDiscSelections({
      originalDiscArchiveId: id,
      limit: CATALOG_REVIEW_SELECTION_PAGE_SIZE + 1,
      offset: discSelectionOffset,
    });
    const hasNextMediaItems =
      mediaItems.length > CATALOG_REVIEW_MEDIA_PAGE_SIZE;
    const mediaItemsPage = mediaItems.slice(
      0,
      CATALOG_REVIEW_MEDIA_PAGE_SIZE,
    );
    const hasNextDiscSelections =
      discSelections.length > CATALOG_REVIEW_SELECTION_PAGE_SIZE;
    const discSelectionsPage = discSelections.slice(
      0,
      CATALOG_REVIEW_SELECTION_PAGE_SIZE,
    );
    const mediaItemPageIds = new Set(mediaItemsPage.map((item) => item.id));
    const mediaItemsById = new Map(
      mediaItemsPage.map((item) => [item.id, item]),
    );
    const seedIds = [
      ...mediaItemsPage.map((item) => item.id),
      ...discSelectionsPage.map((selection) => selection.mediaItemId),
      editingMediaItemId,
    ].filter(
      (itemId): itemId is MediaItemId =>
        itemId !== null && itemId !== undefined,
    );
    const processedDepths = new Map<MediaItemId, number>();
    let pendingDepths = new Map(seedIds.map((itemId) => [itemId, 1]));
    while (pendingDepths.size > 0) {
      const currentDepths = pendingDepths;
      pendingDepths = new Map();
      const missingIds = [...currentDepths.keys()].filter(
        (itemId) => !mediaItemsById.has(itemId),
      );
      const contextItems = missingIds.length === 0
        ? []
        : snapshot.catalog.listMediaItems({ ids: missingIds });
      for (const item of contextItems) {
        mediaItemsById.set(item.id, item);
      }
      for (const [itemId, depth] of currentDepths) {
        if ((processedDepths.get(itemId) ?? 0) >= depth) {
          continue;
        }
        processedDepths.set(itemId, depth);
        const item = mediaItemsById.get(itemId);
        if (item?.parentId !== null && item?.parentId !== undefined) {
          const parentDepth = depth + 1;
          if (parentDepth > MAX_MEDIA_ITEM_HIERARCHY_DEPTH) {
            throw new DomainInvariantError(
              "Media Item hierarchy exceeds the supported depth",
            );
          }
          if (
            (processedDepths.get(item.parentId) ?? 0) < parentDepth &&
            (pendingDepths.get(item.parentId) ?? 0) < parentDepth
          ) {
            pendingDepths.set(item.parentId, parentDepth);
          }
        }
      }
    }
    const contextMediaItems = [...mediaItemsById.values()].filter(
      (item) => !mediaItemPageIds.has(item.id),
    );
    return {
      archive: {
        id: archive.id,
        discLabel: disc.volumeLabel ?? "Unlabeled disc",
        discKind: archive.discKind,
        archiveFormat: archive.archiveFormat,
        archivedAt: archive.archivedAt.toISOString(),
        catalogReviewedAt: archive.catalogReviewedAt?.toISOString() ?? null,
      },
      reviewStatus:
        archive.catalogReviewedAt === null ? "needs_review" : "reviewed",
      rawScan: {
        titles: decodeArchivedDvdTitles(disc.scanData) ?? [],
      },
      mediaItems: [...contextMediaItems, ...mediaItemsPage].map(
        serializeMediaItem,
      ),
      mediaItemsPage: {
        offset: mediaItemOffset,
        limit: CATALOG_REVIEW_MEDIA_PAGE_SIZE,
        hasPrevious: mediaItemOffset > 0,
        hasNext: hasNextMediaItems,
        itemIds: mediaItemsPage.map((item) => item.id),
      },
      discSelections: discSelectionsPage.map(serializeDiscSelection),
      discSelectionsPage: {
        offset: discSelectionOffset,
        limit: CATALOG_REVIEW_SELECTION_PAGE_SIZE,
        hasPrevious: discSelectionOffset > 0,
        hasNext: hasNextDiscSelections,
      },
    };
  });
}

export async function createCatalogReviewRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  if (id.trim().length === 0 || id.length > 256) {
    return response({ error: "Invalid Original Disc Archive" }, 400);
  }
  try {
    const archiveId = id as OriginalDiscArchiveId;
    if (request.method === "GET") {
      const mediaItemOffset = recordOffset(request, "mediaOffset");
      const discSelectionOffset = recordOffset(request, "selectionOffset");
      const editingMediaItemId = optionalRecordId(
        request,
        "editingMediaItemId",
      );
      if (
        mediaItemOffset === null ||
        discSelectionOffset === null ||
        editingMediaItemId === null
      ) {
        return response({ error: "Invalid Media Item offset" }, 400);
      }
      const review = readCatalogReview(
        getAccess(),
        archiveId,
        mediaItemOffset,
        discSelectionOffset,
        editingMediaItemId as MediaItemId | undefined,
      );
      return review === null
        ? response({ error: "Original Disc Archive not found" }, 404)
        : response(review);
    }

    let trustedOrigin: string;
    try {
      trustedOrigin = getTrustedOrigin();
    } catch {
      return response({ error: "Catalog review mutation is unavailable" }, 503);
    }
    const problem = mutationRequestProblem(request, trustedOrigin);
    if (problem) {
      return problem;
    }
    const access = getAccess();
    if (
      access.catalog.listOriginalDiscArchives({ ids: [archiveId] }).length === 0
    ) {
      return response({ error: "Original Disc Archive not found" }, 404);
    }
    const body = asRecord(await request.json().catch(() => null));
    const action = boundedString(body?.action, 64);
    if (!body || !action) {
      return response({ error: "Invalid catalog review mutation" }, 400);
    }

    if (action === "create_media_item") {
      const input = asRecord(body.mediaItem);
      const kind = boundedString(input?.kind, 32);
      const title = boundedString(input?.title);
      const parentId = input?.parentId === undefined || input.parentId === null
        ? undefined
        : boundedString(input.parentId);
      const year = optionalInteger(input?.year, 1800, 9999);
      const seasonNumber = optionalInteger(input?.seasonNumber, 0);
      const episodeNumber = optionalInteger(input?.episodeNumber, 1);
      if (
        !input ||
        !kind ||
        !MEDIA_ITEM_KINDS.includes(kind as never) ||
        !title ||
        (input.parentId !== undefined && input.parentId !== null && !parentId) ||
        (input.year !== undefined && year === undefined) ||
        (input.seasonNumber !== undefined && seasonNumber === undefined) ||
        (input.episodeNumber !== undefined && episodeNumber === undefined)
      ) {
        return response({ error: "Invalid Media Item" }, 400);
      }
      const item = access.catalog.createMediaItem({
        ...(parentId ? { parentId: parentId as MediaItemId } : {}),
        kind: kind as (typeof MEDIA_ITEM_KINDS)[number],
        title,
        ...(year === null || year === undefined ? {} : { year }),
        ...(seasonNumber === null || seasonNumber === undefined
          ? {}
          : { seasonNumber }),
        ...(episodeNumber === null || episodeNumber === undefined
          ? {}
          : { episodeNumber }),
      });
      return response({ mediaItem: serializeMediaItem(item) }, 201);
    }

    if (action === "update_media_item") {
      const mediaItemId = boundedString(body.mediaItemId);
      const changes = asRecord(body.changes);
      const changeFields = changes === null ? [] : Object.keys(changes);
      if (
        !mediaItemId ||
        !changes ||
        changeFields.length === 0 ||
        changeFields.some((field) => !MEDIA_ITEM_UPDATE_FIELDS.has(field))
      ) {
        return response({ error: "Invalid Media Item update" }, 400);
      }
      const update: Parameters<
        DataAccess["catalog"]["updateMediaItem"]
      >[1] = {};
      if ("parentId" in changes) {
        if (changes.parentId === null) {
          update.parentId = null;
        } else {
          const parentId = boundedString(changes.parentId);
          if (!parentId) {
            return response({ error: "Invalid Media Item parent" }, 400);
          }
          update.parentId = parentId as MediaItemId;
        }
      }
      if ("kind" in changes) {
        const kind = boundedString(changes.kind, 32);
        if (!kind || !MEDIA_ITEM_KINDS.includes(kind as never)) {
          return response({ error: "Invalid Media Item kind" }, 400);
        }
        update.kind = kind as (typeof MEDIA_ITEM_KINDS)[number];
      }
      if ("title" in changes) {
        const title = boundedString(changes.title);
        if (!title) {
          return response({ error: "Invalid Media Item title" }, 400);
        }
        update.title = title;
      }
      for (const [field, minimum, maximum] of [
        ["year", 1800, 9999],
        ["seasonNumber", 0, Number.MAX_SAFE_INTEGER],
        ["episodeNumber", 1, Number.MAX_SAFE_INTEGER],
      ] as const) {
        if (field in changes) {
          const value = optionalInteger(changes[field], minimum, maximum);
          if (value === undefined) {
            return response({ error: `Invalid Media Item ${field}` }, 400);
          }
          update[field] = value;
        }
      }
      const item = access.catalog.updateMediaItem(
        mediaItemId as MediaItemId,
        update,
      );
      return response({ mediaItem: serializeMediaItem(item) });
    }

    if (action === "create_disc_selection") {
      const input = asRecord(body.selection);
      const mediaItemId = boundedString(input?.mediaItemId);
      const kind = boundedString(input?.kind, 32);
      const label = input?.label === undefined
        ? undefined
        : boundedString(input.label);
      if (
        !input ||
        !mediaItemId ||
        !kind ||
        !DISC_SELECTION_KINDS.includes(kind as never) ||
        (input.label !== undefined && !label)
      ) {
        return response({ error: "Invalid Disc Selection" }, 400);
      }
      const common = {
        originalDiscArchiveId: archiveId,
        mediaItemId: mediaItemId as MediaItemId,
        ...(label ? { label } : {}),
      };
      let selection: DiscSelection;
      if (kind === "main_feature") {
        selection = access.catalog.createDiscSelection({
          ...common,
          kind,
        });
      } else {
        const titleNumber = optionalInteger(input.titleNumber, 1);
        if (titleNumber === null || titleNumber === undefined) {
          return response({ error: "Invalid DVD title number" }, 400);
        }
        if (kind === "dvd_title") {
          selection = access.catalog.createDiscSelection({
            ...common,
            kind: "dvd_title",
            titleNumber,
          });
        } else {
          const chapterStart = optionalInteger(input.chapterStart, 1);
          const chapterEnd = optionalInteger(input.chapterEnd, 1);
          if (
            chapterStart === null ||
            chapterStart === undefined ||
            chapterEnd === null ||
            chapterEnd === undefined
          ) {
            return response({ error: "Invalid DVD chapter range" }, 400);
          }
          selection = access.catalog.createDiscSelection({
            ...common,
            kind: "dvd_chapters",
            titleNumber,
            chapterStart,
            chapterEnd,
          });
        }
      }
      return response({ discSelection: serializeDiscSelection(selection) }, 201);
    }

    if (action === "complete_review") {
      const archive = access.catalog.completeCatalogReview(archiveId);
      return response({
        archive: {
          id: archive.id,
          catalogReviewedAt: archive.catalogReviewedAt?.toISOString() ?? null,
        },
      });
    }

    return response({ error: "Unknown catalog review mutation" }, 400);
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: error.message }, 404);
    }
    if (error instanceof DomainInvariantError) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Catalog review is unavailable" }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createCatalogReviewRoute(request, id);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createCatalogReviewRoute(request, id);
}
