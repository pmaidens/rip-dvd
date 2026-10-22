import type { CatalogReviewTitleDamage } from "./catalog-review-model";

function percentage(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/, "")}%`;
}

export function CatalogReviewTitleDamageEvidence({
  titleDamage,
}: {
  titleDamage?: CatalogReviewTitleDamage;
}) {
  if (
    titleDamage === undefined ||
    titleDamage.unavailableReasons.some((reason) =>
      reason.code === "UNSUPPORTED_EVIDENCE_FORMAT"
    )
  ) {
    return null;
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
      {titleDamage.items.length > 0 ? (
        <ul className="stack-list">
          {titleDamage.items.map((item) => (
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
      {titleDamage.truncated ? (
        <p>More Title Damage evidence is available through paging.</p>
      ) : null}
    </section>
  );
}
