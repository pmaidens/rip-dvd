import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../lib/dashboard";
import { useDataAccessFixture } from "../test/data-access-fixture";
import { createDashboardResponse } from "../app/api/dashboard/route";
import { DashboardView } from "./operations-dashboard";

const dataAccessFixture = useDataAccessFixture();

describe("database-backed dashboard over HTTP", () => {
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
});
