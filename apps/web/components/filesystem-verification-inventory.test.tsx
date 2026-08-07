import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FilesystemVerificationInventoryView,
  requestFilesystemVerificationInventory,
} from "./filesystem-verification-inventory";

describe("FilesystemVerificationInventory", () => {
  it("keeps an Encode Job beyond the operations cap explicitly verifiable", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        inventory: {
          target: "encode_job_output",
          items: [],
          page: {
            offset: 20,
            limit: 20,
            hasPrevious: true,
            hasNext: false,
          },
        },
      }),
    );

    await requestFilesystemVerificationInventory(
      "encode_job_output",
      20,
      fetcher,
    );
    const html = renderToStaticMarkup(
      <FilesystemVerificationInventoryView
        encodeOutputs={{
          status: "loaded",
          items: [
            {
              target: "encode_job_output",
              id: "encode-job-beyond-dashboard-cap",
              mediaTitle: "Hidden Film",
              mediaYear: 2004,
              encodingProfileName: "DVD archive · Version 3",
              jobStatus: "failed",
              updatedAt: "2026-08-06T23:45:00.000Z",
              status: null,
              message: null,
              verifiedAt: null,
            },
          ],
          page: {
            offset: 20,
            limit: 20,
            hasPrevious: true,
            hasNext: false,
          },
        }}
        originalArchives={{
          status: "loaded",
          items: [],
          page: {
            offset: 0,
            limit: 20,
            hasPrevious: false,
            hasNext: false,
          },
        }}
      />,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/filesystem-verification?target=encode_job_output&offset=20",
      { cache: "no-store" },
    );
    expect(html).toContain("encode-job-beyond-dashboard-cap");
    expect(html).toContain("Hidden Film (2004)");
    expect(html).toContain("DVD archive · Version 3");
    expect(html).toContain("Failed");
    expect(html).toContain("Updated Aug 6, 2026");
    expect(html).toContain("Verify output file");
    expect(html).toContain("Previous outputs");
    expect(html).not.toContain("/media/");
  });

  it("keeps a reviewed Original Disc Archive explicitly verifiable", () => {
    const html = renderToStaticMarkup(
      <FilesystemVerificationInventoryView
        encodeOutputs={{
          status: "loaded",
          items: [],
          page: {
            offset: 0,
            limit: 20,
            hasPrevious: false,
            hasNext: false,
          },
        }}
        originalArchives={{
          status: "loaded",
          items: [
            {
              target: "original_disc_archive",
              id: "reviewed-original-archive",
              discLabel: "REVIEWED_DISC",
              discKind: "dvd",
              archiveFormat: "iso",
              archivedAt: "2026-08-05T18:15:00.000Z",
              status: "accessible",
              message: "File is accessible.",
              verifiedAt: "2026-08-07T02:30:00.000Z",
            },
          ],
          page: {
            offset: 0,
            limit: 20,
            hasPrevious: false,
            hasNext: false,
          },
        }}
      />,
    );

    expect(html).toContain("reviewed-original-archive");
    expect(html).toContain("REVIEWED_DISC");
    expect(html).toContain("DVD · ISO");
    expect(html).toContain("Archived Aug 5, 2026");
    expect(html).toContain("Verify archive file");
    expect(html).toContain("File is accessible.");
    expect(html).not.toContain("Review catalog");
  });
});
