import { describe, expect, it } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createEncodingProfilesRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

describe("Encoding Profiles API", () => {
  it("creates and lists an active DVD video Encoding Profile", async () => {
    const access = dataAccessFixture.create();
    const createResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "dvd-library",
          displayName: "DVD library",
          settings: { preset: "Fast 480p30", container: "mkv" },
        }),
      }),
      () => access,
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
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceProfileId: versionOne.id,
          settings: { preset: "HQ 480p30 Surround", container: "mkv" },
        }),
      }),
      () => access,
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
      new Request("http://localhost/api/encoding-profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: versionTwo.id, isActive: true }),
      }),
      () => access,
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
      new Request("http://localhost/api/encoding-profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: versionTwo.id, isActive: false }),
      }),
      () => access,
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
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "invalid",
          displayName: "Invalid",
          settings: { preset: "Fast 480p30", container: "mp4" },
        }),
      }),
      () => access,
    );
    expect(invalidSettingsResponse.status).toBe(400);

    const invalidPresetResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "invalid-preset",
          displayName: "Invalid preset",
          settings: { preset: "Not a HandBrake preset", container: "mkv" },
        }),
      }),
      () => access,
    );
    expect(invalidPresetResponse.status).toBe(400);

    const crossDomainResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceProfileId: audioProfile.id,
          settings: { preset: "Fast 480p30", container: "mkv" },
        }),
      }),
      () => access,
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
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: "http://localhost",
        },
        body: input,
      }),
      () => access,
    );
    expect(textResponse.status).toBe(415);

    const crossOriginResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body: input,
      }),
      () => access,
    );
    expect(crossOriginResponse.status).toBe(403);

    const crossSitePatchResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ id: "profile-id", isActive: true }),
      }),
      () => access,
    );
    expect(crossSitePatchResponse.status).toBe(403);

    const malformedResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      () => access,
    );
    expect(malformedResponse.status).toBe(400);

    const arrayResponse = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      }),
      () => access,
    );
    expect(arrayResponse.status).toBe(400);
    expect(
      access.encodingProfiles.list({ mediaDomain: "dvd_video" }),
    ).toEqual([]);
  });
});
