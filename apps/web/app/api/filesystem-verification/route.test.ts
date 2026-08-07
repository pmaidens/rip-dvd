import { describe, expect, it, vi } from "vitest";

import { readDashboardSnapshot } from "../../../lib/dashboard";
import { useDataAccessFixture } from "../../../test/data-access-fixture";
import {
  createFilesystemVerificationInventoryRoute,
  createFilesystemVerificationRoute,
} from "./route";

const dataAccessFixture = useDataAccessFixture();

function createVerificationRecords() {
  const access = dataAccessFixture.create();
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: "api-verification",
    volumeLabel: "API_VERIFICATION_DISC",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: "/media/originals/API Verification.iso",
    fingerprint: disc.fingerprint,
  });
  const mediaItem = access.catalog.createMediaItem({
    kind: "movie",
    title: "API Verification",
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: mediaItem.id,
    kind: "main_feature",
  });
  access.catalog.completeCatalogReview(archive.id);
  const profile = access.encodingProfiles.create({
    key: "api-verification",
    displayName: "API verification",
    mediaDomain: "dvd_video",
    settings: {},
  });
  const job = access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: "/media/movies/API Verification.mkv",
  });
  return { access, archive, job, selection };
}

function verificationRequest(target: string, id: string) {
  return new Request("http://localhost:3000/api/filesystem-verification", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ target, id }),
  });
}

