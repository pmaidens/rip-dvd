import { join } from "node:path";

import type {
  MediaItem,
  MediaItemId,
} from "@rip-dvd/data-access";

function normalizedAbsolutePath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0")) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

export function mediaOutputPath(
  value: unknown,
  mediaLibraryPath: string,
): string | null {
  if (typeof value !== "string") return null;
  const requested = value.trim();
  if (requested.length === 0 || requested.length > 4_096) return null;
  const library = normalizedAbsolutePath(mediaLibraryPath);
  const outputPath = normalizedAbsolutePath(requested);
  if (
    library === null ||
    outputPath === null ||
    library === "/" ||
    !outputPath.startsWith(`${library}/`) ||
    !outputPath.toLowerCase().endsWith(".mkv")
  ) return null;
  return outputPath;
}

function pathSegment(value: string): string | null {
  const segment = value.replaceAll("/", "-").replaceAll("\0", "").trim();
  return segment === "" || segment === "." || segment === ".."
    ? null
    : segment;
}

function mediaItemName(item: MediaItem): string | null {
  const title = pathSegment(item.title);
  if (title === null) {
    return null;
  }
  return item.year === null ? title : `${title} (${item.year})`;
}

function seasonDirectory(item: MediaItem): string | null {
  return item.seasonNumber === null
    ? pathSegment(item.title)
    : `Season ${String(item.seasonNumber).padStart(2, "0")}`;
}

function mediaItemHierarchy(
  item: MediaItem,
  mediaItemsById: ReadonlyMap<MediaItemId, MediaItem>,
): MediaItem[] | null {
  const hierarchy: MediaItem[] = [];
  const visited = new Set<MediaItemId>();
  let current: MediaItem | undefined = item;
  while (current !== undefined) {
    if (visited.has(current.id)) {
      return null;
    }
    visited.add(current.id);
    hierarchy.push(current);
    if (current.parentId === null) {
      return hierarchy.reverse();
    }
    current = mediaItemsById.get(current.parentId);
  }
  return null;
}

function qualifiedFileName(stem: string, qualifier: string | null): string {
  const pathQualifier = qualifier === null ? null : pathSegment(qualifier);
  return `${stem}${pathQualifier === null ? "" : ` - ${pathQualifier}`}.mkv`;
}

function directorySegments(items: readonly MediaItem[]): string[] | null {
  const segments: string[] = [];
  for (const item of items) {
    const segment = item.kind === "season"
      ? seasonDirectory(item)
      : mediaItemName(item);
    if (segment === null) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

function lastSeason(items: readonly MediaItem[]): MediaItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "season") {
      return items[index];
    }
  }
  return undefined;
}

export function suggestedMediaOutputPath(input: {
  item: MediaItem;
  mediaItemsById: ReadonlyMap<MediaItemId, MediaItem>;
  mediaLibraryPath: string;
  selectionQualifier: string | null;
}): string | null {
  const hierarchy = mediaItemHierarchy(input.item, input.mediaItemsById);
  if (hierarchy === null) {
    return null;
  }
  const root = hierarchy[0]!;
  const rootName = mediaItemName(root);
  const itemName = mediaItemName(input.item);
  if (rootName === null || itemName === null) {
    return null;
  }

  let relativePath: string[];
  if (input.item.kind === "episode") {
    const show = hierarchy.find((candidate) => candidate.kind === "tv_show");
    const season = lastSeason(hierarchy);
    if (
      show !== undefined &&
      season?.seasonNumber !== null &&
      season?.seasonNumber !== undefined &&
      input.item.episodeNumber !== null
    ) {
      const showName = mediaItemName(show);
      const episodeTitle = pathSegment(input.item.title);
      if (showName === null || episodeTitle === null) {
        return null;
      }
      const episodeNumber =
        `S${String(season.seasonNumber).padStart(2, "0")}` +
        `E${String(input.item.episodeNumber).padStart(2, "0")}`;
      relativePath = [
        showName,
        `Season ${String(season.seasonNumber).padStart(2, "0")}`,
        qualifiedFileName(
          `${showName} - ${episodeNumber} - ${episodeTitle}`,
          input.selectionQualifier,
        ),
      ];
    } else {
      const parentDirectories = directorySegments(hierarchy.slice(0, -1));
      if (parentDirectories === null) {
        return null;
      }
      relativePath = [
        ...parentDirectories,
        qualifiedFileName(itemName, input.selectionQualifier),
      ];
    }
  } else if (
    hierarchy.length > 1 &&
    (input.item.kind === "trailer" ||
      input.item.kind === "bonus_feature" ||
      input.item.kind === "other")
  ) {
    const parentDirectories = directorySegments(hierarchy.slice(0, -1));
    if (parentDirectories === null) {
      return null;
    }
    relativePath = [
      ...parentDirectories,
      "extras",
      qualifiedFileName(itemName, input.selectionQualifier),
    ];
  } else if (hierarchy.length === 1) {
    relativePath = [
      rootName,
      qualifiedFileName(itemName, input.selectionQualifier),
    ];
  } else {
    const parentDirectories = directorySegments(hierarchy.slice(0, -1));
    if (parentDirectories === null) {
      return null;
    }
    relativePath = [
      ...parentDirectories,
      qualifiedFileName(itemName, input.selectionQualifier),
    ];
  }

  return mediaOutputPath(
    join(input.mediaLibraryPath, ...relativePath),
    input.mediaLibraryPath,
  );
}
