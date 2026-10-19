import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runDvdRecoveryStoragePreflight,
  type DvdRecoveryStoragePreflightDependencies,
  type DvdRecoveryStoragePreflightStage,
} from "./dvd-recovery-storage-preflight.js";

const directories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rip-dvd-storage-preflight-"));
  directories.push(root);
  const imagePath = join(root, "synthetic-archive.iso");
  writeFileSync(imagePath, "previously committed bytes");
  return { root, imagePath };
}

function dependencies(
  options: {
    storageClass?: "local" | "network" | "unknown";
    networkProof?: "verified" | "unproven";
    failAt?: DvdRecoveryStoragePreflightStage;
  } = {},
): DvdRecoveryStoragePreflightDependencies {
  const storageClass = options.storageClass ?? "local";
  const networkProof = options.networkProof ?? "unproven";
  return {
    inspectStorage: () => ({
      filesystemType: storageClass === "local" ? "synthetic-local" :
        storageClass === "network" ? "synthetic-network" : "synthetic-unknown",
      storageClass,
      crossHostWriterExclusion: storageClass === "local"
        ? "not_applicable"
        : networkProof,
      disconnectionBehavior: storageClass === "local"
        ? "not_applicable"
        : networkProof,
    }),
    verifyCrossProcessWriterExclusion: () => undefined,
    beforeStage(stage) {
      if (stage === options.failAt) {
        throw new Error(`Synthetic ${stage} failure`);
      }
    },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DVD Archive Recovery storage preflight", () => {
  it.each([
    { storageClass: "local" as const, networkProof: "unproven" as const },
    { storageClass: "network" as const, networkProof: "verified" as const },
  ])(
    "accepts a synthetic supported $storageClass storage contract",
    ({ storageClass, networkProof }) => {
      const { root, imagePath } = fixture();

      const result = runDvdRecoveryStoragePreflight(
        root,
        dependencies({ storageClass, networkProof }),
      );

      expect(result).toMatchObject({
        contractVersion: "dvd-recovery-storage-preflight-v1",
        status: "supported",
        reasonCode: null,
        facts: {
          storageClass,
          journalReservationBytes: 1_048_576,
          journalReservation: "verified",
          journalSynchronization: "verified",
          imageSynchronization: "verified",
          checkpointSynchronization: "verified",
          checkpointReplacement: "verified",
          directorySynchronization: "verified",
          crossProcessWriterExclusion: "verified",
        },
      });
      expect(readFileSync(imagePath, "utf8")).toBe(
        "previously committed bytes",
      );
      expect(readdirSync(root)).toEqual(["synthetic-archive.iso"]);
    },
  );

  it.each(["network", "unknown"] as const)(
    "reports unproved %s storage as unsupported without calling it unsafe",
    (storageClass) => {
      const { root, imagePath } = fixture();

      const result = runDvdRecoveryStoragePreflight(
        root,
        dependencies({ storageClass }),
      );

      expect(result).toMatchObject({
        status: "unsupported",
        reasonCode: "STORAGE_UNSUPPORTED",
        facts: {
          storageClass,
          journalReservation: "not_tested",
          crossProcessWriterExclusion: "not_tested",
        },
      });
      expect(readFileSync(imagePath, "utf8")).toBe(
        "previously committed bytes",
      );
      expect(readdirSync(root)).toEqual(["synthetic-archive.iso"]);
    },
  );

  it.each([
    ["journal_reservation", "JOURNAL_RESERVATION_FAILED"],
    ["journal_sync", "JOURNAL_SYNC_FAILED"],
  ] as const)(
    "keeps the archive untouched when %s fails",
    (failAt, reasonCode) => {
      const { root, imagePath } = fixture();

      const result = runDvdRecoveryStoragePreflight(
        root,
        dependencies({ failAt }),
      );

      expect(result).toMatchObject({
        status: "failed_prerequisite",
        reasonCode,
      });
      expect(result.reasonCode).not.toContain("UNRECOVERED");
      expect(readFileSync(imagePath, "utf8")).toBe(
        "previously committed bytes",
      );
      expect(readdirSync(root)).toEqual(["synthetic-archive.iso"]);
    },
  );
});
