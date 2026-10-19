import Link from "next/link";
import { inspectOperations } from "@rip-dvd/application";
import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

export default async function NotificationTargetPage({ searchParams }: {
  searchParams: Promise<{ kind?: string; id?: string }>;
}) {
  const { kind, id } = await searchParams;
  const supported = kind === "archive-jobs" || kind === "original-disc-archives";
  let detail: { status: string | null; integrity: string | null; label: string | null } | null = null;
  if (supported && typeof id === "string" && id.length > 0 && id.length <= 256) {
    try {
      const result = inspectOperations(getDataAccess(), kind, { id });
      if ("item" in result && result.item) {
        const item = result.item;
        detail = {
          status: "status" in item && typeof item.status === "string" ? item.status : null,
          integrity: "integrity" in item && typeof item.integrity === "string" ? item.integrity : null,
          label: "detectedDisc" in item && item.detectedDisc && "volumeLabel" in item.detectedDisc ? item.detectedDisc.volumeLabel : null,
        };
      }
    } catch { /* A stale notification remains navigable during an outage. */ }
  }
  return <main className="notification-settings">
    <h1>{kind === "archive-jobs" ? "Archive Job" : "Original Disc Archive"}</h1>
    {detail ? <><h2>{detail.label || "Unlabelled disc"}</h2><dl>
      {detail.status && <><dt>Current status</dt><dd>{detail.status.replaceAll("_", " ")}</dd></>}
      {detail.integrity && <><dt>Archive Integrity</dt><dd>{detail.integrity.replaceAll("_", " ")}</dd></>}
    </dl></> : <p>This notification target is no longer available. Open the current operations views to inspect the work.</p>}
    <p><Link href="/discs">Disc intake and Archive Jobs</Link></p>
    <p><Link href="/catalog">Catalog and saved archives</Link></p>
    <p><Link href="/notifications">Notification settings</Link></p>
  </main>;
}
