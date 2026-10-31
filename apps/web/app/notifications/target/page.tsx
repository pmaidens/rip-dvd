import Link from "next/link";
import { inspectOperations } from "@rip-dvd/application";
import type { ArchiveRecovery, DvdRecoveryReconciliation } from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";
import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

export default async function NotificationTargetPage({ searchParams }: {
  searchParams: Promise<{ kind?: string; id?: string }>;
}) {
  const { kind, id } = await searchParams;
  const supported = kind === "archive-jobs" || kind === "original-disc-archives";
  let detail: { status: string | null; integrity: string | null; label: string | null } | null = null;
  let recoveryDetail: {
    status: string;
    pauseReason: ArchiveRecovery["pauseReason"];
    faultCode: ArchiveRecovery["faultCode"];
    reconciliation: Pick<DvdRecoveryReconciliation, "status" | "failureCode"> | null;
    checkpointRevision: number | null;
    unresolvedSectorCount: number | null;
    actions: { name: string; eligible: boolean; reason: string | null }[];
  } | null = null;
  if (supported && typeof id === "string" && id.length > 0 && id.length <= 256) {
    try {
      const access = getDataAccess();
      const inspectionOptions = { id, originalsLibraryPath: loadConfig().originalsLibraryPath };
      const result = inspectOperations(access, kind, inspectionOptions);
      if ("item" in result && result.item) {
        const item = result.item;
        detail = {
          status: "status" in item && typeof item.status === "string" ? item.status : null,
          integrity: "integrity" in item && typeof item.integrity === "string" ? item.integrity : null,
          label: "detectedDisc" in item && item.detectedDisc && "volumeLabel" in item.detectedDisc ? item.detectedDisc.volumeLabel : null,
        };
        if ("archiveRecovery" in item && item.archiveRecovery?.record) {
          const recovery = inspectOperations(access, "archive-recoveries", {
            ...inspectionOptions,
            id: item.archiveRecovery.record.id,
          });
          if ("item" in recovery && recovery.item && "recoveryStatus" in recovery.item) {
            recoveryDetail = {
              status: recovery.item.recoveryStatus,
              pauseReason: recovery.item.pauseReason,
              faultCode: recovery.item.faultCode,
              reconciliation: recovery.item.reconciliation,
              checkpointRevision: recovery.item.checkpoint?.currentManifestRevision ?? null,
              unresolvedSectorCount: recovery.item.progress?.unresolvedSectorCount ?? null,
              actions: recovery.item.availableActions,
            };
          }
        }
      }
    } catch { /* A stale notification remains navigable during an outage. */ }
  }
  return <main className="notification-settings">
    <h1>{kind === "archive-jobs" ? "Archive Job" : "Original Disc Archive"}</h1>
    {detail ? <><h2>{detail.label || "Unlabelled disc"}</h2><dl>
      {detail.status && <><dt>Current status</dt><dd>{detail.status.replaceAll("_", " ")}</dd></>}
      {detail.integrity && <><dt>Archive Integrity</dt><dd>{detail.integrity.replaceAll("_", " ")}</dd></>}
    </dl></> : <p>This notification target is no longer available. Open the current operations views to inspect the work.</p>}
    {recoveryDetail && <section aria-label="Archive Recovery detail">
      <h2>Archive Recovery</h2>
      <dl>
        <dt>Current recovery status</dt><dd>{recoveryDetail.status.replaceAll("_", " ")}</dd>
        {recoveryDetail.pauseReason && <><dt>Pause reason</dt><dd>{recoveryDetail.pauseReason.replaceAll("_", " ")}</dd></>}
        {recoveryDetail.faultCode && <><dt>Fault reason</dt><dd>{recoveryDetail.faultCode}</dd></>}
        {recoveryDetail.reconciliation?.status === "failed" && <>
          <dt>Checkpoint reconciliation status</dt><dd>failed</dd>
          <dt>Checkpoint reconciliation fault</dt><dd>{recoveryDetail.reconciliation.failureCode}</dd>
        </>}
        <dt>Checkpoint revision</dt><dd>{recoveryDetail.checkpointRevision ?? "Unknown"}</dd>
        <dt>Unrecovered Source</dt><dd>{recoveryDetail.unresolvedSectorCount === null
          ? "Unknown" : `${recoveryDetail.unresolvedSectorCount} sectors`}</dd>
      </dl>
      <ul aria-label="Recovery action availability">
        {recoveryDetail.actions.map((action) => <li key={action.name}>
          {action.name}: {action.eligible ? "Available" : action.reason ?? "Unavailable"}
        </li>)}
      </ul>
      <p>Recovery and Archive Integrity do not establish watchability or authorize encoding.</p>
    </section>}
    <p><Link href="/discs">Disc intake and Archive Jobs</Link></p>
    <p><Link href="/catalog">Catalog and saved archives</Link></p>
    <p><Link href="/settings#notifications">Notification settings</Link></p>
  </main>;
}
