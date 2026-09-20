import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  ArchiveAuditFileInspection,
  ArchiveAuditFileInspector,
  ArchiveAuditFileOutcome,
} from "./archive-audit.js";

const MAX_HELPER_OUTPUT_BYTES = 4_096;
const FILE_OUTCOMES = new Set<ArchiveAuditFileOutcome>([
  "ok",
  "definite_truncation",
  "malformed_metadata",
  "unsupported_layout",
  "missing_file",
  "containment_rejection",
  "not_regular_file",
  "read_error",
  "read_timeout",
]);

function isNullableNonnegativeSafeInteger(
  value: unknown,
): value is number | null {
  return value === null ||
    (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isNullableSectorCount(value: unknown): value is number | null {
  return value === null ||
    (Number.isSafeInteger(value) && (value as number) >= 0);
}

function parseInspection(value: string): ArchiveAuditFileInspection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("actualSizeBytes" in parsed) ||
    !isNullableNonnegativeSafeInteger(parsed.actualSizeBytes) ||
    !("outcome" in parsed) ||
    typeof parsed.outcome !== "string" ||
    !FILE_OUTCOMES.has(parsed.outcome as ArchiveAuditFileOutcome) ||
    !("geometry" in parsed)
  ) {
    return null;
  }
  if (parsed.geometry !== null) {
    if (
      typeof parsed.geometry !== "object" ||
      !("imageSectorCount" in parsed.geometry) ||
      !isNullableSectorCount(parsed.geometry.imageSectorCount) ||
      parsed.geometry.imageSectorCount === null ||
      !("isoVolumeSectorCount" in parsed.geometry) ||
      !isNullableSectorCount(parsed.geometry.isoVolumeSectorCount) ||
      !("udfMaximumDeclaredSectorCount" in parsed.geometry) ||
      !isNullableSectorCount(parsed.geometry.udfMaximumDeclaredSectorCount)
    ) {
      return null;
    }
  }
  if (
    parsed.outcome === "ok" &&
    (parsed.actualSizeBytes === null || parsed.geometry === null)
  ) {
    return null;
  }
  return parsed as ArchiveAuditFileInspection;
}

export interface BoundedArchiveAuditFileInspectorOptions {
  timeoutMs: number;
  helperPath?: string;
}

export function createBoundedArchiveAuditFileInspector({
  timeoutMs,
  helperPath = fileURLToPath(
    new URL("./archive-audit-file-helper.js", import.meta.url),
  ),
}: BoundedArchiveAuditFileInspectorOptions): ArchiveAuditFileInspector {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Archive audit file timeout must be a positive integer");
  }
  return {
    inspect(archivePath, originalsLibraryPath, signal) {
      signal.throwIfAborted();
      return new Promise<ArchiveAuditFileInspection>((resolve, reject) => {
        const child = spawn(process.execPath, [helperPath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let outputTooLarge = false;
        let settled = false;
        const finish = (inspection: ArchiveAuditFileInspection): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve(inspection);
        };
        const failForAbort = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(signal.reason);
        };
        const abort = () => failForAbort();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({
            actualSizeBytes: null,
            geometry: null,
            outcome: "read_timeout",
          });
        }, timeoutMs);
        signal.addEventListener("abort", abort, { once: true });

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > MAX_HELPER_OUTPUT_BYTES) {
            outputTooLarge = true;
            child.kill("SIGKILL");
          }
        });
        let stderrBytes = 0;
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) {
            child.kill("SIGKILL");
          }
        });
        child.stdin.on("error", () => undefined);
        child.once("error", () => {
          finish({
            actualSizeBytes: null,
            geometry: null,
            outcome: "read_error",
          });
        });
        child.once("close", (code) => {
          if (settled) return;
          const inspection = code === 0 && !outputTooLarge
            ? parseInspection(stdout)
            : null;
          finish(inspection ?? {
            actualSizeBytes: null,
            geometry: null,
            outcome: "read_error",
          });
        });
        child.stdin.end(JSON.stringify({ archivePath, originalsLibraryPath }));
      });
    },
  };
}
