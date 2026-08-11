import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-sqlite";

import { DomainInvariantError } from "../errors.js";
import type { OriginalDiscArchiveId } from "../types.js";
import {
  originalDiscArchiveContentIds,
  originalDiscArchives,
} from "./schema.js";

type DvdContentIdAliasTransaction = Pick<
  ReturnType<typeof drizzle>,
  "insert" | "select"
>;

export interface DvdContentIdAliasConflictMessages {
  fingerprintOwner: string;
  aliasOwner: string;
}

export function assignDvdContentIdAlias(
  transaction: DvdContentIdAliasTransaction,
  input: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    contentId: string;
    conflictMessages: DvdContentIdAliasConflictMessages;
  },
): void {
  const archiveWithFingerprint = transaction
    .select({ id: originalDiscArchives.id })
    .from(originalDiscArchives)
    .where(eq(originalDiscArchives.fingerprint, input.contentId))
    .get();
  if (
    archiveWithFingerprint &&
    archiveWithFingerprint.id !== input.originalDiscArchiveId
  ) {
    throw new DomainInvariantError(input.conflictMessages.fingerprintOwner);
  }

  transaction
    .insert(originalDiscArchiveContentIds)
    .values({
      originalDiscArchiveId: input.originalDiscArchiveId,
      contentId: input.contentId,
    })
    .onConflictDoNothing()
    .run();
  const archiveForContentId = transaction
    .select({
      originalDiscArchiveId:
        originalDiscArchiveContentIds.originalDiscArchiveId,
    })
    .from(originalDiscArchiveContentIds)
    .where(eq(originalDiscArchiveContentIds.contentId, input.contentId))
    .get();
  if (
    archiveForContentId?.originalDiscArchiveId !==
      input.originalDiscArchiveId
  ) {
    throw new DomainInvariantError(input.conflictMessages.aliasOwner);
  }
}
