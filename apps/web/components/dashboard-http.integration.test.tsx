import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OpticalDriveHardware } from "../../archive-worker/src/archive-worker.js";

import type { DashboardSnapshot } from "../lib/dashboard";
import { investigationReport } from "../lib/investigation";
import {
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../test/data-access-fixture";
import {
  pollArchiveWorkerForTest as pollArchiveWorker,
  startArchiveJob,
} from "../test/archive-job-fixture";
import { createDashboardResponse } from "../app/api/dashboard/route";
import { InvestigationPanel } from "./investigation-panel";
import { DashboardView } from "./operations-dashboard";

const dataAccessFixture = useDataAccessFixture();

describe("database-backed dashboard over HTTP", () => {
  it("carries safe Archive Job evidence through HTTP into the shared investigation panel and report", async () => {
    const { access, databasePath } =
      dataAccessFixture.createWithDatabasePath();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/private-optical-drive",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "http-investigation-disc",
      volumeLabel: "HTTP_INVESTIGATION_DISC",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const job = startArchiveJob(
      access,
      disc,
      "raw-output /srv/private.iso --arg ENV=x claim=x",
      8_192,
    );
    access.archiveJobs.updateProgress(job, {
      phase: "copying",
      progressPercent: 50,
      progressBytes: 4_096,
    });
    access.archiveJobs.failWithReadFailure(job, {
      stage: "initial_copy",
      category: "hardware_error",
      classifierVersion: "scsi-read-classifier-v1",
      failingLba: 2,
      requestedBlockCount: 8,
      retryCount: 1,
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseKey: 4,
      asc: 68,
      ascq: 0,
    });

    const response = createDashboardResponse(access);
    const dashboard = (await response.json()) as DashboardSnapshot;
    const serialized = JSON.stringify(dashboard);
    const projectedJob = dashboard.archiveJobs.status === "loaded"
      ? dashboard.archiveJobs.items.find(({ id }) => id === job.id)
      : undefined;
    expect(projectedJob?.investigation).toMatchObject({
      incidentId: `archive-job-failure:${job.id}`,
      attempt: 1,
      reasonCode: "archive_read.hardware_error",
      failedPhase: "Copying",
      retryability: "appropriate",
      explanation: "The Optical Drive reported a hardware fault.",
      technicalEvidence: expect.arrayContaining([
        { label: "Read stage", value: "Initial copy" },
        { label: "Failing LBA", value: "2" },
        { label: "Requested block count", value: "8" },
        { label: "SCSI status", value: "2" },
        { label: "Sense key", value: "4" },
        { label: "ASC", value: "68" },
      ]),
    });
    for (const secret of [
      "/dev/private-optical-drive",
      "/srv/private.iso",
      databasePath,
      "raw-output",
      "--arg",
      "ENV=x",
      "claim=x",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const dashboardHtml = renderToStaticMarkup(
      <DashboardView state={dashboard} />,
    );
    const investigation = projectedJob!.investigation!;
    const panelHtml = renderToStaticMarkup(
      <InvestigationPanel
        investigation={investigation}
        returnFocusTo={null}
        onClose={() => undefined}
      />,
    );
    const copiedReport = investigationReport(investigation);
    expect(dashboardHtml).toContain("HTTP_INVESTIGATION_DISC");
    expect(dashboardHtml).toContain("Investigate");
    expect(panelHtml).toContain(`archive-job-failure:${job.id}`);
    expect(panelHtml).toContain("hardware fault");
    expect(panelHtml).toContain("Failing LBA");
    expect(panelHtml).toContain(">2<");
    expect(copiedReport).toContain(`Incident identifier: archive-job-failure:${job.id}`);
    expect(copiedReport).toContain("- Failing LBA: 2");
    expect(copiedReport).toContain(
      "Suggested action: Retry the Archive Request once.",
    );
    for (const secret of [
      "/dev/private-optical-drive",
      "/srv/private.iso",
      databasePath,
      "raw-output",
      "--arg",
      "ENV=x",
      "claim=x",
    ]) {
      expect(dashboardHtml).not.toContain(secret);
      expect(panelHtml).not.toContain(secret);
      expect(copiedReport).not.toContain(secret);
    }
  });

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
      observeMedia: vi.fn().mockResolvedValue({
        mediaGeneration: "dashboard-generation",
        capacityBytes: 2_048,
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
    expect(hardware.discover).toHaveBeenCalledTimes(6);
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
    expect(html).toContain("No discs are currently in an Optical Drive.");
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
