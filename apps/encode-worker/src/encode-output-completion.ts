import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { sameEncodeOutputMutationSnapshot } from "./encode-output-filesystem-identity.js";

/** Bind an authorized remux to exact bytes across its planned inode replacement. */
export interface EncodeOutputRepairCompletion {
  source: Stats;
  output: Stats;
  sha256: string;
}

export async function fingerprintCompletedEncodeOutput(path: string, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || !sameEncodeOutputMutationSnapshot(before, await lstat(path))) {
      throw new Error("Encode Output completion requires a stable nonempty regular file");
    }
    await file.sync();
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) throw new Error("Encode Output changed while recording completion");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (!sameEncodeOutputMutationSnapshot(before, await file.stat()) ||
        !sameEncodeOutputMutationSnapshot(before, await lstat(path))) {
      throw new Error("Encode Output changed while recording completion");
    }
    signal.throwIfAborted();
    return { metadata: before, sha256: digest.digest("hex") };
  } finally { await file.close(); }
}
