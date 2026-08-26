import { normalizeMediaItemSearchTitle } from "./media-item-title-search.js";

export const ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH = 256;

export type EncodeQueueSearchQueryValidation =
  | {
    valid: true;
    query: string;
    normalizedQuery: string;
  }
  | {
    valid: false;
    reason: "empty" | "no_terms" | "too_long";
  };

export function validateEncodeQueueSearchQuery(
  value: string,
): EncodeQueueSearchQueryValidation {
  const query = value.trim();
  if (query.length === 0) {
    return { valid: false, reason: "empty" };
  }
  if (query.length > ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH) {
    return { valid: false, reason: "too_long" };
  }
  const normalizedQuery = normalizeMediaItemSearchTitle(query);
  if (normalizedQuery.length === 0) {
    return { valid: false, reason: "no_terms" };
  }
  return { valid: true, query, normalizedQuery };
}
