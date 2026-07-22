import { beforeEach, describe, expect, it, vi } from "vitest";

const checkHealth = vi.fn();

vi.mock("../../lib/data-access", () => ({
  getDataAccess: () => ({ checkHealth }),
}));

import { GET } from "./route";

describe("GET /health", () => {
  beforeEach(() => {
    checkHealth.mockReset();
  });

  it("returns visible database health without allowing caches to mask it", async () => {
    checkHealth.mockReturnValue({
      status: "ok",
      sqliteVersion: "3.50.4",
      journalMode: "wal",
      busyTimeoutMs: 5_000,
    });

    const response = GET();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("Service health");
    expect(html).toContain("Connected");
    expect(html).toContain("WAL");
  });

  it("returns 503 without leaking database failures", async () => {
    checkHealth.mockImplementation(() => {
      throw new Error("sensitive database detail");
    });

    const response = GET();
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("Database unavailable");
    expect(html).not.toContain("sensitive database detail");
  });
});
