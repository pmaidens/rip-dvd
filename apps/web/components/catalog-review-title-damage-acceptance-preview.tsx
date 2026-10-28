"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CatalogReviewWorkflow,
  DvdTitleDamageAcceptancePreview,
  DvdTitleDamageAcceptanceWithdrawalPreview,
} from "@rip-dvd/application";

import type {
  CatalogReviewTitleDamage,
  CatalogReviewTitleDamageDecision,
  CatalogReviewTitleIdentity,
} from "./catalog-review-model";
import { CatalogReviewTitleDamageAssessmentEvidence } from
  "./catalog-review-title-damage";
import { createMutationKey } from "../lib/mutation-key";

type CurrentTitleIdentity = Extract<
  CatalogReviewTitleIdentity,
  { available: true }
>["items"][number];

function currentItems(titleIdentity: CatalogReviewTitleIdentity | undefined) {
  return titleIdentity?.available === true
    ? titleIdentity.items.filter((item) => item.presentAtCurrentCheckpoint)
    : [];
}

function contentLabel(item: CurrentTitleIdentity): string {
  return `DVD title ${item.observation.displayTitleNumber}, angle ${item.observation.angleNumber} of ${item.observation.angleCount}, chapters ${item.observation.chapterStart}-${item.observation.chapterEnd}`;
}

function mediaItemLabel(item: {
  id: string;
  kind: string;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodicContext?: {
    tvShow: { id: string; title: string; year: number | null } | null;
    season: {
      id: string;
      title: string;
      year: number | null;
      seasonNumber: number | null;
    } | null;
  } | null;
}): string {
  const year = item.year === null ? "" : ` (${item.year})`;
  if (item.kind === "episode") {
    const tvShow = item.episodicContext?.tvShow;
    const season = item.episodicContext?.season;
    const showYear = tvShow?.year === null || tvShow?.year === undefined
      ? ""
      : ` (${tvShow.year})`;
    return `${item.kind}: ${tvShow?.title ?? "unknown TV show"}${showYear}, season ${season?.seasonNumber ?? "unknown"}, episode ${item.episodeNumber ?? "unknown"}: ${item.title}${year}; Media Item ${item.id}`;
  }
  return `${item.kind}: ${item.title}${year}; Media Item ${item.id}`;
}