describe("Filesystem Verification API", () => {
  it("pages every Encode Job output beyond the operations history cap with a usable identity", async () => {
    const { access, job, selection } = createVerificationRecords();
    const jobs = [job];
    for (let index = 0; index < 21; index += 1) {
      const profile = access.encodingProfiles.create({
        key: `verification-history-${index}`,
        displayName: `Verification history ${index}`,
        mediaDomain: "dvd_video",
        settings: { index },
      });
      jobs.push(
        access.encodeJobs.enqueue({
          discSelectionId: selection.id,
          encodingProfileId: profile.id,
          outputPath: `/media/movies/Verification History ${index}.mkv`,
        }),
      );
    }
    for (;;) {
      const claim = access.encodeJobs.claimNext("verification-history-worker");
      if (!claim) {
        break;
      }
      access.encodeJobs.fail(claim, "historical fixture");
    }
    const dashboard = readDashboardSnapshot(access, { activityLimit: 20 });
    expect(dashboard.encodeJobs.status).toBe("loaded");
    const dashboardIds =
      dashboard.encodeJobs.status === "loaded"
        ? dashboard.encodeJobs.items.map(({ id }) => id)
        : [];
    const hiddenJob = jobs.find(({ id }) => !dashboardIds.includes(id));
    expect(hiddenJob).toBeDefined();
    const hiddenProfile = access.encodingProfiles.list({
      ids: [hiddenJob!.encodingProfileId],
    })[0]!;

    const response = createFilesystemVerificationInventoryRoute(
      new Request(
        "http://localhost:3000/api/filesystem-verification?target=encode_job_output&offset=20",
      ),
      () => access,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.inventory).toMatchObject({
      target: "encode_job_output",
      page: {
        offset: 20,
        limit: 20,
        hasPrevious: true,
        hasNext: false,
      },
    });
    expect(body.inventory.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: hiddenJob!.id,
          target: "encode_job_output",
          mediaTitle: "API Verification",
          mediaYear: null,
          encodingProfileName: `${hiddenProfile.displayName} · Version ${hiddenProfile.version}`,
          jobStatus: "failed",
          updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ]),
    );
    expect(
      new Set(
        body.inventory.items.map(
          (item: { encodingProfileName: string }) => item.encodingProfileName,
        ),
      ).size,
    ).toBe(body.inventory.items.length);
    expect(JSON.stringify(body)).not.toContain("/media/");
  });

  it("keeps reviewed Original Disc Archives distinguishable in the verification inventory", async () => {
    const { access, archive } = createVerificationRecords();
    const drive = access.catalog.listOpticalDrives()[0]!;
    const secondDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "second-reviewed-verification",
      volumeLabel: "SECOND_REVIEWED_DISC",
    });
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "approved");
    const secondArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: secondDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Second Reviewed Verification.iso",
      fingerprint: secondDisc.fingerprint,
    });
    const secondMediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Second Reviewed Verification",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: secondArchive.id,
      mediaItemId: secondMediaItem.id,
      kind: "main_feature",
    });
    access.catalog.completeCatalogReview(secondArchive.id);
    const dashboard = readDashboardSnapshot(access, { activityLimit: 20 });
    expect(dashboard.catalogReview).toEqual({ status: "loaded", items: [] });

    const response = createFilesystemVerificationInventoryRoute(
      new Request(
        "http://localhost:3000/api/filesystem-verification?target=original_disc_archive&offset=0",
      ),
      () => access,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.inventory.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "original_disc_archive",
          id: archive.id,
          discLabel: "API_VERIFICATION_DISC",
          discKind: "dvd",
          archiveFormat: "iso",
          archivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          status: null,
          message: null,
          verifiedAt: null,
        }),
        expect.objectContaining({
          target: "original_disc_archive",
          id: secondArchive.id,
          discLabel: "SECOND_REVIEWED_DISC",
        }),
      ]),
    );
    expect(
      new Set(
        body.inventory.items.map(
          (item: { discLabel: string }) => item.discLabel,
        ),
      ).size,
    ).toBe(body.inventory.items.length);
    expect(JSON.stringify(body)).not.toContain("/media/");
  });

  it("explicitly verifies archive and Encode Job paths without exposing them", async () => {
    const { access, archive, job } = createVerificationRecords();

    const archiveResponse = await createFilesystemVerificationRoute(
      verificationRequest("original_disc_archive", archive.id),
      () => access,
      () => "http://localhost:3000",
    );
    const jobResponse = await createFilesystemVerificationRoute(
      verificationRequest("encode_job_output", job.id),
      () => access,
      () => "http://localhost:3000",
    );

    expect(archiveResponse.status).toBe(200);
    expect(jobResponse.status).toBe(200);
    const archiveBody = await archiveResponse.json();
    const jobBody = await jobResponse.json();
    expect(archiveBody).toEqual({
      verification: {
        target: "original_disc_archive",
        id: archive.id,
        status: "missing",
        message: "File is missing at the recorded path.",
        verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(jobBody).toEqual({
      verification: {
        target: "encode_job_output",
        id: job.id,
        status: "missing",
        message: "File is missing at the recorded path.",
        verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(JSON.stringify([archiveBody, jobBody])).not.toContain("/media/");
  });

  it.each([
    {
      name: "a hostile Origin with the trusted Host",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://attacker.example",
      },
      status: 403,
    },
    {
      name: "a missing Origin",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
      },
      status: 403,
    },
    {
      name: "a hostile Host with the trusted Origin",
      headers: {
        "Content-Type": "application/json",
        Host: "attacker.example",
        Origin: "http://localhost:3000",
      },
      status: 403,
    },
    {
      name: "a missing Host",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      status: 403,
    },
    {
      name: "a cross-site fetch",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
        "Sec-Fetch-Site": "cross-site",
      },
      status: 403,
    },
    {
      name: "a non-JSON request",
      headers: {
        "Content-Type": "text/plain",
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
      },
      status: 415,
    },
  ] satisfies Array<{
    name: string;
    headers: Record<string, string>;
    status: number;
  }>)("rejects $name before opening data access", async ({ headers, status }) => {
    const getAccess = vi.fn();
    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) {
        requestHeaders.set(name, value);
      }
    }
    const response = await createFilesystemVerificationRoute(
      new Request("http://localhost:3000/api/filesystem-verification", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          target: "original_disc_archive",
          id: "archive-id",
        }),
      }),
      getAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(status);
    expect(getAccess).not.toHaveBeenCalled();
  });
});
