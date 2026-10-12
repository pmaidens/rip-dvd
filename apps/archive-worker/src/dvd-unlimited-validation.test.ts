import { afterEach, expect, it, vi } from "vitest";

import { createNodeCommandRunner } from "./optical-drive-command-runner.js";
import {
  readDvdNavigation,
  runDvdLayoutClassifier,
} from "./dvd-validation-process.js";
import { createNodeDvdTitlePlaybackValidator } from "./dvd-title-playback-validator.js";
import { createNodeDiscContentReader } from "./optical-disc-content.js";

afterEach(() => vi.useRealTimers());

it("cancels an unlimited helper when abort arrives during process startup", async () => {
  const controller = new AbortController();
  const cancellation = new Error("Archive Request cancellation requested");
  const cancel = vi.fn();
  const runner = createNodeCommandRunner({
    processLauncher: {
      start: () => {
        controller.abort(cancellation);
        return {
          cancel,
          closed: Promise.resolve(),
          result: new Promise<never>(() => {}),
        };
      },
    },
  });
  await expect(runner.run("synthetic-validator", [], {
    maxBufferBytes: 128,
    signal: controller.signal,
  })).rejects.toBe(cancellation);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["filesystem", "navigation", "playback", "hash"] as const)(
  "keeps silent %s validation running past former deadlines and cancels its helper",
  async (operation) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let confirmClosed!: () => void;
    const closed = new Promise<void>((resolve) => { confirmClosed = resolve; });
    const runner = createNodeCommandRunner({
      maxActiveCommands: 1,
      processLauncher: {
        start: () => ({
          cancel,
          closed,
          result: new Promise<never>(() => {}),
        }),
      },
    });
    const controller = new AbortController();
    const signal = controller.signal;
    const imagePath = "/synthetic/retained.iso";
    const completion = operation === "filesystem"
      ? runDvdLayoutClassifier({
          arguments: [imagePath],
          classifierScriptPath: "/synthetic/classifier.js",
          failureMessage: "Filesystem validation failed",
          runner,
          signal,
        })
      : operation === "navigation"
        ? readDvdNavigation({
            failureMessage: "Navigation validation failed",
            imagePath,
            runner,
            signal,
          })
        : operation === "playback"
          ? createNodeDvdTitlePlaybackValidator({ runner }).validate({
              imagePath,
              signal,
              title: {
                number: 1,
                durationSeconds: 600,
                chapters: 1,
                audioStreams: [],
                subtitles: [],
              },
            })
          : createNodeDiscContentReader({
              probeLauncher: {
                start: () => ({
                  cancel,
                  closed,
                  result: new Promise<never>(() => {}),
                }),
              },
            }).hash(imagePath, 2_048, signal);
    let outcome: unknown;
    void completion.then(
      () => { outcome = "completed"; },
      (error: unknown) => { outcome = error; },
    );

    await vi.advanceTimersByTimeAsync(13 * 60 * 60_000);
    expect(outcome).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();

    const cancellation = new Error("Archive Request cancellation requested");
    controller.abort(cancellation);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    if (operation === "hash") {
      expect(outcome).toBe(cancellation);
    } else {
      expect(outcome).toMatchObject({ cause: cancellation });
      // A cancelled helper retains its capacity reservation until OS closure.
      await expect(runner.run("another-validator", [], {
        maxBufferBytes: 128,
        signal: new AbortController().signal,
      })).rejects.toThrow("device command capacity is exhausted");
    }
    confirmClosed();
    await closed;
  },
);
