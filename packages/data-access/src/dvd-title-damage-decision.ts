import type {
  DiscSelectionId,
  DvdTitleDamageDecision,
} from "./types.js";

export function dvdTitleDamageDecisionSelectionIds(
  decision: Pick<DvdTitleDamageDecision, "snapshot">,
): DiscSelectionId[] {
  return [...new Set(decision.snapshot.reviewedContent.flatMap((content) =>
    content.catalogMappings.map((mapping) => mapping.discSelectionId)
  ))].sort();
}
