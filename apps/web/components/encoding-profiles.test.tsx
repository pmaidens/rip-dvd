import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EncodingProfilesView } from "./encoding-profiles";

describe("EncodingProfilesView", () => {
  it("shows version, active state, media domain, key settings, and management actions", () => {
    const html = renderToStaticMarkup(
      <EncodingProfilesView
        state={{
          status: "loaded",
          profiles: [
            {
              id: "profile-1",
              key: "dvd-library",
              displayName: "DVD library",
              mediaDomain: "dvd_video",
              version: 1,
              isActive: true,
              settings: { preset: "Fast 480p30", container: "mkv" },
            },
            {
              id: "profile-2",
              key: "dvd-library",
              displayName: "DVD library",
              mediaDomain: "dvd_video",
              version: 2,
              isActive: false,
              settings: { preset: "HQ 480p30", container: "mkv" },
            },
          ],
        }}
        versionSourceId={null}
        isSaving={false}
        onSave={() => undefined}
        onCreateVersion={() => undefined}
        onCancelVersion={() => undefined}
        onSetActive={() => undefined}
      />,
    );

    expect(html).toContain("Encoding Profiles");
    expect(html).toContain("DVD library");
    expect(html).toContain("DVD video");
    expect(html).toContain("Version 1");
    expect(html).toContain("Version 2");
    expect(html).toContain("Active");
    expect(html).toContain("Inactive");
    expect(html).toContain("Fast 480p30");
    expect(html).toContain("HQ 480p30");
    expect(html).toContain("MKV");
    expect(html).toContain("Create profile");
    expect(html).toContain("Create new version");
    expect(html).toContain("Deactivate");
    expect(html).toContain("Activate");
  });
});
