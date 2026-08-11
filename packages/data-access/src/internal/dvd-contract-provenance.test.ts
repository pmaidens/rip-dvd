import { describe, expect, it } from "vitest";

import { DVD_TITLE_MAP_SCHEMA_VERSION } from "../dvd-scan.js";
import { DomainInvariantError } from "../errors.js";
import {
  evaluateDetectedDiscRediscovery,
  normalizeDetectedDiscScan,
} from "./dvd-contract-provenance.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const scanData = {
  schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
  contentId: fingerprint,
  titles: [
    {
      number: 1,
      durationSeconds: 1,
      chapters: 1,
      audioStreams: [],
      subtitles: [],
    },
  ],
};

describe("DVD contract and provenance policy", () => {
  it("normalizes only valid DVD scans whose content identity matches", () => {
    expect(
      normalizeDetectedDiscScan({
        discKind: "dvd",
        fingerprint,
        scanData,
      }),
    ).toEqual(scanData);
    expect(() =>
      normalizeDetectedDiscScan({
        discKind: "dvd",
        fingerprint,
        scanData: { ...scanData, contentId: `sha256:${"b".repeat(64)}` },
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      normalizeDetectedDiscScan({
        discKind: "dvd",
        fingerprint,
        scanData: { schemaVersion: 999 },
      }),
    ).toThrow(DomainInvariantError);
  });

  it("rejects a disc kind that contradicts archive or observation provenance", () => {
    expect(() =>
      evaluateDetectedDiscRediscovery({
        discKind: "blu_ray",
        fingerprintObservationDiscKind: "dvd",
        matchingArchive: { detectedDiscId: "disc-1", discKind: "dvd" },
        scanData: undefined,
        volumeLabel: undefined,
      }),
    ).toThrow("existing archive provenance");

    expect(() =>
      evaluateDetectedDiscRediscovery({
        discKind: "blu_ray",
        fingerprintObservationDiscKind: "dvd",
        scanData: undefined,
        volumeLabel: undefined,
      }),
    ).toThrow("existing fingerprint identity");
  });

  it("keeps archived and approved review evidence immutable", () => {
    const existing = {
      id: "disc-1",
      discKind: "dvd" as const,
      scanData,
      status: "archived" as const,
      volumeLabel: null,
    };

    expect(() =>
      evaluateDetectedDiscRediscovery({
        discKind: "dvd",
        existing,
        fingerprintObservationDiscKind: "dvd",
        matchingArchive: { detectedDiscId: "disc-1", discKind: "dvd" },
        scanData: { ...scanData, titles: [] },
        volumeLabel: undefined,
      }),
    ).toThrow("archived scan evidence");

    expect(() =>
      evaluateDetectedDiscRediscovery({
        discKind: "dvd",
        existing: { ...existing, status: "approved" },
        fingerprintObservationDiscKind: "dvd",
        scanData: { ...scanData, titles: [] },
        volumeLabel: undefined,
      }),
    ).toThrow("reviewed data for an approved Detected Disc");
  });

  it("separates observation changes from archive-status reconciliation", () => {
    const existing = {
      id: "disc-1",
      discKind: "dvd" as const,
      scanData,
      status: "detected" as const,
      volumeLabel: null,
    };

    expect(
      evaluateDetectedDiscRediscovery({
        discKind: "dvd",
        existing,
        fingerprintObservationDiscKind: "dvd",
        scanData,
        volumeLabel: undefined,
      }),
    ).toEqual({ observationChanged: false, statusChanged: false });
    expect(
      evaluateDetectedDiscRediscovery({
        discKind: "dvd",
        existing,
        fingerprintObservationDiscKind: "dvd",
        isNewMediumObservation: true,
        matchingArchive: { detectedDiscId: "another-disc", discKind: "dvd" },
        scanData,
        volumeLabel: undefined,
      }),
    ).toEqual({ observationChanged: true, statusChanged: true });
  });
});
