// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EncodeOutputKeepPreflightPanel } from "./encode-output-keep-preflight";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function preview() {
  return {
    schemaVersion: 1,
    artifact: {
      identity: "synthetic-failed-artifact",
      validation: { failure: { reasonCode: "output_validation_failed", evidence: { kind: "duration", expectedSeconds: 500, observedSeconds: 10 } } },
      file: { completeness: "complete" },
      provenance: { sourceSnapshot: { id: "synthetic-source-claim" } },
      inspectability: { status: "unknown", reason: "Synthetic media probe unavailable" },
    },
    current: { validationIdentity: "synthetic-failed-validation", fileIdentity: "synthetic-file-identity", fileRevision: "synthetic-file-revision",
      authorityRevision: "synthetic-authority", destinationRevision: "synthetic-destination-revision", sourceSnapshotIdentity: "synthetic-source-claim" },
    completeWrite: { status: "verified", sha256: "a".repeat(64), recordedFileIdentity: "synthetic-file-identity" },
    normalDestination: { status: "present", fileIdentity: "synthetic-normal-file", normalOutput: { artifactIdentity: "synthetic-normal-output" } },
    requiredAcknowledgement: { acknowledged: true, message: "I acknowledge the exact failed output and its failure evidence." },
    eligible: true,
    blockers: [],
    previewToken: `encode-output-keep-preview-v1.${"b".repeat(64)}`,
    review: { status: "not_supplied", reasonCode: null },
  };
}

it("loads the exact failed-output evidence on request and compares a refreshed preview without a mutation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async () => Response.json(preview()));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<EncodeOutputKeepPreflightPanel artifactIdentity="synthetic-failed-artifact" />); });
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { container.querySelector("button")!.click(); });
    expect(fetcher).toHaveBeenLastCalledWith("/api/encode-outputs/synthetic-failed-artifact/keep-preflight", { cache: "no-store" });
    expect(container.textContent).toContain("Complete stable output available for a Keep decision.");
    expect(container.textContent).toContain("synthetic-failed-validation");
    expect(container.textContent).toContain("synthetic-source-claim");
    expect(container.textContent).toContain('"observedSeconds":10');
    expect(container.textContent).toContain("synthetic-normal-output");
    expect(container.textContent).toContain("Complete-write proofVerified");
    expect(container.textContent).toContain("a".repeat(64));
    expect(container.textContent).toContain("Synthetic media probe unavailable");
    expect(container.textContent).toContain("I acknowledge the exact failed output and its failure evidence.");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    const changed = preview();
    fetcher.mockResolvedValueOnce(Response.json({ ...changed, eligible: false, previewToken: null,
      blockers: [{ code: "OUTPUT_IDENTITY_CHANGED", message: "Synthetic reviewed file changed." }, { code: "VALIDATION_STALE", message: "Synthetic validation changed." }],
      review: { status: "stale", reasonCode: "KEEP_PREFLIGHT_STALE" } }));
    await act(async () => { container.querySelector("button")!.click(); });
    expect(fetcher).toHaveBeenLastCalledWith(`/api/encode-outputs/synthetic-failed-artifact/keep-preflight?preview-token=${preview().previewToken}`, { cache: "no-store" });
    expect(container.textContent).toContain("The earlier Keep preview is stale.");
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "OUTPUT_IDENTITY_CHANGED · Synthetic reviewed file changed.", "VALIDATION_STALE · Synthetic validation changed.",
    ]);
    expect(container.textContent).not.toContain(preview().previewToken);
  } finally { await act(async () => { root.unmount(); }); }
});

it("clears an earlier preview when refreshing current evidence fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async () => Response.json(preview()));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<EncodeOutputKeepPreflightPanel artifactIdentity="synthetic-failed-artifact" />); });
    await act(async () => { container.querySelector("button")!.click(); });
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: "ENCODE_OUTPUT_KEEP_PREFLIGHT_UNAVAILABLE" } }, { status: 503 }));
    await act(async () => { container.querySelector("button")!.click(); });
    expect(container.textContent).toContain("Keep preflight is unavailable. Retry to review current evidence.");
    expect(container.textContent).not.toContain("synthetic-failed-validation");
    expect(container.textContent).not.toContain(preview().previewToken);
    expect(container.querySelector("button")?.textContent).toBe("Preview Keep");
  } finally { await act(async () => { root.unmount(); }); }
});
