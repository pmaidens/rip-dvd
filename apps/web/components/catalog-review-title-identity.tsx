import type {
  CatalogReviewTitleIdentity,
} from "./catalog-review-model";

function continuityLabel(result: "initial" | "proved" | "uncertain" | "new") {
  switch (result) {
    case "initial":
      return "Initial checkpoint observation";
    case "proved":
      return "Continuity proved";
    case "uncertain":
      return "Continuity uncertain";
    case "new":
      return "Newly discovered content";
  }
}

function mappingLabel(
  state: "mapped" | "needs_mapping_review" | "unmapped",
) {
  switch (state) {
    case "mapped":
      return "Disc Selection attached";
    case "needs_mapping_review":
      return "Needs mapping review";
    case "unmapped":
      return "Unmapped";
  }
}

export function CatalogReviewTitleIdentity({
  titleIdentity,
}: {
  titleIdentity?: CatalogReviewTitleIdentity;
}) {
  if (
    titleIdentity === undefined ||
    titleIdentity.unavailableReason === "UNSUPPORTED_EVIDENCE_FORMAT"
  ) {
    return null;
  }
  if (!titleIdentity.available) {
    return (
      <section className="catalog-pane" aria-labelledby="title-identity-heading">
        <h3 id="title-identity-heading">Title identity across revisions</h3>
        <p>
          Title Identity observations have not been recorded for checkpoint {
            titleIdentity.checkpoint?.manifestRevision
          }.
        </p>
      </section>
    );
  }
  return (
    <section className="catalog-pane" aria-labelledby="title-identity-heading">
      <h3 id="title-identity-heading">Title identity across revisions</h3>
      <p>
        Checkpoint {titleIdentity.checkpoint.manifestRevision}. Display title
        numbers do not establish continuity.
      </p>
      {titleIdentity.items.length === 0
        ? <p>No title content was discovered at this checkpoint.</p>
        : (
          <ul className="stack-list">
            {titleIdentity.items.map((item) => (
              <li key={item.titleIdentityId}>
                <strong>
                  DVD title {item.observation.displayTitleNumber}
                </strong>
                <span>
                  {continuityLabel(item.reviewContinuity.result)}. {
                    mappingLabel(item.mappingState)
                  }.
                </span>
                {!item.presentAtCurrentCheckpoint
                  ? <span>Not observed at the current checkpoint.</span>
                  : null}
                {item.discSelectionMappings.length > 0
                  ? (
                    <ul>
                      {item.discSelectionMappings.map((mapping) => (
                        <li key={mapping.discSelectionId}>
                          Retained Disc Selection ID: {
                            mapping.discSelectionId
                          }. {mappingLabel(mapping.mappingState)}.
                        </li>
                      ))}
                    </ul>
                  )
                  : null}
                <span>
                  VTS {item.observation.navigation.videoTitleSetNumber}, VTS
                  title {item.observation.navigation.titleSetTitleNumber}, PGC {
                    item.observation.navigation.programChainNumber
                  }; angle {item.observation.angleNumber} of {
                    item.observation.angleCount
                  }; chapters {item.observation.chapterStart}–{
                    item.observation.chapterEnd
                  } of {item.observation.chapterCount}; {
                    item.observation.sourceExtents.length
                  } source {item.observation.sourceExtents.length === 1
                    ? "extent"
                    : "extents"}.
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
