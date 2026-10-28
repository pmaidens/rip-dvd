// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EncodeOutputInspection, EncodeOutputInspectionReceipt } from "@rip-dvd/application";
import type { EncodeJobId, DiscSelectionId, EncodingProfileId, EncodeOutputInspectionReceiptId } from "@rip-dvd/data-access";
import { EncodeOutputInspectionAcknowledgement } from "./encode-output-inspection-acknowledgement";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function inspectedOutput(): EncodeOutputInspection {
  const jobId = "synthetic-history-job" as EncodeJobId;
  return {
    schemaVersion: 1, authorityRevision: "synthetic-authority-revision",
    artifact: {
      identity: "synthetic-artifact-identity", type: "canonical_encode_output", state: "published",
      encodeJob: { id: jobId, status: "completed", completedAt: null },
      validation: { result: "unknown", identity: null, evidence: null, evidenceAvailability: "not_recorded", appliesToObservedFile: null },
      provenance: { encodeJobId: jobId, discSelectionId: "synthetic-selection" as DiscSelectionId,
        encodingProfileId: "synthetic-profile" as EncodingProfileId, originalDiscArchiveId: null,
        retainedOutputId: null, sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" },
      file: { status: "unknown", identity: null, mutationRevision: null, sizeBytes: null,
        modifiedAt: null, completeness: "unknown", identityContinuity: "unknown" },
      inspectability: { status: "unknown", reasonCode: "OUTPUT_PROBE_FAILED", reason: "Synthetic probe failure" },
      media: { durationSeconds: null, streams: null, playability: "not_assessed" },
      availableActions: [],
    },
    operatorInspection: { generationIdentity: null, reviewToken: "synthetic-review-token", status: "not_acknowledged",
      acknowledgement: { eligible: false, reasonCode: "OUTPUT_PROBE_FAILED", requiredInputs: [] },
      receipts: [], history: [], historyNextOffset: null },
  };
}

it("shows newly available history pages when unchanged output is re-inspected", async () => {
  const before = inspectedOutput();
  const receipt = (id: string): EncodeOutputInspectionReceipt => ({
    id: id as EncodeOutputInspectionReceiptId, encodeJobId: before.artifact.provenance.encodeJobId,
    artifactIdentity: before.artifact.identity, generationIdentity: "synthetic-prior-generation",
    acknowledgedAt: "2026-09-01T12:00:00.000Z", reviewToken: "synthetic-prior-token", evidence: before.artifact,
  });
  const newest = receipt("synthetic-newest-receipt");
  const older = receipt("synthetic-older-receipt");
  const after: EncodeOutputInspection = { ...before, operatorInspection: { ...before.operatorInspection, history: [newest], historyNextOffset: 1 } };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<EncodeOutputInspectionAcknowledgement inspection={before} />); });
    expect(container.textContent).not.toContain("Load more acknowledgement history");
    const fetcher = vi.fn(async () => Response.json({ ...after, operatorInspection: { ...after.operatorInspection, history: [older], historyNextOffset: null } }));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => { root.render(<EncodeOutputInspectionAcknowledgement inspection={after} />); });
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more acknowledgement history");
    expect(more).toBeDefined();
    await act(async () => { more!.click(); });
    expect(fetcher).toHaveBeenCalledWith(`/api/encode-outputs/${encodeURIComponent(before.artifact.identity)}?receipt-offset=1`, { cache: "no-store" });
    expect(container.textContent).toContain(older.id);
    expect(container.textContent).toContain(newest.id);
    expect(container.textContent).not.toContain("Load more acknowledgement history");
  } finally { await act(async () => { root.unmount(); }); }
});
