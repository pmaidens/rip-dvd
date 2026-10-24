import { expect, it, vi } from "vitest";

import { createNodeDvdDriveSpeedController } from "./dvd-drive-speed.js";
import type { CommandRunner } from "./optical-drive-command-runner.js";

function runner(
  results: Array<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>,
) {
  const run = vi.fn<CommandRunner["run"]>(async () => {
    const result = results.shift();
    if (result === undefined) throw new Error("Unexpected command");
    return {
      exitCode: result.exitCode,
      signal: null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  return { run };
}

it("records an accepted 4x low-speed request", async () => {
  const test = runner([
    { exitCode: 0 },
  ]);
  const controller = createNodeDvdDriveSpeedController(
    { run: test.run },
    async () => "drive name:\tsr0\ndrive speed:\t4\n",
  );

  await expect(controller.apply({
    devicePath: "/dev/sr0",
    mode: "low",
    signal: new AbortController().signal,
  })).resolves.toEqual({
    attemptedSpeeds: [4],
    selectedSpeed: 4,
    observedSpeed: 4,
    outcome: "accepted",
  });
  expect(test.run).toHaveBeenCalledWith(
    "eject",
    ["--cdspeed", "4", "/dev/sr0"],
    expect.any(Object),
  );
});

it("falls back to 2x when the drive rejects 4x", async () => {
  const test = runner([
    { exitCode: 1 },
    { exitCode: 0 },
  ]);
  const controller = createNodeDvdDriveSpeedController(
    { run: test.run },
    async () => "drive name:\tsr0\ndrive speed:\t2\n",
  );

  await expect(controller.apply({
    devicePath: "/dev/sr0",
    mode: "low",
    signal: new AbortController().signal,
  })).resolves.toEqual({
    attemptedSpeeds: [4, 2],
    selectedSpeed: 2,
    observedSpeed: 2,
    outcome: "accepted",
  });
});

it("distinguishes rejected and ignored low-speed requests", async () => {
  const rejected = runner([{ exitCode: 1 }, { exitCode: 1 }]);
  const rejectedController = createNodeDvdDriveSpeedController(
    { run: rejected.run },
    async () => "",
  );
  await expect(rejectedController.apply({
    devicePath: "/dev/sr0",
    mode: "low",
    signal: new AbortController().signal,
  })).resolves.toMatchObject({
    attemptedSpeeds: [4, 2],
    selectedSpeed: null,
    outcome: "rejected",
  });

  const ignored = runner([
    { exitCode: 0 },
  ]);
  const ignoredController = createNodeDvdDriveSpeedController(
    { run: ignored.run },
    async () => "drive name:\tsr0\ndrive speed:\t16\n",
  );
  await expect(ignoredController.apply({
    devicePath: "/dev/sr0",
    mode: "low",
    signal: new AbortController().signal,
  })).resolves.toMatchObject({
    attemptedSpeeds: [4],
    selectedSpeed: 4,
    observedSpeed: 16,
    outcome: "ignored",
  });
});

it("requests automatic speed for normal mode", async () => {
  const test = runner([{ exitCode: 0 }]);
  const controller = createNodeDvdDriveSpeedController(
    { run: test.run },
    async () => "drive name:\tsr0\ndrive speed:\t16\n",
  );

  await expect(controller.apply({
    devicePath: "/dev/sr0",
    mode: "normal",
    signal: new AbortController().signal,
  })).resolves.toEqual({
    attemptedSpeeds: [0],
    selectedSpeed: 0,
    observedSpeed: 16,
    outcome: "accepted",
  });
});
