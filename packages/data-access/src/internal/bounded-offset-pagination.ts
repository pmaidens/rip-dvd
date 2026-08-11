import { DomainInvariantError } from "../errors.js";
import { requirePositiveSafeInteger } from "./validation.js";

export interface BoundedOffsetListOptions {
  limit?: number;
  offset?: number;
}

interface BoundedOffsetQuery<Row> {
  all(): Row[];
  limit(limit: number): {
    all(): Row[];
    offset(offset: number): { all(): Row[] };
  };
}

export function listWithBoundedOffset<Row>(
  query: BoundedOffsetQuery<Row>,
  options: BoundedOffsetListOptions | undefined,
  recordName: string,
): Row[] {
  if (options?.offset !== undefined && options.limit === undefined) {
    throw new DomainInvariantError(
      `${recordName} offset requires a bounded limit`,
    );
  }
  if (options?.limit === undefined) {
    return query.all();
  }

  const limited = query.limit(
    requirePositiveSafeInteger(options.limit, "limit"),
  );
  if (options.offset === undefined) {
    return limited.all();
  }
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    throw new DomainInvariantError(
      `offset must be a safe integer between 0 and ${Number.MAX_SAFE_INTEGER}`,
    );
  }
  return limited.offset(options.offset).all();
}