export function CatalogReviewTitleDamageAcceptancePreview({
  originalDiscArchiveId,
  titleIdentity,
  titleDamageDecision,
  evidenceGeneration,
  fetcher = fetch,
}: {
  originalDiscArchiveId: string;
  titleIdentity?: CatalogReviewTitleIdentity;
  titleDamageDecision?: CatalogReviewTitleDamageDecision;
  evidenceGeneration: {
    current: CatalogReviewWorkflow["current"];
    titleDamageState: CatalogReviewTitleDamage["state"] | null;
    activityRevision: string | null;
  };
  fetcher?: typeof fetch;
}) {
  const items = currentItems(titleIdentity);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [mainFeatureResolutions, setMainFeatureResolutions] = useState<
    Map<string, string>
  >(new Map());
  const [preview, setPreview] = useState<DvdTitleDamageAcceptancePreview | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operator, setOperator] = useState("");
  const [damageAcknowledged, setDamageAcknowledged] = useState(false);
  const [recordedDecision, setRecordedDecision] = useState<
    "accepted" | "not_required" | null
  >(null);
  const [withdrawalPreview, setWithdrawalPreview] = useState<
    DvdTitleDamageAcceptanceWithdrawalPreview | null
  >(null);
  const [withdrawalOperator, setWithdrawalOperator] = useState("");
  const [withdrawalRecorded, setWithdrawalRecorded] = useState(false);
  const requestVersion = useRef(0);
  const reviewSetIdentity = titleIdentity?.reviewSetIdentity ?? null;
  const evidenceGenerationKey = JSON.stringify(evidenceGeneration);

  const invalidatePreview = () => {
    requestVersion.current += 1;
    setPreview(null);
    setIsLoading(false);
    setError(null);
    setDamageAcknowledged(false);
    setRecordedDecision(null);
    setWithdrawalPreview(null);
    setWithdrawalRecorded(false);
  };

  useEffect(() => {
    requestVersion.current += 1;
    setExcluded(new Set());
    setMainFeatureResolutions(new Map());
    setPreview(null);
    setIsLoading(false);
    setError(null);
    setDamageAcknowledged(false);
    setRecordedDecision(null);
    setWithdrawalPreview(null);
    setWithdrawalOperator("");
    setWithdrawalRecorded(false);
  }, [evidenceGenerationKey, originalDiscArchiveId, reviewSetIdentity]);

  const toggle = (id: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    invalidatePreview();
  };
  const requestPreview = async () => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetcher(
        `/api/catalog-reviews/${encodeURIComponent(originalDiscArchiveId)}/title-damage-acceptance-preview`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            excludedTitleIdentityIds: [...excluded].sort(),
            mainFeatureResolutions: [...mainFeatureResolutions]
              .filter(([, titleIdentityId]) => titleIdentityId !== "")
              .map(([discSelectionId, titleIdentityId]) => ({
                discSelectionId,
                titleIdentityId,
              }))
              .sort((left, right) =>
                left.discSelectionId.localeCompare(right.discSelectionId)
              ),
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Title Damage Acceptance preflight request failed");
      }
      const result = await response.json() as DvdTitleDamageAcceptancePreview;
      if (requestVersion.current === version) setPreview(result);
    } catch {
      if (requestVersion.current === version) {
        setError("Title Damage Acceptance preflight is unavailable.");
      }
    } finally {
      if (requestVersion.current === version) setIsLoading(false);
    }
  };
  const submitDecision = async () => {
    if (
      preview?.available !== true || preview.previewToken === null ||
      preview.current?.checkpoint === null ||
      preview.assessmentIdentity === null ||
      preview.reviewSetIdentity === null ||
      preview.catalogMappingProjectionId === null ||
      preview.reviewedContentIdentity === null
    ) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetcher(
        `/api/catalog-reviews/${encodeURIComponent(originalDiscArchiveId)}/title-damage-acceptance`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mutationKey: createMutationKey(),
            operator,
            previewToken: preview.previewToken,
            checkpointRevision: preview.current.checkpoint.revision,
            checkpointDigest: preview.current.checkpoint.manifestDigest,
            assessmentIdentity: preview.assessmentIdentity,
            reviewSetIdentity: preview.reviewSetIdentity,
            catalogMappingProjectionId: preview.catalogMappingProjectionId,
            reviewedContentIdentity: preview.reviewedContentIdentity,
            excludedTitleIdentityIds: [...excluded].sort(),
            mainFeatureResolutions: [...mainFeatureResolutions]
              .filter(([, titleIdentityId]) => titleIdentityId !== "")
              .map(([discSelectionId, titleIdentityId]) => ({
                discSelectionId,
                titleIdentityId,
              }))
              .sort((left, right) =>
                left.discSelectionId.localeCompare(right.discSelectionId)
              ),
            damageAcknowledgement: damageAcknowledged,
          }),
        },
      );
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as
          | { error?: { code?: string; message?: string } }
          | null;
        throw new Error(problem?.error?.code ?? "acceptance_failed");
      }
      const result = await response.json() as {
        decision: { decision: "accepted" | "not_required" };
      };
      setRecordedDecision(result.decision.decision);
    } catch {
      setError(
        "Title Damage Acceptance was not recorded. Refresh the current evidence and preview again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };
  const requestWithdrawalPreview = async () => {
    const accepted = titleDamageDecision?.current;
    if (accepted?.decision !== "accepted") return;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetcher(
        `/api/catalog-reviews/${encodeURIComponent(originalDiscArchiveId)}/title-damage-acceptance-withdrawal-preview`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ acceptedDecisionId: accepted.id }),
        },
      );
      if (!response.ok) throw new Error("withdrawal_preview_failed");
      const result = await response.json() as
        DvdTitleDamageAcceptanceWithdrawalPreview;
      if (requestVersion.current === version) setWithdrawalPreview(result);
    } catch {
      if (requestVersion.current === version) {
        setError(
          "Title Damage Acceptance withdrawal preflight is unavailable.",
        );
      }
    } finally {
      if (requestVersion.current === version) setIsLoading(false);
    }
  };
  const submitWithdrawal = async () => {
    if (
      withdrawalPreview?.available !== true ||
      withdrawalPreview.previewToken === null ||
      withdrawalPreview.acceptedDecision === null
    ) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetcher(
        `/api/catalog-reviews/${encodeURIComponent(originalDiscArchiveId)}/title-damage-acceptance-withdrawal`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mutationKey: createMutationKey(),
            operator: withdrawalOperator,
            previewToken: withdrawalPreview.previewToken,
            acceptedDecisionId: withdrawalPreview.acceptedDecision.id,
          }),
        },
      );
      if (!response.ok) throw new Error("withdrawal_failed");
      setWithdrawalRecorded(true);
    } catch {
      setError(
        "Title Damage Acceptance was not withdrawn. Refresh the current decision and preview again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };
  const currentDecision = titleDamageDecision?.current;
  const currentDecisionLabel = currentDecision?.decision === "accepted"
    ? "Damage accepted"
    : currentDecision?.decision === "withdrawn"
    ? "Damage acceptance withdrawn"
    : "No damage acceptance required";
  const currentDecisionStatus = currentDecision === undefined ||
      currentDecision === null
    ? null
    : withdrawalRecorded
    ? `Damage acceptance withdrawn for the current exact reviewed set by ${withdrawalOperator}.`
    : `${currentDecisionLabel} for the current exact reviewed set by ${currentDecision.operator} at ${currentDecision.recordedAt}. ${currentDecision.snapshot.reviewedContent.length} included and ${currentDecision.snapshot.exclusions.length} excluded.`;

  return (
    <section
      className="catalog-pane catalog-title-damage-acceptance-preview"
      aria-labelledby="catalog-title-damage-acceptance-preview-heading"
    >
      <h3 id="catalog-title-damage-acceptance-preview-heading">
        Title Damage Acceptance preflight
      </h3>
      <p className="catalog-help">
        The complete discovered-content set is included. Exclude unwanted
        content explicitly, then preview the exact set. Previewing does not
        accept damage or queue encoding.
      </p>
      {titleDamageDecision === undefined ? null : (
        <section aria-labelledby="title-damage-decision-status-heading">
          <h4 id="title-damage-decision-status-heading">
            Current exact-set decision
          </h4>
          {titleDamageDecision.current !== null ? (
            <>
              <p role="status">{currentDecisionStatus}</p>
              {titleDamageDecision.current.decision !== "accepted" ||
                  withdrawalRecorded
                ? null
                : (
                  <div>
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={requestWithdrawalPreview}
                    >
                      Preview withdrawal
                    </button>
                    {withdrawalPreview === null ? null : (
                      <div>
                        <p>
                          Withdrawal preflight {
                            withdrawalPreview.available
                              ? "available"
                              : "unavailable"
                          }. {withdrawalPreview.affectedWork.length} queued or
                          running Encode Jobs affected.
                        </p>
                        {withdrawalPreview.acceptedDecision === null
                          ? null
                          : (
                            <p>
                              Withdrawal targets accepted decision{" "}
                              <code>
                                {withdrawalPreview.acceptedDecision.id}
                              </code>, recorded by{" "}
                              {withdrawalPreview.acceptedDecision.operator} at{" "}
                              {withdrawalPreview.acceptedDecision.recordedAt}.
                            </p>
                          )}
                        {withdrawalPreview.action.reasons.length === 0
                          ? null
                          : (
                            <ul className="catalog-workflow-reasons">
                              {withdrawalPreview.action.reasons.map((reason) => (
                                <li key={reason.code}>
                                  <code>{reason.code}</code>
                                  <span>{reason.message}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        <ul>
                          {withdrawalPreview.affectedWork.map((job) => (
                            <li key={job.id}>
                              Encode Job {job.id}: {job.status}.
                            </li>
                          ))}
                        </ul>
                        {!withdrawalPreview.available ? null : (
                          <fieldset>
                            <legend>
                              Withdraw Title Damage Acceptance decision
                            </legend>
                            <label>
                              Operator
                              <input
                                value={withdrawalOperator}
                                maxLength={128}
                                onChange={(event) =>
                                  setWithdrawalOperator(
                                    event.currentTarget.value,
                                  )}
                              />
                            </label>
                            <button
                              type="button"
                              disabled={
                                isSubmitting ||
                                withdrawalOperator.trim() === ""
                              }
                              onClick={submitWithdrawal}
                            >
                              Withdraw damage acceptance
                            </button>
                          </fieldset>
                        )}
                      </div>
                    )}
                  </div>
                )}
            </>
          ) : titleDamageDecision.state === "expired" &&
              titleDamageDecision.latest !== null ? (
            <p>
              The latest exact-set decision has expired because its bound
              evidence is no longer current. Preview the complete set again.
            </p>
          ) : (
            <p>No exact-set Title Damage decision is recorded.</p>
          )}
        </section>
      )}
      {items.length === 0 ? (
        <p>No current discovered content is available.</p>
      ) : (
        <fieldset>
          <legend>Complete discovered-content set</legend>
          {items.map((item) => (
            <label key={item.titleIdentityId}>
              <input
                type="checkbox"
                checked={excluded.has(item.titleIdentityId)}
                onChange={() => toggle(item.titleIdentityId)}
              />
              Exclude {contentLabel(item)}. Mapping: {item.mappingState}.
            </label>
          ))}
        </fieldset>
      )}
      <button type="button" disabled={isLoading} onClick={requestPreview}>
        {isLoading ? "Preparing preflight…" : "Preview exact review set"}
      </button>
      {error === null ? null : <p role="alert">{error}</p>}
      {preview === null ? null : (
        <div className="catalog-title-damage-acceptance-preview-result">
          <p>
            Preflight {preview.available ? "available" : "unavailable"}. {
              preview.reviewedContent.length
            } included, {preview.exclusions.length} excluded.
          </p>
          {preview.action.reasons.length === 0 ? null : (
            <ul className="catalog-workflow-reasons">
              {preview.action.reasons.map((reason) => (
                <li key={reason.code}>
                  <code>{reason.code}</code>
                  <span>{reason.message}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.unresolvedSelections.length === 0 ? null : (
            <section aria-labelledby="title-damage-unresolved-selections-heading">
              <h4 id="title-damage-unresolved-selections-heading">
                Unresolved Disc Selections
              </h4>
              <p className="catalog-help">
                These active selections no longer have a concrete binding in
                the current Title Identity review set.
              </p>
              <ul>
                {preview.unresolvedSelections.map((selection) => (
                  <li key={selection.discSelectionId}>
                    {mediaItemLabel(selection.mediaItem)}. {
                      selection.sourceIdentity.kind === "dvd_title"
                        ? `DVD title ${selection.sourceIdentity.titleNumber}`
                        : selection.sourceIdentity.kind === "dvd_chapters"
                        ? `DVD title ${selection.sourceIdentity.titleNumber}, chapters ${selection.sourceIdentity.chapterStart}-${selection.sourceIdentity.chapterEnd}`
                        : `Selection ${selection.sourceIdentity.kind}`
                    }. Disc Selection {selection.discSelectionId}.
                  </li>
                ))}
              </ul>
            </section>
          )}
          {preview.mainFeatureChoices.length === 0 ? null : (
            <fieldset>
              <legend>Resolve main-feature choices</legend>
              <p className="catalog-help">
                Bind each main-feature Disc Selection to exact discovered
                content, then preview again. No representative title is
                inferred.
              </p>
              {preview.mainFeatureChoices.map((choice) => (
                <label key={choice.discSelectionId}>
                  {mediaItemLabel(choice.mediaItem)}
                  <select
                    aria-label={`Resolved content for ${choice.mediaItem.title}`}
                    value={mainFeatureResolutions.get(choice.discSelectionId) ??
                      choice.resolvedTitleIdentityId ?? ""}
                    onChange={(event) => {
                      const titleIdentityId = event.currentTarget.value;
                      setMainFeatureResolutions((current) => {
                        const next = new Map(current);
                        next.set(choice.discSelectionId, titleIdentityId);
                        return next;
                      });
                      invalidatePreview();
                    }}
                  >
                    <option value="">Choose exact content</option>
                    {preview.allContent.map((item) => (
                      <option
                        key={item.titleIdentityId}
                        value={item.titleIdentityId}
                      >
                        DVD title {item.sourceIdentity.displayTitleNumber}, angle {
                          item.sourceIdentity.angleNumber
                        }, chapters {item.sourceIdentity.chapterStart}-{
                          item.sourceIdentity.chapterEnd
                        }
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
          {preview.evidenceFormat === null ? null : (
            <>
              <p>
                {preview.available
                  ? `Damage acknowledgement ${
                    preview.acknowledgementRequired
                      ? "is required for this exact set"
                      : "is not required for this clean exact set"
                  }.`
                  : "Damage acknowledgement has not been determined because the preflight is unavailable."}
              </p>
              <ul className="stack-list">
                {preview.allContent.map((item) => (
                  <li key={item.titleIdentityId}>
                    <strong>
                      DVD title {item.sourceIdentity.displayTitleNumber}, angle {
                        item.sourceIdentity.angleNumber
                      }
                    </strong>
                    <span>
                      Chapters {item.sourceIdentity.chapterStart}-{
                        item.sourceIdentity.chapterEnd
                      }. {item.included ? "Included" : "Excluded"}.
                    </span>
                    <span>
                      Title Identity <code>{item.titleIdentityId}</code>.
                    </span>
                    <span>
                      Navigation: video title set {
                        item.sourceIdentity.navigation.videoTitleSetNumber
                      }, title-set title {
                        item.sourceIdentity.navigation.titleSetTitleNumber
                      }, program chain {
                        item.sourceIdentity.navigation.programChainNumber
                      }. Selected path: {
                        item.sourceIdentity.selectedPath.map((cell) =>
                          `program ${cell.programNumber}, cell ${cell.cellNumber}, VOB ${cell.vobId}, cell ID ${cell.cellId}`
                        ).join("; ")
                      }.
                    </span>
                    {item.catalogMappings.length === 0 ? (
                      <span>Unmapped source identity.</span>
                    ) : (
                      <ul>
                        {item.catalogMappings.map((mapping) => (
                          <li key={mapping.discSelectionId}>
                            {mediaItemLabel(mapping.mediaItem)}. {
                              mapping.sourceIdentity.kind === "main_feature"
                                ? "Main-feature choice"
                                : `Selection ${mapping.sourceIdentity.kind}`
                            } resolved by its Title Identity binding to DVD title {
                              mapping.resolvedSourceIdentity.displayTitleNumber
                            }, angle {
                              mapping.resolvedSourceIdentity.angleNumber
                            }, chapters {
                              mapping.resolvedSourceIdentity.chapterStart
                            }-{
                              mapping.resolvedSourceIdentity.chapterEnd
                            }.
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.assessmentSnapshot === null ? (
                      <span>Current assessment snapshot unavailable.</span>
                    ) : (
                      <CatalogReviewTitleDamageAssessmentEvidence
                        assessment={item.assessmentSnapshot}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {preview.assessmentSnapshot === null ? null : (
                <section aria-labelledby="title-damage-unknown-coverage-heading">
                  <h4 id="title-damage-unknown-coverage-heading">
                    Damage and unknown coverage
                  </h4>
                  <p>
                    Unknown title impact: {
                      preview.assessmentSnapshot.unknownTitleImpact
                        .unrecoveredSourceSectorCount
                    } unrecovered source sectors. Unattributed
                    source-continuity risk: {
                      preview.assessmentSnapshot
                        .unattributedSourceContinuityRisk?.sourceSectorCount ?? 0
                    } source sectors.
                  </p>
                  {preview.assessmentSnapshot.unknownTitleImpact.reasons.length ===
                      0
                    ? <p>No archive-level unknown-impact reasons.</p>
                    : (
                      <ul>
                        {preview.assessmentSnapshot.unknownTitleImpact.reasons
                          .map((reason) => (
                            <li key={reason.code}>
                              <code>{reason.code}</code> {reason.message}
                            </li>
                          ))}
                      </ul>
                    )}
                </section>
              )}
              <section aria-labelledby="title-damage-affected-work-heading">
                <h4 id="title-damage-affected-work-heading">Affected work</h4>
                {preview.affectedWork.length === 0 ? (
                  <p>No Encode Jobs are affected by this exact set.</p>
                ) : (
                  <ul>
                    {preview.affectedWork.map((job) => (
                      <li key={job.id}>
                        Encode Job {job.id}: {job.status}; Disc Selection {
                          job.discSelectionId
                        }.
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <p>
                A Damage Preview is optional. Its unavailability does not block
                this preflight.
              </p>
              {preview.previewToken === null ? null : (
                <details>
                  <summary>Preflight identities</summary>
                  <dl className="catalog-summary-list">
                    <div>
                      <dt>Preview token</dt>
                      <dd>{preview.previewToken}</dd>
                    </div>
                    <div>
                      <dt>Review set</dt>
                      <dd>{preview.reviewSetIdentity}</dd>
                    </div>
                    <div>
                      <dt>Assessment</dt>
                      <dd>{preview.assessmentIdentity}</dd>
                    </div>
                    <div>
                      <dt>Reviewed content</dt>
                      <dd>{preview.reviewedContentIdentity}</dd>
                    </div>
                  </dl>
                </details>
              )}
              {!preview.available ? null : (
                <fieldset>
                  <legend>Record exact-set decision</legend>
                  <label>
                    Operator
                    <input
                      value={operator}
                      maxLength={128}
                      onChange={(event) => setOperator(event.currentTarget.value)}
                    />
                  </label>
                  {!preview.acknowledgementRequired ? null : (
                    <label>
                      <input
                        type="checkbox"
                        checked={damageAcknowledged}
                        onChange={(event) =>
                          setDamageAcknowledged(event.currentTarget.checked)}
                      />
                      I accept the reported damage or unknown impact for this
                      exact reviewed set.
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={
                      isSubmitting || operator.trim() === "" ||
                      (preview.acknowledgementRequired && !damageAcknowledged)
                    }
                    onClick={submitDecision}
                  >
                    {isSubmitting
                      ? "Recording decision…"
                      : preview.acknowledgementRequired
                      ? "Accept exact reviewed set"
                      : "Record clean reviewed set"}
                  </button>
                  {recordedDecision === null ? null : (
                    <p role="status">
                      {recordedDecision === "accepted"
                        ? "Damage accepted for this exact reviewed set."
                        : "This exact reviewed set is clean and needs no damage acceptance."}
                    </p>
                  )}
                </fieldset>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
