import { randomUUID } from "node:crypto";

import { RecordNotFoundError } from "../errors.js";

export function requireRow<T>(
  row: T | undefined,
  recordType: string,
  id: string,
): T {
  if (!row) {
    throw new RecordNotFoundError(recordType, id);
  }
  return row;
}

export function newId<Id extends string>(): Id {
  return randomUUID() as Id;
}
