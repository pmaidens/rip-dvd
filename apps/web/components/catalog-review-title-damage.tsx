"use client";

import { useEffect, useState } from "react";

import type { CatalogReviewTitleDamage } from "./catalog-review-model";

function percentage(value: number): string {
  if (value > 0 && value < 0.01) return "<0.01%";
  return `${value.toFixed(2).replace(/\.00$/, "")}%`;
}

export function CatalogReviewTitleDamageEvidence({
  originalDiscArchiveId,
  titleDamage,
}: {
  originalDiscArchiveId: string;
  titleDamage?: CatalogReviewTitleDamage;
}) {
  const [items, setItems] = useState(titleDamage?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [firstPageLoaded, setFirstPageLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    setItems(titleDamage?.items ?? []);
    setNextCursor(null);
    setFirstPageLoaded(false);
    setIsLoading(false);
    setPageError(null);
  }, [originalDiscArchiveId, titleDamage]);

  if (
    titleDamage === undefined ||
    titleDamage.unavailableReasons.some((reason) =>
      reason.code === "UNSUPPORTED_EVIDENCE_FORMAT"
    )
  ) {
    return null;
  }
  const expectedAssessmentIdentity = titleDamage.assessmentIdentity;
  const canLoadMore = titleDamage.state === "current" &&
    (firstPageLoaded ? nextCursor !== null : titleDamage.truncated);

  async function loadMore(): Promise<void> {
    if (!canLoadMore || isLoading) return;
    setIsLoading(true);
    setPageError(null);
    try {
      const parameters = new URLSearchParams({ limit: "100" });
      if (firstPageLoaded && nextCursor !== null) {
        parameters.set("cursor", nextCursor);
      }
      const response = await fetch(
        `/api/catalog-reviews/${encodeURIComponent(originalDiscArchiveId)}/damage?${parameters}`,
        { headers: { Accept: "application/json" } },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "Title Damage evidence changed. Reload the Catalog Review."
            : "Title Damage evidence could not be loaded.",
        );
      }
      if (
        typeof body !== "object" || body === null ||
        !("assessmentIdentity" in body) ||
        body.assessmentIdentity !== expectedAssessmentIdentity ||
        !("currentAssessmentIdentity" in body) ||
        body.currentAssessmentIdentity !== expectedAssessmentIdentity ||
        !("state" in body) || body.state !== "current" ||
        !("items" in body) || !Array.isArray(body.items) ||
        !("nextCursor" in body) ||
        (body.nextCursor !== null && typeof body.nextCursor !== "string")
      ) {
        throw new Error(
          "Title Damage evidence changed. Reload the Catalog Review.",
        );
      }
      const pageItems = body.items as CatalogReviewTitleDamage["items"];
      const pageCursor = body.nextCursor as string | null;
      setItems((current) =>
        firstPageLoaded ? [...current, ...pageItems] : pageItems
      );
      setNextCursor(pageCursor);
      setFirstPageLoaded(true);
    } catch (error) {
      setPageError(
        error instanceof Error
          ? error.message
          : "Title Damage evidence could not be loaded.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="catalog-pane" aria-labelledby="title-damage-heading">
      <h3 id="title-damage-heading">Title missing source</h3>
      {titleDamage.state === "outdated" ? (
        <p>
          This assessment belongs to checkpoint {
            titleDamage.checkpointRevision
          } and is outdated.
        </p>
      ) : titleDamage.state === "pending" ||
          titleDamage.state === "unavailable" ? (
          <ul>
            {titleDamage.unavailableReasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
        ) : (
          <p>Checkpoint {titleDamage.checkpointRevision}.</p>
        )}
      {items.length > 0 ? (
        <ul className="stack-list">
          {items.map((item) => (
            <li key={item.titleIdentityObservationId}>
              <strong>DVD title {item.displayTitleNumber}</strong>
              <span>
                Angle {item.selection.angleNumber}; chapters {
                  item.selection.chapterStart
                }–{item.selection.chapterEnd}.
              </span>
              <span>
                {item.unrecoveredUniqueSourceSectorCount} known unrecovered {
                  item.unrecoveredUniqueSourceSectorCount === 1
                    ? "source sector"
                    : "source sectors"
                }.
              </span>
              {item.titleMissingSourcePercentage === null ? (
                <>
                  <span>
                    Complete Title Missing-Source Percentage unavailable.
                  </span>
                  <ul>
                    {item.mappingCoverage.unknownReasons.map((reason) => (
                      <li key={reason.code}>{reason.message}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <span>
                  Title Missing-Source Percentage: {
                    percentage(item.titleMissingSourcePercentage)
                  } ({item.unrecoveredUniqueSourceSectorCount} of {
                    item.uniqueSourceSectorCount
                  } unique source sectors).
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {titleDamage.noTitleMissingSourceProved ? (
        <p>
          Complete source maps contain no unrecovered source in the selected
          title paths.
        </p>
      ) : null}
      {titleDamage.unknownTitleImpact !== null &&
          (titleDamage.unknownTitleImpact.unrecoveredSourceSectorCount > 0 ||
            titleDamage.unknownTitleImpact.reasons.length > 0) ? (
          <div>
            <p>
              Unknown title impact: {
                titleDamage.unknownTitleImpact.unrecoveredSourceSectorCount
              } unrecovered source {
                titleDamage.unknownTitleImpact.unrecoveredSourceSectorCount === 1
                  ? "sector is"
                  : "sectors are"
              } outside known title paths.
            </p>
            <ul>
              {titleDamage.unknownTitleImpact.reasons.map((reason) => (
                <li key={reason.code}>{reason.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      {pageError === null ? null : <p role="alert">{pageError}</p>}
      {canLoadMore ? (
        <button type="button" disabled={isLoading} onClick={loadMore}>
          {isLoading
            ? "Loading Title Damage evidence…"
            : "Load more Title Damage evidence"}
        </button>
      ) : null}
    </section>
  );
}
