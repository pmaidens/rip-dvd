const LOWERCASE_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function formatVolumeLabel(volumeLabel: string): string {
  const separated = volumeLabel
    .replace(/[_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    separated.length === 0 ||
    (separated !== separated.toUpperCase() &&
      separated !== separated.toLowerCase())
  ) {
    return separated;
  }
  return separated
    .toLowerCase()
    .split(" ")
    .map((word, index) =>
      index > 0 && LOWERCASE_TITLE_WORDS.has(word)
        ? word
        : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`
    )
    .join(" ");
}
