import type { ArchiveIntegrity } from "@rip-dvd/data-access";

const ARCHIVE_INTEGRITY_LABELS = {
  unknown: "Unknown read quality",
  clean_read: "Clean read",
  watchable_salvage: "Watchable salvage",
} satisfies Record<ArchiveIntegrity, string>;

export function archiveIntegrityLabel(integrity: ArchiveIntegrity): string {
  return ARCHIVE_INTEGRITY_LABELS[integrity];
}
