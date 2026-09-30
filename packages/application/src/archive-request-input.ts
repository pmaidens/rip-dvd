export const UNSUPPORTED_ARCHIVE_EVIDENCE_FORMAT = {
  code: "UNSUPPORTED_ARCHIVE_EVIDENCE_FORMAT",
  message: "Archive evidence format is unsupported.",
} as const;

export class UnsupportedArchiveEvidenceFormatError extends Error {
  readonly code = UNSUPPORTED_ARCHIVE_EVIDENCE_FORMAT.code;

  constructor() {
    super(UNSUPPORTED_ARCHIVE_EVIDENCE_FORMAT.message);
    this.name = "UnsupportedArchiveEvidenceFormatError";
  }
}
