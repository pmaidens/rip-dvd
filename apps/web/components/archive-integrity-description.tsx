import {
  archiveIntegrityDetail,
  type ArchiveIntegrityDetailInput,
} from "../lib/archive-integrity";

export function ArchiveIntegrityDescription(
  evidence: ArchiveIntegrityDetailInput,
) {
  const detail = archiveIntegrityDetail(evidence);
  return detail ? <p>{detail}</p> : null;
}
