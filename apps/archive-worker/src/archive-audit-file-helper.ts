import { inspectArchiveAuditFile } from "./archive-audit-file-inspection.js";

const MAX_REQUEST_BYTES = 16_384;

interface HelperRequest {
  archivePath: string;
  originalsLibraryPath: string;
}

function isHelperRequest(value: unknown): value is HelperRequest {
  return value !== null &&
    typeof value === "object" &&
    "archivePath" in value &&
    typeof value.archivePath === "string" &&
    "originalsLibraryPath" in value &&
    typeof value.originalsLibraryPath === "string";
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
    process.exitCode = 2;
    process.stdin.destroy();
  }
});
process.stdin.on("end", () => {
  void (async () => {
    if (process.exitCode !== undefined) {
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(input);
    } catch {
      process.exitCode = 2;
      return;
    }
    if (!isHelperRequest(request)) {
      process.exitCode = 2;
      return;
    }
    const inspection = await inspectArchiveAuditFile(
      request.archivePath,
      request.originalsLibraryPath,
      new AbortController().signal,
    );
    process.stdout.write(JSON.stringify(inspection));
  })().catch(() => {
    process.exitCode = 2;
  });
});
