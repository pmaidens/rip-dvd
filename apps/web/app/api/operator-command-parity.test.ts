import { expect, it } from "vitest";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import type { CatalogMetadataLookup } from "@rip-dvd/application";

import { createOperatorWorkflowFixture } from "../../../operator-cli/src/operator-workflow.test-support.js";
import { createCatalogReviewRoute } from "./catalog-reviews/[id]/route";
import { createCatalogSuggestionRoute } from "./catalog-reviews/[id]/suggestion/route";
import { createDeploymentReadinessResponse } from "./deployment-readiness/route";
import { createHealthResponse } from "./health/route";

it("returns the same health and readiness results through web and CLI adapters", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const healthResponse = createHealthResponse(access);
    const readinessResponse = createDeploymentReadinessResponse(access);

    expect(healthResponse.status).toBe(200);
    expect(readinessResponse.status).toBe(200);
    expect(healthResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(readinessResponse.headers.get("Cache-Control")).toBe("no-store");
    expect((await fixture.run(["health"])).result).toEqual(await healthResponse.json());
    expect((await fixture.run(["readiness"])).result).toEqual(await readinessResponse.json());
  } finally {
    access.close();
    fixture.dispose();
  }
});

it("returns the same Catalog Review detail and candidates through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const seed = createLegacySidecarDataAccess({
    databasePath: fixture.databasePath,
    mediaLibraryPath: fixture.mediaLibraryPath,
    originalsLibraryPath: fixture.originalsLibraryPath,
  });
  const drive = seed.catalog.upsertOpticalDrive({ devicePath: "/dev/synthetic-parity", isPresent: true });
  const contentId = `sha256:${"b".repeat(64)}`;
  const disc = seed.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    volumeLabel: "EXAMPLE_FILM_2020",
    scanData: {
      schemaVersion: 2,
      contentId,
      titles: [{ number: 1, durationSeconds: 5_400, chapters: 12, audioStreams: [], subtitles: [] }],
    },
  });
  seed.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  seed.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = seed.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: "/media/originals/example-film-parity.iso",
    fingerprint: contentId,
  });
  seed.close();
  const access = fixture.openAccess();
  const lookup: CatalogMetadataLookup = {
    search: async () => [{ id: 42, kind: "movie", title: "Example Film", year: 2020 }],
    getTvDetails: async () => ({ seasons: [] }),
    getTvSeason: async () => { throw new Error("Unexpected season request"); },
  };
  try {
    const detail = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
      undefined,
      () => false,
    );
    expect(detail.status).toBe(200);
    expect((await fixture.run(["catalog-review", "show", archive.id])).result).toEqual(await detail.json());

    const suggestion = await createCatalogSuggestionRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`),
      archive.id,
      () => access,
      () => lookup,
    );
    expect(suggestion.status).toBe(200);
    expect((await fixture.run(["catalog-review", "suggest", archive.id], lookup)).result)
      .toEqual(await suggestion.json());
    expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toEqual([]);
  } finally {
    access.close();
    fixture.dispose();
  }
});
