"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Variant = "inline" | "split" | "staged";
type Surface = "discs" | "catalog" | "encoding";
type Scenario = "copying" | "recovering" | "stopping" | "review" | "failed-output";
type Recovery = "copying" | "active" | "stopping" | "stopped";
type Preview = "none" | "waiting" | "complete" | "partial" | "failed" | "outdated";
type Output = "none" | "queued" | "running" | "failed" | "kept";

interface DemoState {
  recovery: Recovery;
  revision: number;
  assessmentRevision: number | null;
  acceptedRevision: number | null;
  included: string[];
  preview: Preview;
  previewRevision: number | null;
  output: Output;
  mappingReview: boolean;
  note: string;
}

const titleRows = [
  { id: "feature", title: "Title 1", duration: "1h 41m", chapters: "18 chapters", mapping: "Example Feature · whole title · angle 1", state: "Mapped", damage: "1.2% source missing", time: "Affected playback near 00:42:10–00:42:18", tone: "warning" },
  { id: "episode", title: "Title 2", duration: "43m", chapters: "6 chapters", mapping: "Example Episode · chapters 2–4 · angle 1", state: "Partially mapped", damage: "No known damage in selected chapters", time: "Unrecovered source lies outside chapters 2–4", tone: "clear" },
  { id: "extra", title: "Title 3", duration: "12m", chapters: "Unknown chapters", mapping: "No Media Item or Disc Selection", state: "Unmapped", damage: "Title impact unknown", time: "Navigation is incomplete; no playback interval estimate", tone: "unknown" },
] as const;

function scenarioState(scenario: Scenario): DemoState {
  const base: DemoState = {
    recovery: "active", revision: 2, assessmentRevision: 1,
    acceptedRevision: null, included: titleRows.map(({ id }) => id),
    preview: "none", previewRevision: null, output: "none",
    mappingReview: false,
    note: "Catalog work can continue while recovery changes the saved archive. The previous title assessment is outdated.",
  };
  if (scenario === "copying") return { ...base, recovery: "copying", revision: 0, assessmentRevision: null, note: "Initial copy is still running. A failed read has been skipped so the copy can continue." };
  if (scenario === "stopping") return { ...base, recovery: "stopping", note: "Stop requested. The active read and checkpoint must finish before the archive is stable." };
  if (scenario === "review") return { ...base, recovery: "stopped", assessmentRevision: 2, note: "Recovery stopped at a consistent checkpoint. Review the current assessment, then explicitly accept included damaged or unknown content." };
  if (scenario === "failed-output") return { ...base, recovery: "stopped", assessmentRevision: 2, acceptedRevision: 2, preview: "complete", previewRevision: 2, output: "failed", note: "The encode failed output validation. Its playable candidate can be inspected and separately kept without changing the failed job status." };
  return base;
}

const variants: { id: Variant; label: string; purpose: string }[] = [
  { id: "inline", label: "Inline review", purpose: "Recovery status above the existing editor; damage beside each title; acceptance below Disc Selections." },
  { id: "split", label: "Decision rail", purpose: "Keep the existing catalog tools on the left and put recovery, damage decisions, and samples in a right rail." },
  { id: "staged", label: "Review steps", purpose: "Keep the editor shell but focus one step at a time: recovery, catalog mapping, and damage decision." },
];
const scenarios: { id: Scenario; label: string }[] = [
  { id: "copying", label: "Initial copy" },
  { id: "recovering", label: "Recovering" },
  { id: "stopping", label: "Stopping" },
  { id: "review", label: "Ready to review" },
  { id: "failed-output", label: "Failed output" },
];

