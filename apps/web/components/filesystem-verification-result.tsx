import type { FilesystemVerificationStatus } from "@rip-dvd/data-access";

import { displayTerm } from "../lib/display-term";

export interface FilesystemVerificationDisplay {
  status: FilesystemVerificationStatus | null;
  message: string | null;
  verifiedAt: string | null;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function FilesystemVerificationResult({
  status,
  message,
  verifiedAt,
}: FilesystemVerificationDisplay) {
  if (!status || !message || !verifiedAt) {
    return <p className="verification-result">Not verified yet.</p>;
  }
  return (
    <div
      className={`verification-result verification-${status}`}
      role="status"
      aria-live="polite"
    >
      <strong>{displayTerm(status)}</strong>
      <span>{message}</span>
      <small>Verified {formatTimestamp(verifiedAt)}</small>
    </div>
  );
}
