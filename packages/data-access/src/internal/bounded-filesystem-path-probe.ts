import { spawn } from "node:child_process";

export type FilesystemPathInspection = "file" | "other" | "unsafe";

export interface FilesystemPathProbe {
  inspect(
    path: string,
    configuredRoot?: string,
  ): Promise<FilesystemPathInspection>;
}

export interface FilesystemProbeHelper {
  readonly result: Promise<FilesystemPathInspection>;
  terminate(): void;
}

interface BoundedFilesystemPathProbeOptions {
  maxConcurrent?: number;
  timeoutMs?: number;
  startHelper?: (
    path: string,
    configuredRoot?: string,
  ) => FilesystemProbeHelper;
}

const FILESYSTEM_PROBE_HELPER_SOURCE = String.raw`
const { accessSync, constants, lstatSync, realpathSync } = require("node:fs");
const { isAbsolute, relative, resolve, sep } = require("node:path");

function isContainedPath(root, path) {
  const relativePath = relative(root, resolve(path));
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(".." + sep) &&
    !isAbsolute(relativePath);
}

function writeResult(result) {
  process.stdout.write(JSON.stringify(result));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 16_384) {
    process.exit(2);
  }
});
process.stdin.on("end", () => {
  try {
    const request = JSON.parse(input);
    const metadata = lstatSync(request.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      writeResult({ inspection: "other" });
      return;
    }
    if (request.configuredRoot !== undefined) {
      const canonicalRoot = realpathSync(request.configuredRoot);
      const canonicalPath = realpathSync(request.path);
      if (!isContainedPath(canonicalRoot, canonicalPath)) {
        writeResult({ inspection: "unsafe" });
        return;
      }
    }
    accessSync(request.path, constants.R_OK);
    writeResult({ inspection: "file" });
  } catch (error) {
    writeResult({
      errorCode:
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : null,
    });
  }
});
`;

function codedError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function startFilesystemProbeHelper(
  path: string,
  configuredRoot?: string,
): FilesystemProbeHelper {
  const child = spawn(process.execPath, ["-e", FILESYSTEM_PROBE_HELPER_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let outputTooLarge = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 4_096) {
      outputTooLarge = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (chunk.length > 4_096) {
      child.kill("SIGKILL");
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify({ path, configuredRoot }));

  const result = new Promise<FilesystemPathInspection>((resolve, reject) => {
    child.once("error", () => {
      reject(codedError("Filesystem verification helper failed", "EIO"));
    });
    child.once("close", (code) => {
      if (code !== 0 || outputTooLarge) {
        reject(codedError("Filesystem verification helper failed", "EIO"));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          inspection?: unknown;
          errorCode?: unknown;
        };
        if (
          parsed.inspection === "file" ||
          parsed.inspection === "other" ||
          parsed.inspection === "unsafe"
        ) {
          resolve(parsed.inspection);
          return;
        }
        if (typeof parsed.errorCode === "string") {
          reject(
            codedError("Filesystem verification helper failed", parsed.errorCode),
          );
          return;
        }
      } catch {
        // The parent maps malformed helper output to a fixed unexpected error.
      }
      reject(codedError("Filesystem verification helper failed", "EIO"));
    });
  });

  return {
    result,
    terminate() {
      child.kill("SIGKILL");
    },
  };
}

export function createBoundedFilesystemPathProbe({
  maxConcurrent = 2,
  timeoutMs = 3_000,
  startHelper = startFilesystemProbeHelper,
}: BoundedFilesystemPathProbeOptions = {}): FilesystemPathProbe {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TypeError("maxConcurrent must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  const activeHelpers = new Set<FilesystemProbeHelper>();

  return {
    inspect(path, configuredRoot) {
      if (activeHelpers.size >= maxConcurrent) {
        return Promise.reject(
          codedError("Filesystem verification admission is full", "EBUSY"),
        );
      }
      let helper: FilesystemProbeHelper;
      try {
        helper = startHelper(path, configuredRoot);
      } catch {
        return Promise.reject(
          codedError("Filesystem verification helper failed", "EIO"),
        );
      }
      activeHelpers.add(helper);

      return new Promise<FilesystemPathInspection>((resolve, reject) => {
        let responseSettled = false;
        const timer = setTimeout(() => {
          if (responseSettled) {
            return;
          }
          responseSettled = true;
          helper.terminate();
          reject(codedError("Filesystem verification timed out", "ETIMEDOUT"));
        }, timeoutMs);

        void helper.result
          .then(
            (inspection) => {
              if (!responseSettled) {
                responseSettled = true;
                clearTimeout(timer);
                resolve(inspection);
              }
            },
            (error: unknown) => {
              if (!responseSettled) {
                responseSettled = true;
                clearTimeout(timer);
                reject(error);
              }
            },
          )
          .finally(() => {
            activeHelpers.delete(helper);
          });
      });
    },
  };
}
