import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OriginalDiscArchiveId } from "../types.js";
import { assignDvdContentIdAlias } from "./dvd-content-id-alias.js";

const conflictMessages = {
  fingerprintOwner:
    "fingerprint belongs to a different Original Disc Archive",
  aliasOwner: "alias belongs to a different Original Disc Archive",
};

function archiveId(value: string): OriginalDiscArchiveId {
  return value as OriginalDiscArchiveId;
}

describe("assignDvdContentIdAlias", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      create table original_disc_archives (
        id text primary key not null,
        fingerprint text not null unique
      );
      create table original_disc_archive_content_ids (
        original_disc_archive_id text primary key not null,
        content_id text not null unique
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertArchive(id: OriginalDiscArchiveId, fingerprint: string) {
    sqlite.prepare(
      "insert into original_disc_archives (id, fingerprint) values (?, ?)",
    ).run(id, fingerprint);
  }

  function assign(
    originalDiscArchiveId: OriginalDiscArchiveId,
    contentId: string,
  ) {
    const database = drizzle({ client: sqlite });
    database.transaction((transaction) => {
      assignDvdContentIdAlias(transaction, {
        originalDiscArchiveId,
        contentId,
        conflictMessages,
      });
    }, { behavior: "immediate" });
  }

  it("assigns an unowned content ID alias", () => {
    const ownerId = archiveId("archive-a");
    insertArchive(ownerId, "legacy-fingerprint-a");

    assign(ownerId, "sha256:content-a");

    expect(sqlite.prepare(`
      select original_disc_archive_id as originalDiscArchiveId,
             content_id as contentId
      from original_disc_archive_content_ids
    `).get()).toEqual({
      originalDiscArchiveId: ownerId,
      contentId: "sha256:content-a",
    });
  });

  it("accepts an alias that is already owned by the requested archive", () => {
    const ownerId = archiveId("archive-a");
    insertArchive(ownerId, "legacy-fingerprint-a");
    sqlite.prepare(`
      insert into original_disc_archive_content_ids (
        original_disc_archive_id,
        content_id
      ) values (?, ?)
    `).run(ownerId, "sha256:content-a");

    expect(() => assign(ownerId, "sha256:content-a")).not.toThrow();
  });

  it("fails closed when the conflict-tolerant insert loses alias ownership", () => {
    const requestedOwnerId = archiveId("archive-a");
    const existingOwnerId = archiveId("archive-b");
    insertArchive(requestedOwnerId, "legacy-fingerprint-a");
    insertArchive(existingOwnerId, "legacy-fingerprint-b");
    sqlite.prepare(`
      insert into original_disc_archive_content_ids (
        original_disc_archive_id,
        content_id
      ) values (?, ?)
    `).run(existingOwnerId, "sha256:content-a");

    expect(() => assign(requestedOwnerId, "sha256:content-a"))
      .toThrow(conflictMessages.aliasOwner);
    expect(sqlite.prepare(`
      select original_disc_archive_id as originalDiscArchiveId
      from original_disc_archive_content_ids
      where content_id = ?
    `).get("sha256:content-a")).toEqual({
      originalDiscArchiveId: existingOwnerId,
    });
  });

  it("rejects a content ID stored as another archive's fingerprint", () => {
    const requestedOwnerId = archiveId("archive-a");
    const existingOwnerId = archiveId("archive-b");
    insertArchive(requestedOwnerId, "legacy-fingerprint-a");
    insertArchive(existingOwnerId, "sha256:content-a");

    expect(() => assign(requestedOwnerId, "sha256:content-a"))
      .toThrow(conflictMessages.fingerprintOwner);
    expect(sqlite.prepare(`
      select count(*) as count from original_disc_archive_content_ids
    `).get()).toEqual({ count: 0 });
  });
});
