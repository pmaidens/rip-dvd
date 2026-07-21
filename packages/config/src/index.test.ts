import { describe, expect, it } from "vitest";

import { loadConfig } from "./index.js";

const requiredEnvironment = {
  RIP_DVD_DATABASE_PATH: "/data/rip-dvd.sqlite",
  RIP_DVD_MEDIA_LIBRARY_PATH: "/media/movies",
  RIP_DVD_ORIGINALS_LIBRARY_PATH: "/media/originals",
};

describe("loadConfig", () => {
  it("loads required paths and applies worker defaults", () => {
    expect(loadConfig(requiredEnvironment)).toEqual({
      databasePath: "/data/rip-dvd.sqlite",
      mediaLibraryPath: "/media/movies",
      originalsLibraryPath: "/media/originals",
      archiveDevicePath: "/dev/sr0",
      workerPollIntervalMs: 5_000,
      archiveWorkerConcurrency: 1,
      encodeWorkerConcurrency: 1,
    });
  });

  it("accepts explicit device and worker settings", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        RIP_DVD_ARCHIVE_DEVICE_PATH: "/dev/dvd",
        RIP_DVD_WORKER_POLL_INTERVAL_MS: "10000",
        RIP_DVD_ARCHIVE_WORKER_CONCURRENCY: "2",
        RIP_DVD_ENCODE_WORKER_CONCURRENCY: "3",
      }),
    ).toMatchObject({
      archiveDevicePath: "/dev/dvd",
      workerPollIntervalMs: 10_000,
      archiveWorkerConcurrency: 2,
      encodeWorkerConcurrency: 3,
    });
  });

  it("accepts Node's maximum timer delay for worker polling", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        RIP_DVD_WORKER_POLL_INTERVAL_MS: "2147483647",
      }).workerPollIntervalMs,
    ).toBe(2_147_483_647);
  });

  it.each(["2147483648", "9007199254740991"])(
    "rejects worker poll delays that overflow Node timers (%s)",
    (value) => {
      expect(() =>
        loadConfig({
          ...requiredEnvironment,
          RIP_DVD_WORKER_POLL_INTERVAL_MS: value,
        }),
      ).toThrow(
        "RIP_DVD_WORKER_POLL_INTERVAL_MS must be at most 2147483647",
      );
    },
  );

  it.each([
    "RIP_DVD_DATABASE_PATH",
    "RIP_DVD_MEDIA_LIBRARY_PATH",
    "RIP_DVD_ORIGINALS_LIBRARY_PATH",
  ])("rejects a missing required value for %s", (name) => {
    const environment = { ...requiredEnvironment, [name]: " " };

    expect(() => loadConfig(environment)).toThrow(
      `Missing required environment variable: ${name}`,
    );
  });

  it.each([
    ["RIP_DVD_WORKER_POLL_INTERVAL_MS", "0"],
    ["RIP_DVD_ARCHIVE_WORKER_CONCURRENCY", "1.5"],
    ["RIP_DVD_ENCODE_WORKER_CONCURRENCY", "many"],
  ])("rejects an invalid positive integer for %s", (name, value) => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, [name]: value }),
    ).toThrow(`${name} must be a positive integer`);
  });
});
