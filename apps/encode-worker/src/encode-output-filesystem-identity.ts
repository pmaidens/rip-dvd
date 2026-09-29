import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

import {
  decodeOutputFilesystemIdentity,
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  sameEncodeOutputAuthoritySnapshot,
  sameEncodeOutputInode,
  sameEncodeOutputMutationSnapshot,
} from "@rip-dvd/data-access";
import type {
  EncodeOutputFilesystemAuthoritySnapshot,
} from "@rip-dvd/data-access";

export {
  decodeOutputFilesystemIdentity,
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  sameEncodeOutputAuthoritySnapshot,
  sameEncodeOutputInode,
  sameEncodeOutputMutationSnapshot,
};
export type { EncodeOutputFilesystemAuthoritySnapshot };

export async function requireNonEmptyRegularEncodeOutput(
  path: string,
  errorMessage: string,
): Promise<Stats> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0
  ) {
    throw new Error(errorMessage);
  }
  return metadata;
}
