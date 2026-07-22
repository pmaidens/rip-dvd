import { beforeEach, describe, expect, it, vi } from "vitest";

const checkHealth = vi.fn();

vi.mock("../../../lib/data-access", () => ({
  getDataAccess: () => ({ checkHealth }),
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    checkHealth.mockReset();
  });

  it("returns the database health without allowing caches to mask it", async () => {
    checkHealth.mockReturnValue({
      status: "ok",
      sqliteVersion: "3.50.4",
      journalMode: "wal",
      busyTimeoutMs: 5_000,
    });

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      sqliteVersion: "3.50.4",
      journalMode: "wal",
      busyTimeoutMs: 5_000,
    });
  });

  it("reports an unavailable database without exposing the failure", async () => {
    checkHealth.mockImplementation(() => {
      throw new Error("sensitive database detail");
    });

    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "error" });
  });
});
