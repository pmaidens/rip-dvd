import type {
  CatalogReviewCoverage,
  CatalogReviewOutcome,
  CompletedCatalogReviewOutcome,
} from "@rip-dvd/data-access";
import { useEffect, useRef, useState } from "react";

import { formatCountLabel } from "../lib/format-count-label";
import type { CatalogReviewReplacementPlan } from "./catalog-review-model";
import {
  MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES,
  type CatalogReviewReplacementEncodeInput,
} from "../lib/catalog-review-command";

interface CatalogReviewCompletionProps {
  isSaving: boolean;
  coverage: CatalogReviewCoverage;
  reviewOutcome: CatalogReviewOutcome;
  archiveOnlySelected: boolean;
  replacementPlan?: CatalogReviewReplacementPlan;
  onArchiveOnlyChange(selected: boolean): void;
  onReplacementJobsPage?(offset: number): void;
  onReplacementProfilesPage?(offset: number): void;
  onComplete(
    outcome: CompletedCatalogReviewOutcome,
    replacements: CatalogReviewReplacementEncodeInput[],
  ): void;
}

export function CatalogReviewCompletion({
  isSaving,
  coverage,
  reviewOutcome,
  archiveOnlySelected,
  replacementPlan,
  onArchiveOnlyChange,
  onReplacementJobsPage = () => undefined,
  onReplacementProfilesPage = () => undefined,
  onComplete,
}: CatalogReviewCompletionProps) {
  const hasSelections = coverage.discSelectionCount > 0;
  const isPending = reviewOutcome === "needs_review";
  const completionOutcome: CompletedCatalogReviewOutcome = hasSelections
    ? "reviewed_with_selections"
    : "archive_only";
  const selectedReplacements = useRef(
    new Map<string, CatalogReviewReplacementEncodeInput>(),
  );
  const knownReplacementIdsByOffset = useRef(new Map<number, Set<string>>());
  const [, setReplacementSelectionRevision] = useState(0);
  const [replacementLimitError, setReplacementLimitError] = useState(false);
  const replacementPageOffset = replacementPlan?.jobsPage.offset;
  const replacementPageJobIds = replacementPlan?.jobs
    .map((job) => job.predecessorEncodeJobId)
    .join("\0");
  useEffect(() => {
    if (
      replacementPageOffset === undefined ||
      replacementPageJobIds === undefined
    ) {
      const changed = selectedReplacements.current.size > 0;
      selectedReplacements.current.clear();
      knownReplacementIdsByOffset.current.clear();
      if (changed) setReplacementSelectionRevision((revision) => revision + 1);
      return;
    }
    const currentIds = new Set(
      replacementPageJobIds === "" ? [] : replacementPageJobIds.split("\0"),
    );
    const priorIds = knownReplacementIdsByOffset.current.get(
      replacementPageOffset,
    );
    let changed = false;
    for (const predecessorId of priorIds ?? []) {
      if (!currentIds.has(predecessorId)) {
        changed =
          selectedReplacements.current.delete(predecessorId) || changed;
      }
    }
    knownReplacementIdsByOffset.current.set(replacementPageOffset, currentIds);
    if (changed) setReplacementSelectionRevision((revision) => revision + 1);
  }, [replacementPageJobIds, replacementPageOffset]);
  const capturePage = (formElement: HTMLFormElement) => {
    const form = new FormData(formElement);
    for (const job of replacementPlan?.jobs ?? []) {
      const field = `replacement:${job.predecessorEncodeJobId}`;
      if (form.get(`${field}:selected`) === null) {
        selectedReplacements.current.delete(job.predecessorEncodeJobId);
      }
    }
    let exceedsLimit = false;
    for (const job of replacementPlan?.jobs ?? []) {
      const field = `replacement:${job.predecessorEncodeJobId}`;
      if (form.get(`${field}:selected`) === null) {
        continue;
      }
      if (
        !selectedReplacements.current.has(job.predecessorEncodeJobId) &&
        selectedReplacements.current.size >=
          MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES
      ) {
        exceedsLimit = true;
        continue;
      }
      selectedReplacements.current.set(job.predecessorEncodeJobId, {
        predecessorEncodeJobId:
          job.predecessorEncodeJobId as CatalogReviewReplacementEncodeInput["predecessorEncodeJobId"],
        encodingProfileId: String(
          form.get(`${field}:profile`) ?? "",
        ) as CatalogReviewReplacementEncodeInput["encodingProfileId"],
        outputPath: String(form.get(`${field}:output`) ?? "").trim(),
      });
    }
    setReplacementLimitError(exceedsLimit);
    return !exceedsLimit;
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capturePage(event.currentTarget)) return;
    onComplete(completionOutcome, [...selectedReplacements.current.values()]);
  };
  const selectedReplacementCount = selectedReplacements.current.size;
  return (
    <section
      className="catalog-complete"
      aria-labelledby="catalog-review-coverage"
    >
      <h3 id="catalog-review-coverage">Review Coverage</h3>
      <p className="catalog-help">
        Coverage always includes the complete archive, regardless of title
        filters or collapsed sections.
      </p>
      <dl className="catalog-coverage-summary">
        <div>
          <dt>Cataloged output</dt>
          <dd>
            {formatCountLabel(
              coverage.mediaItemsWithSelections,
              "Media Item with Disc Selections",
              "Media Items with Disc Selections",
            )}
          </dd>
        </div>
        <div>
          <dt>Scanned-title coverage</dt>
          <dd>{formatCountLabel(coverage.mappedTitles, "mapped title")}</dd>
          <dd>
            {formatCountLabel(
              coverage.partiallyMappedTitles,
              "partially mapped title",
            )}
          </dd>
          <dd>
            {formatCountLabel(coverage.unmappedTitles, "unmapped title")}
          </dd>
        </div>
        <div>
          <dt>Separate archive-level source</dt>
          <dd>
            {formatCountLabel(
              coverage.mainFeatureSelections,
              "main-feature selection",
            )}
          </dd>
        </div>
      </dl>

      <form className="catalog-complete-action" onSubmit={submit}>
        {replacementPlan ? (
          <fieldset className="catalog-replacement-plan">
            <legend>Corrected replacement encodes</legend>
            <p className="catalog-help">
              Choose replacements explicitly. Prior profiles and output paths
              are proposals and remain editable before review completes. Up to
              {` ${MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES} replacements `}
              may be queued in one atomic review completion.
            </p>
            {selectedReplacementCount >=
                MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES ? (
              <p className="catalog-help" role="status">
                {MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES} replacements selected
                {" — deselect one before choosing another"}
              </p>
            ) : null}
            {replacementLimitError ? (
              <p className="catalog-error" role="alert">
                Select no more than
                {` ${MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES} replacement encodes.`}
              </p>
            ) : null}
            <ul className="catalog-replacement-jobs">
              {replacementPlan.jobs.map((job) => {
                const field = `replacement:${job.predecessorEncodeJobId}`;
                const selected = selectedReplacements.current.get(
                  job.predecessorEncodeJobId,
                );
                return (
                  <li key={job.predecessorEncodeJobId}>
                    <label>
                      <input
                        type="checkbox"
                        name={`${field}:selected`}
                        defaultChecked={selected !== undefined}
                        disabled={
                          isSaving ||
                          !isPending ||
                          (selected === undefined &&
                            selectedReplacementCount >=
                              MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES)
                        }
                      />
                      <span>Queue corrected replacement</span>
                    </label>
                    <p className="catalog-help">
                      Encode Job {job.predecessorEncodeJobId}
                    </p>
                    <p className="catalog-help" role="status">
                      {job.predecessorReady
                        ? "Predecessor ready; replacement starts after review"
                        : "Waiting for previous encode to stop"}
                    </p>
                    <div className="profile-fields encode-job-fields">
                      <label>
                        Encoding Profile
                        <select
                          name={`${field}:profile`}
                          defaultValue={
                            selected?.encodingProfileId ??
                            job.proposedEncodingProfileId
                          }
                          disabled={isSaving || !isPending}
                          required
                        >
                          {selected && !replacementPlan.encodingProfiles.some(
                              (profile) => profile.id === selected.encodingProfileId
                            ) ? (
                            <option value={selected.encodingProfileId}>
                              Selected profile · {selected.encodingProfileId}
                            </option>
                          ) : null}
                          {replacementPlan.encodingProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {`${profile.displayName} · Version ${profile.version}${
                                profile.isActive ? "" : " · Prior version"
                              }`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Final output path
                        <input
                          name={`${field}:output`}
                          defaultValue={selected?.outputPath ?? job.proposedOutputPath}
                          disabled={isSaving || !isPending}
                          maxLength={4_096}
                          required
                        />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="operation-actions">
              <button
                type="button"
                disabled={!replacementPlan.jobsPage.hasPrevious || isSaving}
                onClick={(event) => {
                  if (
                    event.currentTarget.form &&
                    !capturePage(event.currentTarget.form)
                  ) return;
                  onReplacementJobsPage(Math.max(
                    0,
                    replacementPlan.jobsPage.offset - replacementPlan.jobsPage.limit,
                  ));
                }}
              >Previous affected Encode Jobs</button>
              <button
                type="button"
                disabled={!replacementPlan.jobsPage.hasNext || isSaving}
                onClick={(event) => {
                  if (
                    event.currentTarget.form &&
                    !capturePage(event.currentTarget.form)
                  ) return;
                  onReplacementJobsPage(
                    replacementPlan.jobsPage.offset + replacementPlan.jobsPage.limit,
                  );
                }}
              >Next affected Encode Jobs</button>
              <button
                type="button"
                disabled={!replacementPlan.encodingProfilesPage.hasPrevious || isSaving}
                onClick={(event) => {
                  if (
                    event.currentTarget.form &&
                    !capturePage(event.currentTarget.form)
                  ) return;
                  onReplacementProfilesPage(Math.max(
                    0,
                    replacementPlan.encodingProfilesPage.offset -
                      replacementPlan.encodingProfilesPage.limit,
                  ));
                }}
              >Previous Encoding Profiles</button>
              <button
                type="button"
                disabled={!replacementPlan.encodingProfilesPage.hasNext || isSaving}
                onClick={(event) => {
                  if (
                    event.currentTarget.form &&
                    !capturePage(event.currentTarget.form)
                  ) return;
                  onReplacementProfilesPage(
                    replacementPlan.encodingProfilesPage.offset +
                      replacementPlan.encodingProfilesPage.limit,
                  );
                }}
              >Next Encoding Profiles</button>
            </div>
          </fieldset>
        ) : null}
        <div className="catalog-archive-only-choice">
          <label>
            <input
              type="checkbox"
              aria-describedby="catalog-archive-only-explanation"
              checked={!hasSelections && archiveOnlySelected}
              disabled={isSaving || hasSelections || !isPending}
              onChange={(event) => onArchiveOnlyChange(event.target.checked)}
            />
            <span>
              Archive only — I intentionally want no content from this archive
              encoded
            </span>
          </label>
          {hasSelections ? (
            <p className="catalog-help" id="catalog-archive-only-explanation">
              Archive only is unavailable while Disc Selections are active.
            </p>
          ) : (
            <p className="catalog-help" id="catalog-archive-only-explanation">
              Select Archive only explicitly to distinguish this outcome from
              an incomplete review.
            </p>
          )}
        </div>
        <div className="catalog-complete-submit">
          <p id="catalog-complete-explanation">
            Completing review removes this archive from the dashboard queue.
            {!isPending
              ? " This Catalog Review is already complete."
              : !hasSelections && !archiveOnlySelected
                ? " Select Archive only before completing a review with no Disc Selections."
                : null}
          </p>
          <button
            type="submit"
            aria-describedby="catalog-complete-explanation"
            disabled={
              isSaving ||
              !isPending ||
              (!hasSelections && !archiveOnlySelected)
            }
          >
            {replacementPlan
              ? "Complete review and queue selected replacements"
              : "Complete review"}
          </button>
        </div>
      </form>
    </section>
  );
}
