import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_ARCHIVE_PATH_BYTES = 4_096;

export async function requireSafeArchiveRoot(path: string): Promise<string> {
  const resolved = resolve(path);
  if (Buffer.byteLength(resolved) > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error("Originals library path exceeds the safety limit");
  }
  await mkdir(resolved, { recursive: true, mode: 0o750 });
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Originals library must be a real directory");
  }
  return realpath(resolved);
}
