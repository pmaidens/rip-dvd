import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

import {
  nodeCommandRunner,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import { dvdTitleMapsAgree } from "./dvd-title-map-verification.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";
import {
  DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH,
  readDvdNavigation,
  runDvdLayoutClassifier,
} from "./dvd-validation-process.js";

export interface DvdCompletenessProofRequest {
  candidateBoundaryLba: number;
  expectedTitleMap: DvdTitleMap;
  imagePath: string;
  signal: AbortSignal;
}

export interface DvdCompletenessProof {
  maximumReferencedLba: number;
}

export interface DvdCompletenessProver {
  prove(request: DvdCompletenessProofRequest): Promise<DvdCompletenessProof>;
}

interface DvdCandidateSnapshot {
  dispose(): Promise<void>;
  imagePath: string;
  verifyUnchanged(): Promise<void>;
}

type DvdCandidateSnapshotFactory = (request: {
  candidateByteCount: number;
  imagePath: string;
  signal: AbortSignal;
}) => Promise<DvdCandidateSnapshot>;

const SNAPSHOT_BUFFER_BYTES = 8 * 1_024 * 1_024;
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;

function sameFileMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

const createDvdCandidateSnapshot: DvdCandidateSnapshotFactory = async ({
  candidateByteCount,
  imagePath,
  signal,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "rip-dvd-proof-"));
  const snapshotPath = join(directory, "retained.iso");
  try {
    const source = await open(
      imagePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const sourceBefore = await source.stat({ bigint: true });
      if (
        !sourceBefore.isFile() ||
        sourceBefore.size < BigInt(candidateByteCount)
      ) {
        throw new Error("DVD completeness snapshot source is invalid");
      }
      const destination = await open(
        snapshotPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
        const buffer = Buffer.allocUnsafe(SNAPSHOT_BUFFER_BYTES);
        let copied = 0;
        while (copied < candidateByteCount) {
          signal.throwIfAborted();
          if (Date.now() > deadline) {
            throw new Error("DVD completeness snapshot exceeded its time bound");
          }
          const requestedBytes = Math.min(
            buffer.byteLength,
            candidateByteCount - copied,
          );
          const { bytesRead } = await source.read(
            buffer,
            0,
            requestedBytes,
            copied,
          );
          if (bytesRead !== requestedBytes) {
            throw new Error("DVD completeness snapshot source changed");
          }
          let written = 0;
          while (written < bytesRead) {
            const result = await destination.write(
              buffer,
              written,
              bytesRead - written,
              copied + written,
            );
            if (result.bytesWritten <= 0) {
              throw new Error("DVD completeness snapshot write was incomplete");
            }
            written += result.bytesWritten;
          }
          copied += bytesRead;
        }
        await destination.sync();
      } finally {
        await destination.close();
      }
      const sourceAfter = await source.stat({ bigint: true });
      if (!sameFileMetadata(sourceBefore, sourceAfter)) {
        throw new Error("DVD completeness snapshot source changed");
      }
    } finally {
      await source.close();
    }
    const snapshotMetadata = await lstat(snapshotPath, { bigint: true });
    if (snapshotMetadata.size !== BigInt(candidateByteCount)) {
      throw new Error("DVD completeness snapshot is incomplete");
    }
    let disposed = false;
    return {
      async dispose() {
        if (!disposed) {
          disposed = true;
          await rm(directory, { force: true, recursive: true });
        }
      },
      imagePath: snapshotPath,
      async verifyUnchanged() {
        if (
          disposed ||
          !sameFileMetadata(
            snapshotMetadata,
            await lstat(snapshotPath, { bigint: true }),
          )
        ) {
          throw new Error("DVD completeness snapshot changed during validation");
        }
      },
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

function parseClassifierProof(
  payload: string,
  candidateBoundaryLba: number,
): DvdCompletenessProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD completeness classifier returned malformed output");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("protocolVersion" in parsed) ||
    parsed.protocolVersion !== 1 ||
    !("maximumReferencedLba" in parsed) ||
    !Number.isSafeInteger(parsed.maximumReferencedLba) ||
    (parsed.maximumReferencedLba as number) < 0 ||
    (parsed.maximumReferencedLba as number) >= candidateBoundaryLba
  ) {
    throw new Error("DVD completeness classifier returned malformed output");
  }
  return {
    maximumReferencedLba: parsed.maximumReferencedLba as number,
  };
}

export function createNodeDvdCompletenessProver({
  classifierScriptPath = DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH,
  runner = nodeCommandRunner,
  snapshotFactory = createDvdCandidateSnapshot,
}: {
  classifierScriptPath?: string;
  runner?: CommandRunner;
  snapshotFactory?: DvdCandidateSnapshotFactory;
} = {}): DvdCompletenessProver {
  return {
    async prove({
      candidateBoundaryLba,
      expectedTitleMap,
      imagePath,
      signal,
    }) {
      if (
        !Number.isSafeInteger(candidateBoundaryLba) ||
        candidateBoundaryLba <= 0
      ) {
        throw new Error("DVD completeness proof boundary is invalid");
      }
      let candidateByteCount: number;
      try {
        candidateByteCount = requireDvdContentSize(
          candidateBoundaryLba * DVD_SECTOR_SIZE_BYTES,
        );
      } catch {
        throw new Error("DVD completeness proof boundary is invalid");
      }
      const snapshot = await snapshotFactory({
        candidateByteCount,
        imagePath,
        signal,
      });
      try {
        const proof = parseClassifierProof(
          await runDvdLayoutClassifier({
            arguments: [
              "proof",
              snapshot.imagePath,
              String(candidateBoundaryLba),
            ],
            classifierScriptPath,
            failureMessage: "DVD completeness filesystem proof failed",
            runner,
            signal,
          }),
          candidateBoundaryLba,
        );
        await snapshot.verifyUnchanged();
        const observedNavigation = await readDvdNavigation({
          failureMessage: "DVD completeness navigation proof failed",
          imagePath: snapshot.imagePath,
          runner,
          signal,
        });
        await snapshot.verifyUnchanged();
        if (!dvdTitleMapsAgree(expectedTitleMap, observedNavigation.titles)) {
          throw new Error("DVD completeness proof changed the title map");
        }
        return proof;
      } finally {
        await snapshot.dispose();
      }
    },
  };
}
