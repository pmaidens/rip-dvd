import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createEncodingProfilesRoute } from "../app/api/encoding-profiles/route";
import type { EncodingProfileDto } from "../lib/encoding-profiles";
import { useDataAccessFixture } from "../test/data-access-fixture";
import { EncodingProfilesView } from "./encoding-profiles";

const dataAccessFixture = useDataAccessFixture();

describe("database-backed Encoding Profiles over HTTP", () => {
  it("renders active and inactive profile versions from the serialized API response", async () => {
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
      settings: { preset: "HQ 480p30", container: "mkv" },
    });
    access.encodingProfiles.setActive({
      id: versionTwo.id,
      mediaDomain: "dvd_video",
      isActive: true,
    });

    const response = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles"),
      () => access,
    );
    const body = (await response.json()) as {
      profiles: EncodingProfileDto[];
    };
    const html = renderToStaticMarkup(
      <EncodingProfilesView
        state={{ status: "loaded", profiles: body.profiles }}
        versionSourceId={null}
        isSaving={false}
        hasRequestError={false}
        onSave={() => undefined}
        onCreateVersion={() => undefined}
        onCancelVersion={() => undefined}
        onRetry={() => undefined}
        onSetActive={() => undefined}
      />,
    );

    expect(response.status).toBe(200);
    expect(html).toContain("Version 1");
    expect(html).toContain("Version 2");
    expect(html).toContain("Fast 480p30");
    expect(html).toContain("HQ 480p30");
    expect(html).toContain("Inactive");
    expect(html).toContain("Active");
    expect(html).toContain("DVD video");
  });

  it("renders a migrated DVD preset even when legacy settings have no container", async () => {
    const access = dataAccessFixture.create();
    const legacyProfile = access.encodingProfiles.create({
      key: "legacy-library",
      displayName: "Legacy DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Legacy Fast 480p30" },
    });

    const response = await createEncodingProfilesRoute(
      new Request("http://localhost/api/encoding-profiles"),
      () => access,
    );
    const body = (await response.json()) as {
      profiles: EncodingProfileDto[];
    };
    const html = renderToStaticMarkup(
      <EncodingProfilesView
        state={{ status: "loaded", profiles: body.profiles }}
        versionSourceId={legacyProfile.id}
        isSaving={false}
        hasRequestError={false}
        onSave={() => undefined}
        onCreateVersion={() => undefined}
        onCancelVersion={() => undefined}
        onRetry={() => undefined}
        onSetActive={() => undefined}
      />,
    );

    expect(response.status).toBe(200);
    expect(html).toContain("Legacy Fast 480p30");
    expect(html).toContain('value="Legacy Fast 480p30"');
  });
});
