import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedCommittedArchiveEvidence } from "../../../../../operator-cli/src/archive-evidence.test-support.js";
import { createArchiveEvidenceRoute } from "./route";

it.each(["clean", "damaged", "long", "historical", "missing"])("matches CLI evidence and paging for %s", async (kind) => {
  const fixture = createOperatorWorkflowFixture();
  const ranges = kind === "long" ? Array.from({ length: 113 }, (_, index) => ({ startLba: index * 2, sectorCount: 1, classification: "skipped_untested" as const })) : kind === "damaged" ? [{ startLba: 8, sectorCount: 64, classification: "skipped_untested" as const }] : [];
  const saved = kind === "historical" ? seedCatalogReviewForReadFixture(fixture) : await seedCommittedArchiveEvidence(fixture, ranges);
  if (kind === "missing" && "directory" in saved) unlinkSync(join(saved.directory, "checkpoint.json"));
  const access = fixture.openAccess();
  try {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "10" });
      const args = ["archive-evidence", saved.archive.id, "--limit", "10"];
      if (cursor !== null) { query.set("cursor", cursor); args.push("--cursor", cursor); }
      const web = await createArchiveEvidenceRoute(new Request(`http://localhost/api/archive-evidence/${saved.archive.id}?${query}`), saved.archive.id, () => access);
      const cli = await fixture.run(args);
      expect(web.status).toBe(200);
      expect(web.headers.get("Cache-Control")).toBe("no-store");
      const body = await web.json();
      expect(cli.result).toEqual(body);
      cursor = body.nextCursor;
    } while (cursor !== null);
  } finally { access.close(); fixture.dispose(); }
});

it("keeps web and CLI evidence reads unavailable throughout a writer interval", async () => {
  const fixture = createOperatorWorkflowFixture();
  const saved = await seedCommittedArchiveEvidence(fixture);
  const access = fixture.openAccess();
  try {
    await defaultArchiveImageOwnership.withWriter({
      archiveId: saved.archive.id,
      imagePath: saved.archive.archivePath,
      initialize: true,
      originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        const web = await createArchiveEvidenceRoute(
          new Request(
            `http://localhost/api/archive-evidence/${saved.archive.id}`,
          ),
          saved.archive.id,
          () => access,
        );
        const cli = await fixture.run(["archive-evidence", saved.archive.id]);
        const body = await web.json();
        expect(web.status).toBe(200);
        expect(cli.exitCode).toBe(0);
        expect(body).toMatchObject({
          available: false,
          unavailableReason: "WRITER_NOT_QUIESCENT",
        });
        expect(cli.result).toEqual(body);
      },
    });
  } finally {
    access.close();
    fixture.dispose();
  }
});

it.each(["limit=0", "limit=101", "cursor=bad", "offset=1", "limit=1&limit=2"])("rejects invalid paging %s", async (query) => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const response = await createArchiveEvidenceRoute(new Request(`http://localhost/api/archive-evidence/synthetic?${query}`), "synthetic", () => access);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  } finally { access.close(); fixture.dispose(); }
});
