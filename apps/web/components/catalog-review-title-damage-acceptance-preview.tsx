"use client";

import { useEffect, useRef, useState } from "react";
import type {
  DvdTitleDamageAcceptancePreview,
} from "@rip-dvd/application";

import type {
  CatalogReviewTitleIdentity,
} from "./catalog-review-model";

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

export function CatalogReviewTitleDamageAcceptancePreview({
  originalDiscArchiveId,
  titleIdentity,
  fetcher = fetch,
}: {
  originalDiscArchiveId: string;
  titleIdentity?: CatalogReviewTitleIdentity;
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
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const reviewSetIdentity = titleIdentity?.reviewSetIdentity ?? null;

  const invalidatePreview = () => {
    requestVersion.current += 1;
    setPreview(null);
    setIsLoading(false);
    setError(null);
  };

  useEffect(() => {
    requestVersion.current += 1;
    setExcluded(new Set());
    setMainFeatureResolutions(new Map());
    setPreview(null);
    setIsLoading(false);
    setError(null);
  }, [originalDiscArchiveId, reviewSetIdentity]);

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
                    {selection.mediaItem.kind}: {selection.mediaItem.title}. {
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
                  {choice.mediaItem.kind}: {choice.mediaItem.title}
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
                Damage acknowledgement {preview.acknowledgementRequired
                  ? "is required for this exact set"
                  : "is not required for this clean exact set"}.
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
                    {item.catalogMappings.length === 0 ? (
                      <span>Unmapped source identity.</span>
                    ) : (
                      <ul>
                        {item.catalogMappings.map((mapping) => (
                          <li key={mapping.discSelectionId}>
                            {mapping.mediaItem.kind}: {mapping.mediaItem.title}. {
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
                      <span>
                        {item.assessmentSnapshot.unrecoveredUniqueSourceSectorCount}
                        {" unrecovered source sectors; "}
                        {item.assessmentSnapshot.sourceContinuityRiskSectorCount}
                        {" source-continuity-risk sectors; "}
                        {item.assessmentSnapshot.mappingCoverage.state}
                        {" mapping coverage."}
                      </span>
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
            </>
          )}
        </div>
      )}
    </section>
  );
}
