import { describe, expect, it, vi } from "vitest";

import { createBoundOpticalDriveIdentity } from "./optical-drive-identity.js";
import { createOpticalDriveDvdScanner } from "./optical-drive-dvd-scanner.js";
import { createOpticalDriveScanCache } from "./optical-drive-scan-cache.js";

describe("Optical Drive DVD scan coordinator", () => {
  it("reuses a stable cached scan as an existing medium observation", async () => {
    const contentId = `sha256:${"c".repeat(64)}`;
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: [
            "Disc Title: CACHED_DISC",
            "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
          ].join("\n"),
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "1024\n",
          stderr: "",
        }),
    };
    const contentReader = { hash: vi.fn().mockResolvedValue(contentId) };
    const identity = createBoundOpticalDriveIdentity({
      observe: vi.fn().mockResolvedValue("instance-17"),
    });
    const scanner = createOpticalDriveDvdScanner({
      cache: createOpticalDriveScanCache(),
      contentReader,
      identity,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("generation-17"),
      },
      runner,
    });
    const signal = new AbortController().signal;
    const binding = await identity.bind({ devicePath: "/dev/sr0" }, signal);

    const first = await scanner.scan(binding, signal);
    const repeated = await scanner.scan(binding, signal);

    expect(first).toMatchObject({
      fingerprint: contentId,
      isNewMediumObservation: true,
    });
    expect(repeated).toEqual({
      ...first,
      isNewMediumObservation: false,
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(contentReader.hash).toHaveBeenCalledOnce();
  });
});
