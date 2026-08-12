import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker,
  type OpticalDriveHardware,
} from "../../archive-worker/src/archive-worker.js";

import type { DashboardSnapshot } from "../lib/dashboard";
import {
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../test/data-access-fixture";
import { createDashboardResponse } from "../app/api/dashboard/route";
import { DashboardView } from "./operations-dashboard";

const dataAccessFixture = useDataAccessFixture();

describe("database-backed dashboard over HTTP", () => {
  it("renders persisted discovery and scan results including an already archived match", async () => {
    const access = dataAccessFixture.create();
    const hardware: OpticalDriveHardware = {
      bindOpticalDrive: vi.fn(async (drive, signal) => {
        signal.throwIfAborted();
        return { deviceInstanceToken: "mock-device-instance", drive };
      }),
      confirmOpticalDrive: vi.fn(async (_binding, signal) => {
        signal.throwIfAborted();
      }),
      observeMediaGeneration: vi.fn().mockResolvedValue("dashboard-generation"),
      discover: vi.fn().mockResolvedValue([
        {
          devicePath: "/dev/sr0",
          displayName: "Mocked Optical Drive",
          vendor: "Pioneer",
          product: "DVD-RW",
          serialNumber: "MOCK-001",
        },
      ]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint:
          "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        volumeLabel: "MOCKED_DISC",
        scanData: {
          schemaVersion: 2,
          contentId:
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          titles: [
            {
              number: 7,
              durationSeconds: 3_723,
              chapters: 9,
              audioStreams: [
                {
                  id: 128,
                  languageCode: "en",
                  language: "English",
                  format: "ac3",
                  channels: 6,
                },
              ],
              subtitles: [
                {
                  id: 32,
                  languageCode: "fr",
                  language: "Francais",
                  content: "Normal",
                },
              ],
            },
          ],
        },
      }),
    };
    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
    });
    const disc = access.catalog.listDetectedDiscs()[0];
    expect(disc).toMatchObject({
      status: "scanned",
      fingerprint:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Mocked Disc.iso",
      fingerprint: disc!.fingerprint,
    });

    const response = createDashboardResponse(access);
    const dashboard = (await response.json()) as DashboardSnapshot;
    const html = renderToStaticMarkup(<DashboardView state={dashboard} />);

    expect(access.archiveJobs.list()).toEqual([]);
    expect(html).toContain("Mocked Optical Drive");
    expect(html).toContain("MOCKED_DISC");
    expect(html).toContain("Already archived");
    expect(html).toContain("Title 7");
    expect(html).toContain("1h 2m 3s");
    expect(html).toContain("9 chapters · 1 audio · 1 subtitle");
    expect(html).toContain("English · ac3 · 6 channels · 0x80");
    expect(html).toContain("Francais · Normal · 0x20");
    expect(html).toContain(
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    );
    expect(hardware.discover).toHaveBeenCalledTimes(4);
    expect(hardware.scanDvd).toHaveBeenCalledOnce();
  });

  it("renders mixed populated and empty sections from the serialized response", async () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      vendor: "Pioneer",
      product: "BDR-XD08",
      isEnabled: true,
      isPresent: true,
    });

    const response = createDashboardResponse(access);
    const dashboard = (await response.json()) as DashboardSnapshot;
    const html = renderToStaticMarkup(<DashboardView state={dashboard} />);

    expect(response.status).toBe(200);
    expect(html.match(/data-state="populated"/g)).toHaveLength(1);
    expect(html.match(/data-state="empty"/g)).toHaveLength(4);
    expect(html).toContain("Archive drive");
    expect(html).toContain("Pioneer BDR-XD08");
    expect(html).toContain("No Detected Discs are currently known.");
    expect(html).not.toContain("/dev/sr0");
  });

  it("renders a dependency outage as a section error after HTTP serialization", async () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Healthy drive",
      isEnabled: true,
      isPresent: true,
    });

    const response = createDashboardResponse(withSnapshotOverrides(access, {
      encodingProfiles: {
        list() {
          throw new Error("profile catalog unavailable");
        },
      },
    }));
    const dashboard = (await response.json()) as DashboardSnapshot;
    const html = renderToStaticMarkup(<DashboardView state={dashboard} />);

    expect(response.status).toBe(200);
    expect(dashboard.encodeJobs).toEqual({ status: "error" });
    expect(dashboard.opticalDrives.status).toBe("loaded");
    expect(html.match(/data-state="error"/g)).toHaveLength(1);
    expect(html).toContain("Current state is unavailable.");
    expect(html).not.toContain("Unknown Encoding Profile");
  });
});
