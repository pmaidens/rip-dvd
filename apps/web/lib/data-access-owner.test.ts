import { describe, expect, it, vi } from "vitest";

import {
  createDataAccessOwner,
  type DataAccessLifecycleHost,
  type DataAccessShutdownSignal,
} from "./data-access-owner";

describe("createDataAccessOwner", () => {
  it("owns one cached facade and closes it exactly once on shutdown", () => {
    const listeners = new Map<DataAccessShutdownSignal, () => void>();
    const removedListeners: DataAccessShutdownSignal[] = [];
    const close = vi.fn();
    const terminate = vi.fn();
    const open = vi.fn(() => ({ close }));
    const host: DataAccessLifecycleHost = {
      once: (signal, listener) => listeners.set(signal, listener),
      off: (signal) => removedListeners.push(signal),
      terminate,
    };
    const owner = createDataAccessOwner(open, host);

    const first = owner.get();
    const second = owner.get();

    expect(first).toBe(second);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect([...listeners.keys()]).toEqual(["SIGINT", "SIGTERM"]);

    listeners.get("SIGTERM")?.();
    owner.dispose();

    expect(close).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith("SIGTERM");
    expect(removedListeners).toEqual(["SIGINT", "SIGTERM"]);
    expect(() => owner.get()).toThrow("Data access owner is disposed");
  });

  it("does not open a facade when disposal happens before the first request", () => {
    const listeners = new Map<DataAccessShutdownSignal, () => void>();
    const open = vi.fn(() => ({ close: vi.fn() }));
    const owner = createDataAccessOwner(open, {
      once: (signal, listener) => listeners.set(signal, listener),
      off: () => undefined,
      terminate: vi.fn(),
    });

    owner.dispose();

    expect(open).not.toHaveBeenCalled();
    expect(() => owner.get()).toThrow("Data access owner is disposed");
  });
});
