import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { ArchiveAuditFileInspection } from "./archive-audit.js";
import {
  isPathInsideArchiveRoot,
  MAX_ARCHIVE_PATH_BYTES,
} from "./archive-root.js";
import {
  DvdGeometryValidationError,
  inspectDvdImageGeometry,
} from "./dvd-geometry-validator.js";

function isMissingFileError(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function inspectArchiveAuditFile(
  archivePath: string,
  originalsLibraryPath: string,
  signal: AbortSignal,
): Promise<ArchiveAuditFileInspection> {
  signal.throwIfAborted();
  if (
    archivePath.length === 0 ||
    originalsLibraryPath.length === 0 ||
    Buffer.byteLength(archivePath) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(originalsLibraryPath) > MAX_ARCHIVE_PATH_BYTES
  ) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "containment_rejection",
    };
  }

  const resolvedRoot = resolve(originalsLibraryPath);
  let canonicalRoot: string;
  try {
    const rootMetadata = await lstat(resolvedRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return {
        actualSizeBytes: null,
        geometry: null,
        outcome: "containment_rejection",
      };
    }
    canonicalRoot = await realpath(resolvedRoot);
  } catch {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "read_error",
    };
  }

  const resolvedArchivePath = resolve(archivePath);
  if (!isPathInsideArchiveRoot(resolvedRoot, resolvedArchivePath)) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "containment_rejection",
    };
  }

  let pathMetadata;
  try {
    pathMetadata = await lstat(resolvedArchivePath, { bigint: true });
  } catch (error) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: isMissingFileError(error) ? "missing_file" : "read_error",
    };
  }
  if (pathMetadata.isSymbolicLink()) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "containment_rejection",
    };
  }
  if (!pathMetadata.isFile()) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "not_regular_file",
    };
  }

  let canonicalArchivePath: string;
  try {
    canonicalArchivePath = await realpath(resolvedArchivePath);
  } catch (error) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: isMissingFileError(error) ? "missing_file" : "read_error",
    };
  }
  if (!isPathInsideArchiveRoot(canonicalRoot, canonicalArchivePath)) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "containment_rejection",
    };
  }
  if (pathMetadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      actualSizeBytes: null,
      geometry: null,
      outcome: "malformed_metadata",
    };
  }
  const actualSizeBytes = Number(pathMetadata.size);
  try {
    const geometry = await inspectDvdImageGeometry({
      expectedByteCount: actualSizeBytes,
      imagePath: canonicalArchivePath,
      signal,
    });
    return { actualSizeBytes, geometry, outcome: "ok" };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (error instanceof DvdGeometryValidationError) {
      if (error.issue === "definite_truncation") {
        return error.geometry === null
          ? { actualSizeBytes, geometry: null, outcome: "read_error" }
          : {
              actualSizeBytes,
              geometry: error.geometry,
              outcome: "definite_truncation",
            };
      }
      return {
        actualSizeBytes,
        geometry: error.geometry,
        outcome: error.issue,
      };
    }
    return {
      actualSizeBytes,
      geometry: null,
      outcome: "read_error",
    };
  }
}
