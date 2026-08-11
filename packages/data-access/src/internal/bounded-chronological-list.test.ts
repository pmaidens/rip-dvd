import { describe, expect, it, vi } from "vitest";

import { DomainInvariantError } from "../errors.js";
import type { ChronologicalListOptions } from "../types.js";
import {
  createBoundedChronologicalList,
  createJobList,
} from "./bounded-chronological-list.js";

interface TestRecord {
  id: string;
  status: "active" | "history";
  updatedAt: Date;
}

interface ActiveAndHistoryOptions {
  policy?: {
    mode: "active-and-history";
    activeLimit: number;
    historyLimit: number;
  };
}

const records: TestRecord[] = [
  {
    id: "history-new",
    status: "history",
    updatedAt: new Date("2026-08-10T04:00:00.000Z"),
  },
  {
    id: "active-old",
    status: "active",
    updatedAt: new Date("2026-08-10T01:00:00.000Z"),
  },
  {
    id: "history-old",
    status: "history",
    updatedAt: new Date("2026-08-10T02:00:00.000Z"),
  },
  {
    id: "active-new",
    status: "active",
    updatedAt: new Date("2026-08-10T03:00:00.000Z"),
  },
];

describe("bounded chronological list policy", () => {
  it("keeps independent active and history allowances in chronological order", () => {
    const readNewest = vi.fn(
      (statuses: TestRecord["status"][] | undefined, limit: number) =>
        records
          .filter((record) => statuses?.includes(record.status) ?? true)
          .sort(
            (left, right) =>
              right.updatedAt.getTime() - left.updatedAt.getTime(),
          )
          .slice(0, limit),
    );
    const list = createBoundedChronologicalList<
      TestRecord,
      TestRecord["status"],
      ActiveAndHistoryOptions
    >({
      activeStatuses: ["active"],
      historyStatuses: ["history"],
      chronologicalAt: (record) => record.updatedAt,
      readAll: () => records,
      readNewest,
    });

    expect(
      list(undefined, {
        policy: {
          mode: "active-and-history",
          activeLimit: 2,
          historyLimit: 1,
        },
      }).map((record) => record.id),
    ).toEqual(["active-old", "active-new", "history-new"]);
    expect(readNewest).toHaveBeenNthCalledWith(
      1,
      ["active"],
      2,
      expect.anything(),
    );
    expect(readNewest).toHaveBeenNthCalledWith(
      2,
      ["history"],
      1,
      expect.anything(),
    );
  });

  it("rejects an explicit status filter combined with active-and-history", () => {
    const list = createBoundedChronologicalList<
      TestRecord,
      TestRecord["status"],
      ActiveAndHistoryOptions
    >({
      activeStatuses: ["active"],
      historyStatuses: ["history"],
      chronologicalAt: (record) => record.updatedAt,
      readAll: () => records,
      readNewest: () => records,
    });

    expect(() =>
      list(["active"], {
        policy: {
          mode: "active-and-history",
          activeLimit: 1,
          historyLimit: 1,
        },
      }),
    ).toThrow(DomainInvariantError);
  });

  it("returns a chronological view of the newest bounded records", () => {
    const readNewest = vi.fn(() => [records[0]!, records[3]!]);
    const list = createBoundedChronologicalList<
      TestRecord,
      TestRecord["status"],
      ChronologicalListOptions
    >({
      activeStatuses: ["active"],
      historyStatuses: ["history"],
      chronologicalAt: (record) => record.updatedAt,
      readAll: () => records,
      readNewest,
    });

    expect(
      list(undefined, { policy: { mode: "newest", limit: 2 } }).map(
        (record) => record.id,
      ),
    ).toEqual(["active-new", "history-new"]);
    expect(readNewest).toHaveBeenCalledWith(undefined, 2, expect.anything());
  });

  it("gives job lists the shared active and terminal status policy", () => {
    const readNewest = vi.fn(() => []);
    const list = createJobList({ readQueue: () => [], readNewest });

    list(undefined, {
      policy: {
        mode: "active-and-history",
        activeLimit: 3,
        historyLimit: 4,
      },
    });

    expect(readNewest).toHaveBeenNthCalledWith(1, ["queued", "running"], 3);
    expect(readNewest).toHaveBeenNthCalledWith(2, ["completed", "failed"], 4);
  });
});
