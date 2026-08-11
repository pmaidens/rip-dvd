import { describe, expect, it } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createEncodingProfilesRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();
const trustedOrigin = "http://localhost";

function mutationRequest({
  method,
  body,
  headers = {},
}: {
  method: "POST" | "PATCH";
  body: string;
  headers?: Record<string, string>;
}): Request {
  return new Request(`${trustedOrigin}/api/encoding-profiles`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Host: "localhost",
      Origin: trustedOrigin,
      ...headers,
    },
    body,
  });
}

const getTrustedOrigin = () => trustedOrigin;

describe("Encoding Profiles API", () => {
  it("creates and lists an active DVD video Encoding Profile", async () => {
    const access = dataAccessFixture.create();
    const createResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: JSON.stringify({
          key: "dvd-library",
          displayName: "DVD library",
          settings: { preset: "Fast 480p30", container: "mkv" },
        }),
      }),
      () => access,
      getTrustedOrigin,
    );

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toEqual({
      profile: expect.objectContaining({
        key: "dvd-library",
        displayName: "DVD library",
        mediaDomain: "dvd_video",
        version: 1,
        isActive: true,
        settings: { preset: "Fast 480p30", container: "mkv" },
      }),
    });

    const listResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles"),
      () => access,
    );
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(await listResponse.json()).toEqual({
      profiles: [
        expect.objectContaining({
          key: "dvd-library",
          mediaDomain: "dvd_video",
          version: 1,
          isActive: true,
        }),
      ],
    });
  });

  it("creates a new immutable version from a DVD video profile", async () => {
    const access = dataAccessFixture.create();
    const versionOne = access.encodingProfiles.create({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });

    const response = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: JSON.stringify({
          sourceProfileId: versionOne.id,
          settings: { preset: "HQ 480p30 Surround", container: "mkv" },
        }),
      }),
      () => access,
      getTrustedOrigin,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      profile: expect.objectContaining({
        key: "dvd-library",
        displayName: "DVD library",
        mediaDomain: "dvd_video",
        version: 2,
        isActive: false,
        settings: { preset: "HQ 480p30 Surround", container: "mkv" },
      }),
    });
    expect(
      access.encodingProfiles.find({
        key: "dvd-library",
        mediaDomain: "dvd_video",
        version: 1,
      }),
    ).toEqual(
      expect.objectContaining({
        id: versionOne.id,
        isActive: true,
        settings: { preset: "Fast 480p30", container: "mkv" },
      }),
    );
  });

  it("activates and deactivates DVD video profile versions", async () => {
    const access = dataAccessFixture.create();
    const versionOne = access.encodingProfiles.create({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const versionTwo = access.encodingProfiles.createVersion({
      sourceProfileId: versionOne.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30 Surround", container: "mkv" },
    });

    const activateResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "PATCH",
        body: JSON.stringify({ id: versionTwo.id, isActive: true }),
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(activateResponse.status).toBe(200);
    expect(await activateResponse.json()).toEqual({
      profile: expect.objectContaining({ id: versionTwo.id, isActive: true }),
    });
    expect(
      access.encodingProfiles.find({
        key: "dvd-library",
        mediaDomain: "dvd_video",
        version: 1,
      }),
    ).toEqual(expect.objectContaining({ id: versionOne.id, isActive: false }));

    const deactivateResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "PATCH",
        body: JSON.stringify({ id: versionTwo.id, isActive: false }),
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(deactivateResponse.status).toBe(200);
    expect(await deactivateResponse.json()).toEqual({
      profile: expect.objectContaining({ id: versionTwo.id, isActive: false }),
    });
  });

  it("rejects invalid settings and cross-domain version requests", async () => {
    const access = dataAccessFixture.create();
    const audioProfile = access.encodingProfiles.create({
      key: "archive-audio",
      displayName: "Archive audio",
      mediaDomain: "audio",
      settings: { codec: "flac" },
    });

    const invalidSettingsResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: JSON.stringify({
          key: "invalid",
          displayName: "Invalid",
          settings: { preset: "Fast 480p30", container: "mp4" },
        }),
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(invalidSettingsResponse.status).toBe(400);

    const invalidPresetResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: JSON.stringify({
          key: "invalid-preset",
          displayName: "Invalid preset",
          settings: { preset: "Not a HandBrake preset", container: "mkv" },
        }),
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(invalidPresetResponse.status).toBe(400);

    const crossDomainResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: JSON.stringify({
          sourceProfileId: audioProfile.id,
          settings: { preset: "Fast 480p30", container: "mkv" },
        }),
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(crossDomainResponse.status).toBe(400);
    expect(
      access.encodingProfiles.list({ mediaDomain: "audio" }),
    ).toHaveLength(1);
  });

  it("rejects cross-origin and non-JSON mutations before parsing input", async () => {
    const access = dataAccessFixture.create();
    const input = JSON.stringify({
      key: "hostile",
      displayName: "Hostile",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });

    const textResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: input,
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(textResponse.status).toBe(415);

    const crossOriginResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
        },
        body: input,
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(crossOriginResponse.status).toBe(403);

    const crossSitePatchResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "PATCH",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ id: "profile-id", isActive: true }),
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(crossSitePatchResponse.status).toBe(403);

    const malformedResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: "{",
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(malformedResponse.status).toBe(400);

    const arrayResponse = await createEncodingProfilesRoute(
      mutationRequest({
        method: "POST",
        body: "[]",
      }),
      () => access,
      getTrustedOrigin,
    );
    expect(arrayResponse.status).toBe(400);
    expect(
      access.encodingProfiles.list({ mediaDomain: "dvd_video" }),
    ).toEqual([]);
  });
});
