import { describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createFilesystemVerificationRoute } from "./route";

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
  return { access, archive, job };
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