export function CatalogRecoveryPrototype({ initialVariant, surface }: { initialVariant: Variant; surface: Surface }) {
  const router = useRouter();
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const defaultScenario: Scenario = surface === "discs" ? "copying" : surface === "encoding" ? "failed-output" : "recovering";
  const [scenario, setScenario] = useState<Scenario>(defaultScenario);
  const [state, setState] = useState<DemoState>(() => scenarioState(defaultScenario));
  const [reviewOpen, setReviewOpen] = useState(true);
  const [step, setStep] = useState<"recovery" | "catalog" | "damage">("damage");

  function chooseVariant(next: Variant) {
    setVariant(next);
    router.replace(`/${surface}?variant=${next}`, { scroll: false });
  }
  useEffect(() => {
    if (surface !== "catalog") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.target instanceof HTMLElement && event.target.closest("input, select, textarea, [contenteditable]")) return;
      const index = variants.findIndex(({ id }) => id === variant);
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + variants.length) % variants.length;
      chooseVariant(variants[next].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function act(action: string) {
    setState((current) => {
      const s: DemoState = { ...current, included: [...current.included] };
      const deny = (reason: string) => ({ ...s, note: reason });
      switch (action) {
        case "save":
          if (s.recovery !== "copying") return deny("The initial copy has already ended.");
          s.recovery = "active"; s.revision = 1; s.note = "Archive Job succeeded. Recovery started separately; Catalog Review is now available."; return s;
        case "recover":
          if (s.recovery !== "active") return deny("Only active recovery can write another batch.");
          s.revision++; s.assessmentRevision = null; s.acceptedRevision = null;
          if (s.preview === "complete") s.preview = "outdated";
          s.note = "A durable recovery checkpoint changed the archive. Title assessment and acceptance need refreshing."; return s;
        case "stop":
          if (s.recovery !== "active") return deny("Recovery is not active.");
          s.recovery = "stopping"; s.note = "Stop requested. The image cannot be used for encoding until the writer is quiescent and the checkpoint is consistent."; return s;
        case "stopped":
          if (s.recovery !== "stopping") return deny("There is no stop request waiting for a checkpoint.");
          s.recovery = "stopped"; s.note = "Recovery stopped. The saved archive and unresolved-source evidence remain available."; return s;
        case "assess":
          if (s.recovery === "copying" || s.recovery === "stopping") return deny("A consistent saved checkpoint is required for this assessment.");
          if (s.mappingReview) return deny("Review the changed title identity before assessing the new mapping.");
          s.assessmentRevision = s.revision; s.note = `Title damage assessment refreshed for archive revision ${s.revision}.`; return s;
        case "identity":
          s.mappingReview = true; s.assessmentRevision = null; s.acceptedRevision = null;
          s.note = "New navigation evidence changed title identity. Existing Disc Selections remain, but need review before their scope can be trusted."; return s;
        case "resolve-identity":
          s.mappingReview = false; s.note = "Title mapping reviewed. Refresh damage evidence before acceptance."; return s;
        case "accept":
          if (s.recovery !== "stopped") return deny("Damage acceptance waits until recovery has stopped and the source is stable.");
          if (s.assessmentRevision !== s.revision) return deny("Refresh the title assessment for the current archive revision first.");
          if (s.mappingReview) return deny("Changed title mappings need review first.");
          if (s.included.length === 0) return deny("Choose at least one source title for the review set.");
          s.acceptedRevision = s.revision; s.note = "Damage and unknown impact accepted for the included content only. No encode was queued."; return s;
        case "withdraw":
          if (s.acceptedRevision === null) return deny("There is no current acceptance to withdraw.");
          s.acceptedRevision = null; s.note = "Acceptance withdrawn. Queued work cannot start; a running job would continue unless cancelled separately."; return s;
        case "queue":
          if (s.recovery !== "stopped" || s.acceptedRevision !== s.revision || !s.included.includes("feature")) return deny("The selected feature needs stable source evidence and current damage acceptance.");
          s.output = "queued"; s.note = "Only the selected feature was queued. The review set did not queue the other titles."; return s;
        case "start":
          if (s.output !== "queued" || s.acceptedRevision !== s.revision) return deny("The job cannot start without a current acceptance at worker claim.");
          s.output = "running"; s.note = "The encode started under the current accepted revision."; return s;
        case "fail-output":
          if (s.output !== "running") return deny("There is no running encode to validate.");
          s.output = "failed"; s.note = "Output validation failed. The job stays failed; the candidate is available for inspection."; return s;
        case "keep-output":
          if (s.output !== "failed") return deny("Only a safe, playable failed-validation artifact can be kept.");
          s.output = "kept"; s.note = "A separate artifact was kept. The Encode Job remains failed and no normal library output was replaced."; return s;
        case "preview":
          if (s.revision === 0 || s.assessmentRevision !== s.revision) return deny("A Damage Preview needs a consistent checkpoint and current timing evidence.");
          s.preview = s.recovery === "active" ? "waiting" : "complete"; s.previewRevision = s.revision;
          s.note = s.preview === "waiting" ? "Preview waits while recovery reaches a durable checkpoint and releases the image for a consistent read." : "A sample was created from this revision using the intended encoding settings."; return s;
        case "finish-preview":
          if (s.preview !== "waiting") return deny("No preview is waiting for a checkpoint.");
          s.preview = "complete"; s.note = "Sample completed. It is a short encode, not a clip cut from the finished output."; return s;
        case "partial-preview":
          if (s.preview !== "waiting") return deny("No preview is waiting for ownership.");
          s.preview = "partial"; s.note = "Preview interrupted for archive ownership. The fragment is playable but partial and will not restart automatically."; return s;
        case "fail-preview":
          if (s.preview !== "waiting") return deny("No preview is generating.");
          s.preview = "failed"; s.note = "Preview generation failed. This does not mean the source has no damage."; return s;
        default: return deny("This action is not available in the prototype.");
      }
    });
  }

  function toggleIncluded(id: string) {
    setState((current) => ({
      ...current,
      included: current.included.includes(id) ? current.included.filter((value) => value !== id) : [...current.included, id],
      acceptedRevision: null,
      note: "The review scope changed. Submit a new explicit acceptance for the exact included set.",
    }));
  }

  const currentAssessment = state.assessmentRevision === state.revision && state.revision > 0;
  const accepted = state.acceptedRevision === state.revision && state.revision > 0;
  const phaseText = state.recovery === "copying" ? "Initial copy" : state.recovery === "active" ? "Recovering" : state.recovery === "stopping" ? "Stopping" : "Recovery stopped";
  const visibleScenarios = scenarios.filter(({ id }) =>
    surface === "discs" ? ["copying", "recovering", "stopping", "review"].includes(id) :
      surface === "catalog" ? ["recovering", "stopping", "review", "failed-output"].includes(id) :
        ["review", "failed-output"].includes(id));
  const headerCopy = surface === "discs"
    ? { kicker: "Disc intake", title: "Preserve every disc with confidence.", summary: "Monitor optical drives, inspect detected titles, approve archives, and recover failed preservation jobs." }
    : surface === "encoding"
      ? { kicker: "Encoding", title: "Manage the path to the media library.", summary: "Maintain encoding profiles, queue reviewed selections, and follow each encode through publication." }
      : { kicker: "Catalog review", title: "Turn archives into a clean media catalog.", summary: "Review archived discs, connect titles to media items, and prepare selections for encoding." };

  const recoveryPanel = (
    <section className="recovery-prototype-panel" aria-label="Proposed recovery status">
      <div className="recovery-prototype-heading">
        <div><p className="section-eyebrow">Proposed · archive recovery</p><h3>Saved archive and recovery are separate</h3></div>
        <span className={`recovery-prototype-badge is-${state.recovery}`}>{phaseText}</span>
      </div>
      <div className="recovery-prototype-facts">
        <div><span>Archive Job</span><strong>{state.revision ? "Saved successfully" : "Copying"}</strong></div>
        <div><span>Current checkpoint</span><strong>{state.revision ? `Revision ${state.revision}` : "Not saved"}</strong></div>
        <div><span>Initially skipped</span><strong>48 MiB · 1.0%</strong></div>
        <div><span>Recovered</span><strong>{state.revision === 0 ? "0 MiB" : state.revision > 2 ? "24 MiB" : "16 MiB"}</strong></div>
        <div><span>Still unresolved</span><strong>{state.revision === 0 ? "48 MiB" : state.revision > 2 ? "24 MiB" : "32 MiB"}</strong></div>
        <div><span>Individually failed</span><strong>{state.revision === 0 ? "Not tested" : "2 MiB"}</strong></div>
      </div>
      <div className="recovery-prototype-pass">
        <div><span>{state.revision === 0 ? "Initial copy · 62% complete" : "Pass 2 · reverse · 68% traversed"}</span><strong>Elapsed {state.revision === 0 ? "12" : "31"} min</strong></div>
        <div className="progress" role="progressbar" aria-label={state.revision === 0 ? "Initial copy" : "Current recovery pass"} aria-valuenow={state.revision === 0 ? 62 : 68} aria-valuemin={0} aria-valuemax={100}><span style={{ width: state.revision === 0 ? "62%" : "68%" }} /></div>
        <p>{state.revision === 0 ? "Initial copy advances past the skipped request. Recovery starts only after the archive saves." : "Current pass estimate: 4–9 min. Overall recovery time and final recovered amount: unknown."}</p>
      </div>
      <div className="operation-actions">
        {state.recovery === "copying" ? <button type="button" onClick={() => act("save")}>Finish and save initial archive</button> : null}
        {state.recovery === "active" ? <><button type="button" onClick={() => act("recover")}>Simulate recovered checkpoint</button><button type="button" onClick={() => act("stop")}>Stop and keep archive</button></> : null}
        {state.recovery === "stopping" ? <button type="button" onClick={() => act("stopped")}>Finish checkpoint and stop</button> : null}
        <button type="button" onClick={() => act("assess")}>Refresh title assessment</button>
      </div>
      <p className="catalog-help">Skipped requests are not all proven unreadable. A pass estimate predicts traversal, not success. The saved image remains available when recovery stops.</p>
    </section>
  );

  const catalogPanel = (
    <div className="catalog-editor-grid recovery-prototype-catalog-grid">
      <section className="catalog-pane catalog-evidence" aria-label="Archived Scan Evidence">
        <p className="section-eyebrow">Existing Catalog Review, with proposed damage details</p>
        <h3>Archived Scan Evidence</h3>
        <p className="catalog-help">Titles still come from the archived disc scan. Catalog mappings are separate from damage acceptance.</p>
        <ul className="recovery-prototype-title-list">
          {titleRows.map((title) => (
            <li className="catalog-title-evidence" key={title.id}>
              <div className="catalog-title-evidence-heading">
                <div><h4>{title.title}</h4><p>{title.duration} · {title.chapters}</p></div>
                <span className={`catalog-coverage-state is-${title.id === "extra" ? "unmapped" : title.id === "episode" ? "partially_mapped" : "mapped"}`}>{title.state}</span>
              </div>
              <p className="catalog-help">{title.mapping}</p>
              <div className={`recovery-prototype-damage is-${title.tone}`}>
                <strong>{title.damage}</strong><span>{title.time}</span>
                <small>{currentAssessment ? `Assessment for revision ${state.revision}` : "Assessment outdated or pending"}</small>
              </div>
              {title.id === "feature" ? <button type="button" onClick={() => act("preview")}>Request Damage Preview</button> : null}
            </li>
          ))}
        </ul>
      </section>
      <section className="catalog-pane catalog-selections" aria-label="Disc Selections">
        <p className="section-eyebrow">Existing Catalog Review</p>
        <h3>Media Items and Disc Selections</h3>
        <div className="recovery-prototype-selection"><strong>Example Feature</strong><span>Title 1 · whole title · angle 1</span><span className="catalog-coverage-state is-mapped">Mapped</span></div>
        <div className="recovery-prototype-selection"><strong>Example Episode</strong><span>Title 2 · chapters 2–4 · angle 1</span><span className="catalog-coverage-state is-partially_mapped">Partially mapped</span></div>
        <div className="recovery-prototype-selection"><strong>Title 3 has no Media Item</strong><span>It still appears in damage review.</span><span className="catalog-coverage-state is-unmapped">Unmapped</span></div>
        <div className="recovery-prototype-review-coverage"><h3>Review Coverage</h3><p>1 mapped title · 1 partially mapped title · 1 unmapped title</p><p className="catalog-help">The existing catalog completion step remains separate from accepting source damage.</p></div>
        <div className="operation-actions"><button type="button" onClick={() => act("identity")}>Simulate changed title identity</button>{state.mappingReview ? <button type="button" onClick={() => act("resolve-identity")}>Review affected mapping</button> : null}</div>
      </section>
    </div>
  );

  const damagePanel = (
    <section className="recovery-prototype-panel" aria-label="Proposed damage review">
      <div className="recovery-prototype-heading"><div><p className="section-eyebrow">Proposed · separate decision</p><h3>Review source damage</h3></div><span className={`recovery-prototype-badge ${accepted ? "is-accepted" : ""}`}>{accepted ? "Accepted" : currentAssessment ? "Needs decision" : "Assessment outdated"}</span></div>
      <p className="catalog-help">All discovered content starts in the review set, including unmapped titles. Exclude content explicitly. This decision does not queue encoding or declare the disc watchable.</p>
      <div className="recovery-prototype-review-list">
        {titleRows.map((title) => <label key={title.id}><input type="checkbox" checked={state.included.includes(title.id)} onChange={() => toggleIncluded(title.id)} /><span><strong>{title.title} · {title.mapping}</strong><small>{title.damage}. {title.time}.</small></span></label>)}
      </div>
      <div className="recovery-prototype-decision-row"><div><strong>{state.included.length} of 3 titles included</strong><p>{state.recovery !== "stopped" ? "Recovery must stop before acceptance." : !currentAssessment ? "Refresh the assessment for the stable revision." : state.mappingReview ? "Review changed mappings first." : "Ready for an explicit acceptance decision."}</p></div><button type="button" onClick={() => act("accept")}>Accept reported damage</button>{accepted ? <button type="button" onClick={() => act("withdraw")}>Withdraw acceptance</button> : null}</div>
      <p className="catalog-help">Title 2 approval covers chapters 2–4 only. Unknown impact on Title 3 is visible even without a catalog mapping. A changed source revision expires this acceptance.</p>
    </section>
  );

  const previewPanel = (
    <section className="recovery-prototype-panel" aria-label="Proposed Damage Preview">
      <div className="recovery-prototype-heading"><div><p className="section-eyebrow">Proposed · Catalog Review</p><h3>Damage Preview</h3></div></div>
      <div className="recovery-prototype-media-grid"><div><div className="recovery-prototype-player"><span>Sample from saved archive</span><strong>{state.preview === "none" ? "No sample requested" : state.preview === "waiting" ? "Waiting for checkpoint" : state.preview === "complete" ? "Sample available" : state.preview === "partial" ? "Partial sample" : state.preview === "outdated" ? "Outdated sample" : "Sample failed"}</strong></div></div><div><p>Selected affected interval with 5 seconds of context. Sample revision: {state.previewRevision ?? "none"}. Short decode behavior may differ from a full encode.</p><div className="operation-actions">{state.preview === "waiting" ? <><button type="button" onClick={() => act("finish-preview")}>Complete sample</button><button type="button" onClick={() => act("partial-preview")}>Interrupt for contention</button><button type="button" onClick={() => act("fail-preview")}>Fail sample</button></> : <button type="button" onClick={() => act("preview")}>Request sample</button>}</div></div></div>
      <p className="catalog-help">This would play an authenticated, labeled viewing rendition of a canonical sample MKV. A sample is not a segment of the finished output.</p>
    </section>
  );
  const outputPanel = (
    <section className="recovery-prototype-panel" aria-label="Proposed Encode Output inspection">
      <div className="recovery-prototype-heading"><div><p className="section-eyebrow">Proposed · Encoding</p><h3>Inspect actual Encode Output</h3></div></div>
      <div className="recovery-prototype-media-grid"><div><div className="recovery-prototype-player"><span>Actual finished file</span><strong>{state.output === "none" ? "No output yet" : state.output === "queued" ? "Queued" : state.output === "running" ? "Encoding" : state.output === "failed" ? "Failed validation · inspectable" : "Kept failed artifact"}</strong></div></div><div><p>Source-to-output damage correspondence: unknown until verified. Ordinary playback does not claim a damage seek point. A failed-validation candidate remains separate from a normal library output.</p><div className="operation-actions"><button type="button" onClick={() => act("queue")}>Queue selected feature</button>{state.output === "queued" ? <button type="button" onClick={() => act("start")}>Start encode</button> : null}{state.output === "running" ? <button type="button" onClick={() => act("fail-output")}>Fail validation</button> : null}{state.output === "failed" ? <button type="button" onClick={() => act("keep-output")}>Keep failed output separately</button> : null}</div></div></div>
      <p className="catalog-help">A browser rendition would be authenticated MP4 with any conversion and subtitle omissions labeled. The canonical Encode Output remains MKV. This prototype has no media bytes.</p>
    </section>
  );

  const stagedContent = step === "recovery" ? recoveryPanel : step === "catalog" ? catalogPanel : <>{damagePanel}{previewPanel}</>;
  const activeVariant = variants.find(({ id }) => id === variant)!;
  const catalogSurface = (
    <>
      <div className="catalog-review-browse-controls"><div className="profile-actions"><button type="button" aria-pressed="true">Needs review</button><button type="button" disabled>Reviewed</button></div></div>
      <section className="dashboard-section wide-section recovery-prototype-list"><header className="section-header"><div><p className="section-eyebrow">Needs attention</p><h2>Catalog Review</h2></div><span>1 archive</span></header><article className="operation-item review-item"><div className="item-heading"><div><h3>Example DVD</h3><p>DVD · ISO</p><p>Archive integrity: source gaps recorded</p></div><span className="attention-mark">Review</span></div><p className="item-time">Synthetic archive · {phaseText.toLowerCase()}</p><div className="operation-actions"><button type="button" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? "Close review" : "Review catalog"}</button><button type="button" disabled>Verify archive file</button></div></article></section>
      {reviewOpen ? <section className="catalog-editor recovery-prototype-editor" aria-label="Catalog Review prototype"><header className="catalog-editor-header"><div><p className="section-eyebrow">Archived disc review</p><h2>Catalog Example DVD</h2><p>DVD · ISO</p><p>Archive integrity: source gaps recorded</p></div><div className="profile-actions"><span className="attention-mark">Needs review</span><button type="button" onClick={() => setReviewOpen(false)}>Close review</button></div></header>
        {variant === "inline" ? <>{recoveryPanel}{catalogPanel}{damagePanel}{previewPanel}</> : null}
        {variant === "split" ? <div className="recovery-prototype-split"><div>{catalogPanel}</div><div>{recoveryPanel}{damagePanel}{previewPanel}</div></div> : null}
        {variant === "staged" ? <><div className="recovery-prototype-steps" role="tablist" aria-label="Review steps">{(["recovery", "catalog", "damage"] as const).map((id, index) => <button type="button" role="tab" aria-selected={step === id} key={id} onClick={() => setStep(id)}>{index + 1}. {id === "damage" ? "Damage decision" : id === "catalog" ? "Catalog mapping" : "Archive recovery"}</button>)}</div>{stagedContent}</> : null}
      </section> : null}
    </>
  );
  const discsSurface = (
    <>
      <div className="dashboard-grid dashboard-grid-discs recovery-prototype-disc-grid">
        <section className="dashboard-section"><header className="section-header"><div><p className="section-eyebrow">Hardware</p><h2>Optical Drives</h2></div></header><article className="operation-item"><div className="item-heading"><div><h3>Example Optical Drive</h3><p>DVD source inserted</p></div><span className="status status-ready">Ready</span></div><p className="item-time">Disc Inspection complete</p></article></section>
        <section className="dashboard-section"><header className="section-header"><div><p className="section-eyebrow">Intake</p><h2>Detected Discs</h2></div></header><article className="operation-item"><div className="item-heading"><div><h3>Example DVD</h3><p>DVD · 3 identified titles</p></div><span className="status status-running">In drive</span></div><p className="item-time">Archive Request active</p></article></section>
        <section className="dashboard-section"><header className="section-header"><div><p className="section-eyebrow">Preservation queue</p><h2>Archive Jobs</h2></div></header><article className="operation-item"><div className="item-heading"><div><h3>Example DVD</h3><p>Example Optical Drive</p></div><span className={`status status-${state.revision ? "completed" : "running"}`}>{state.revision ? "Completed" : "Running"}</span></div><div className="progress-row"><div className="progress"><span style={{ width: state.revision ? "100%" : "62%" }} /></div><strong>{state.revision ? "100%" : "62%"}</strong></div><p className="job-progress-detail">{state.revision ? "Initial image saved with damage evidence" : "Initial copy skips failed requests and continues"}</p></article></section>
      </div>
      <section className="dashboard-section wide-section recovery-prototype-disc-recovery"><header className="section-header"><div><p className="section-eyebrow">Proposed · after initial save</p><h2>Archive Recovery</h2></div></header>{state.revision ? recoveryPanel : <div className="operation-item"><p>Recovery has not started. Save the initial archive first.</p><button type="button" onClick={() => act("save")}>Finish and save initial archive</button></div>}</section>
    </>
  );
  const encodingSurface = (
    <section className="encoding-workspace" aria-label="Encoding prototype">
      <div className="encoding-page-tabs" role="tablist" aria-label="Encoding views"><button type="button" role="tab" aria-selected="true">Current</button><button type="button" role="tab" disabled>Queue</button><button type="button" role="tab" disabled>Settings</button></div>
      <div className="encoding-job-filters" role="group" aria-label="Current job status filters"><button type="button" aria-pressed="true"><span>In progress</span><span>{state.output === "queued" || state.output === "running" ? 1 : 0}</span></button><button type="button" disabled><span>Completed</span><span>0</span></button></div>
      <section className="dashboard-section wide-section recovery-prototype-encode-job"><header className="section-header"><div><p className="section-eyebrow">Media queue</p><h2>Encode Jobs</h2></div></header><article className="operation-item"><div className="item-heading"><div><h3>Example Feature</h3><p>Profile A · Title 1 · archive revision {state.revision}</p></div><span className={`status status-${state.output === "failed" || state.output === "kept" ? "failed" : state.output === "running" ? "running" : "queued"}`}>{state.output === "failed" || state.output === "kept" ? "Failed" : state.output === "running" ? "Running" : "Queued"}</span></div><p className="job-progress-detail">{state.output === "failed" || state.output === "kept" ? "Output validation failed. Candidate remains separate from the normal library." : "Source damage acceptance was checked at enqueue and worker claim."}</p><div className="operation-actions">{state.output === "failed" ? <button type="button" onClick={() => act("keep-output")}>Keep failed output separately</button> : null}<button type="button" disabled>Verify output file</button></div></article></section>
      {outputPanel}
    </section>
  );

  return (
    <main className="dashboard-shell recovery-prototype-root">
      <header className="dashboard-header"><div><p className="kicker">{headerCopy.kicker}</p><h1>{headerCopy.title}</h1><p className="dashboard-summary">{headerCopy.summary}</p></div><div className="dashboard-controls"><span className="connection-state connection-loaded"><span />Prototype data</span><button type="button" onClick={() => setState(scenarioState(scenario))}>Reset example</button></div></header>
      <section className="recovery-prototype-toolbar" aria-label="Prototype controls"><div><strong>Prototype · planned DVD workflow</strong><p>Synthetic example. These buttons change only this page and never call the server.</p><nav className="recovery-prototype-page-links" aria-label="Prototype pages"><Link href={`/discs?variant=${variant}`} aria-current={surface === "discs" ? "page" : undefined}>Disc intake</Link><Link href={`/catalog?variant=${variant}`} aria-current={surface === "catalog" ? "page" : undefined}>Catalog</Link><Link href={`/encoding?variant=${variant}`} aria-current={surface === "encoding" ? "page" : undefined}>Encoding</Link></nav></div><div className="recovery-prototype-scenarios">{visibleScenarios.map(({ id, label }) => <button key={id} type="button" aria-pressed={scenario === id} onClick={() => { setScenario(id); setState(scenarioState(id)); }}>{label}</button>)}</div></section>
      <p className="recovery-prototype-note" role="status">{state.note}</p>
      {surface === "discs" ? discsSurface : surface === "encoding" ? encodingSurface : catalogSurface}
      <details className="recovery-prototype-cli"><summary>Proposed JSON CLI operations behind these controls</summary><p>Each web action would use the same application operation as the JSON CLI. Proposed commands include <code>rip-dvd archive-recovery stop</code>, <code>rip-dvd title-damage show</code>, <code>rip-dvd title-damage accept</code>, <code>rip-dvd damage-preview request</code>, and <code>rip-dvd encode-output keep-failed</code>. They are not implemented by this prototype.</p></details>
      {surface === "catalog" ? <nav className="recovery-prototype-switcher" aria-label="Prototype layouts"><button type="button" onClick={() => chooseVariant(variants[(variants.findIndex(({ id }) => id === variant) + variants.length - 1) % variants.length].id)}>←</button><div><strong>{activeVariant.label}</strong><small>{activeVariant.purpose}</small></div><button type="button" onClick={() => chooseVariant(variants[(variants.findIndex(({ id }) => id === variant) + 1) % variants.length].id)}>→</button></nav> : null}
    </main>
  );
}
