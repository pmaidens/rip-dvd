"use client";

import { useState } from "react";
import type { EncodeOutputInspection, EncodeOutputInspectionReceipt } from "@rip-dvd/application";
import { createMutationKey } from "../lib/mutation-key";

export function EncodeOutputInspectionAcknowledgement({ inspection }: { inspection: EncodeOutputInspection }) {
  const reviewed = inspection.operatorInspection;
  const [acknowledged, setAcknowledged] = useState(false);
  const [mutationKey] = useState(createMutationKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<EncodeOutputInspectionReceipt | null>(null);
  const [loadedHistory, setLoadedHistory] = useState<{
    revision: string; receipts: EncodeOutputInspectionReceipt[]; nextOffset: number | null;
  } | null>(null);
  const historyRevision = JSON.stringify([reviewed.history.map((entry) => entry.id), reviewed.historyNextOffset]);
  const olderHistory = loadedHistory?.revision === historyRevision ? loadedHistory.receipts : [];
  const nextOffset = loadedHistory?.revision === historyRevision ? loadedHistory.nextOffset : reviewed.historyNextOffset;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const history = [...new Map([...reviewed.history, ...olderHistory, ...(receipt === null ? [] : [receipt])]
    .map((entry) => [entry.id, entry])).values()];

  async function loadHistory() {
    if (nextOffset === null || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const response = await fetch(`/api/encode-outputs/${encodeURIComponent(inspection.artifact.identity)}?receipt-offset=${nextOffset}`, { cache: "no-store" });
      if (!response.ok) throw new Error("History unavailable");
      const result = await response.json() as EncodeOutputInspection;
      setLoadedHistory((current) => ({
        revision: historyRevision,
        receipts: [...(current?.revision === historyRevision ? current.receipts : []), ...result.operatorInspection.history],
        nextOffset: result.operatorInspection.historyNextOffset,
      }));
    } catch { setError("Acknowledgement history is unavailable. Retry loading history."); }
    finally { setLoadingHistory(false); }
  }

  async function submit() {
    if (!acknowledged || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/encode-outputs/${encodeURIComponent(inspection.artifact.identity)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true, reviewToken: reviewed.reviewToken, mutationKey }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(`${result.error?.code ?? "ACKNOWLEDGEMENT_UNAVAILABLE"}. Inspect the output again before retrying.`);
        return;
      }
      setReceipt(result.receipt as EncodeOutputInspectionReceipt);
    } catch {
      setError("Acknowledgement is unavailable. Retry to retrieve the result with the same mutation key.");
    } finally {
      setPending(false);
    }
  }

  return <div>
    <h5>Operator inspection acknowledgement</h5>
    <p>This records your acknowledgement of this output generation and the evidence shown. It does not assert validation success, watchability, damage-interval playback, or a Keep decision.</p>
    <p>{receipt !== null || reviewed.status === "acknowledged" ? "Acknowledgement recorded for this generation." : "No acknowledgement recorded for this generation."}</p>
    {reviewed.acknowledgement.eligible && receipt === null ? <>
      <label>
        <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => setAcknowledged(event.target.checked)} />
        I have inspected this output generation and acknowledge the evidence and known unknowns shown.
      </label>
      <button type="button" disabled={!acknowledged || pending} onClick={() => { void submit(); }}>
        {pending ? "Recording acknowledgement…" : "Record inspection acknowledgement"}
      </button>
    </> : !reviewed.acknowledgement.eligible ? <p>Acknowledgement unavailable · {reviewed.acknowledgement.reasonCode}</p> : null}
    {error !== null ? <p role="alert">{error}</p> : null}
    {history.length > 0 ? <details>
      <summary>Inspection acknowledgement history</summary>
      <ul>{history.map((entry) => <li key={entry.id}>
        Receipt {entry.id} · {entry.acknowledgedAt} · {entry.generationIdentity}
        <details><summary>Recorded evidence</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(entry.evidence, null, 2)}</pre>
        </details>
      </li>)}</ul>
      {nextOffset === null ? null : <button type="button" disabled={loadingHistory} onClick={() => { void loadHistory(); }}>
        {loadingHistory ? "Loading acknowledgement history…" : "Load more acknowledgement history"}
      </button>}
    </details> : null}
  </div>;
}
