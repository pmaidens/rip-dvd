import { createHash } from "node:crypto";
import type { NotificationEventInput, NotificationEventWriter } from "@rip-dvd/data-access";

/** Producers report authoritative committed transitions, never progress or polling failures. */
export type NotificationOutcome = {
  sourceEventId: string;
  label?: string | null;
} & (
  | { kind: "test" }
  | { kind: "archive_saved"; archiveJobId: string; remainingSource: boolean }
  | { kind: "archive_failed"; archiveJobId: string }
  | { kind: "recovery_completed"; originalDiscArchiveId: string }
  | { kind: "recovery_attention"; originalDiscArchiveId: string }
  | { kind: "recovery_stopped"; originalDiscArchiveId: string; remainingSource: boolean }
);

export function formatNotification(outcome: NotificationOutcome): NotificationEventInput {
  if (!outcome.sourceEventId.trim() || outcome.sourceEventId.length > 256) throw new RangeError("Invalid notification source identity");
  const label = outcome.label?.trim().slice(0, 100) || "Unlabelled disc";
  const tag = `rip-dvd-${createHash("sha256").update(outcome.sourceEventId).digest("hex").slice(0, 32)}`;
  let body: string;
  switch (outcome.kind) {
    case "test": body = "Test notification. Push delivery is working on this browser."; break;
    case "archive_saved": body = outcome.remainingSource
      ? "Original Disc Archive saved. Source remains unrecovered; recovery may continue."
      : "Original Disc Archive saved."; break;
    case "archive_failed": body = "Archive Job failed. Inspect the attempt for details."; break;
    case "recovery_completed": body = "Archive Recovery completed. All remaining source recovered."; break;
    case "recovery_attention": body = "Archive Recovery needs attention. Inspect the recovery for details."; break;
    case "recovery_stopped": body = outcome.remainingSource
      ? "Archive Recovery stopped. Source remains unrecovered."
      : "Archive Recovery stopped. No source remains unrecovered."; break;
  }
  const destination = outcome.kind === "test" ? "/notifications"
    : "archiveJobId" in outcome
      ? `/notifications/target?kind=archive-jobs&id=${encodeURIComponent(outcome.archiveJobId)}`
      : `/notifications/target?kind=original-disc-archives&id=${encodeURIComponent(outcome.originalDiscArchiveId)}`;
  return { sourceEventId: outcome.sourceEventId,
    payload: { version: 1, title: outcome.kind === "test" ? "Rip DVD test" : label,
      label, body, tag, destination } };
}

/** Pass a writer bound to the producer's existing outcome transaction. */
export function recordNotificationOutcome(writer: NotificationEventWriter, outcome: NotificationOutcome) {
  return writer.recordEvent(formatNotification(outcome));
}
