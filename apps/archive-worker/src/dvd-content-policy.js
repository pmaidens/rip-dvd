// @ts-check

export const MAX_DVD_CONTENT_BYTES = 9_000_000_000;

/**
 * The shared raw-DVD size contract. Every caller invokes this independently at
 * its own trust boundary so parent and helper processes cannot drift.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function requireDvdContentSize(value) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_DVD_CONTENT_BYTES
  ) {
    throw new Error("DVD content size is invalid");
  }
  return value;
}
