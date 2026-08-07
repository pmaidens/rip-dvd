import { describe, expect, it, vi } from "vitest";

import {
  createBoundedFilesystemPathProbe,
  type FilesystemProbeHelper,
} from "./bounded-filesystem-path-probe.js";

describe("bounded filesystem path probe", () => {
  it("times out an isolated helper while keeping admission bounded until it exits", async () => {
    vi.useFakeTimers();
    let settleHelper!: () => void;
    const helperResult = new Promise<"file">((resolve) => {
      settleHelper = () => resolve("file");
    });
    const helper: FilesystemProbeHelper = {
      result: helperResult,
      terminate: vi.fn(),
    };
    const startHelper = vi.fn(() => helper);
    const probe = createBoundedFilesystemPathProbe({
      maxConcurrent: 1,
      timeoutMs: 100,
      startHelper,
    });

    const timedOut = probe.inspect("/library/movie.mkv", "/library");
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    await vi.advanceTimersByTimeAsync(100);
    await timedOutExpectation;
    expect(helper.terminate).toHaveBeenCalledOnce();

    await expect(
      probe.inspect("/library/second.mkv", "/library"),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(startHelper).toHaveBeenCalledOnce();

    settleHelper();
    await vi.runAllTimersAsync();
    await expect(
      probe.inspect("/library/after-close.mkv", "/library"),
    ).resolves.toBe("file");
    expect(startHelper).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
