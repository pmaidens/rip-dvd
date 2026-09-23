"use client";

import { useEffect, useRef, useState } from "react";

import {
  MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES,
  type CatalogReviewReplacementEncodeInput,
} from "../lib/catalog-review-command";
import type { CatalogReviewReplacementPlan } from "./catalog-review-model";

interface CatalogReviewReplacementEncodesProps {
  isSaving: boolean;
  isAvailable: boolean;
  replacementPlan: CatalogReviewReplacementPlan;
  selectedReplacements: ReadonlyMap<
    string,
    CatalogReviewReplacementEncodeInput
  >;
  onSelectionChange(
    selected: Map<string, CatalogReviewReplacementEncodeInput>,
  ): void;
  onJobsPage(offset: number): void;
  onProfilesPage(offset: number): void;
}

export function CatalogReviewReplacementEncodes({
  isSaving,
  isAvailable,
  replacementPlan,
  selectedReplacements,
  onSelectionChange,
  onJobsPage,
  onProfilesPage,
}: CatalogReviewReplacementEncodesProps) {
  const [drafts, setDrafts] = useState(
    new Map<string, CatalogReviewReplacementEncodeInput>(),
  );
  const knownJobIdsByOffset = useRef(new Map<number, Set<string>>());
  const pageJobIds = replacementPlan.jobs.map(
    (job) => job.predecessorEncodeJobId,
  ).join("\0");

  useEffect(() => {
    const currentIds = new Set(pageJobIds === "" ? [] : pageJobIds.split("\0"));
    const priorIds = knownJobIdsByOffset.current.get(
      replacementPlan.jobsPage.offset,
    );
    const next = new Map(selectedReplacements);
    let changed = false;
    for (const predecessorId of priorIds ?? []) {
      if (!currentIds.has(predecessorId)) {
        changed = next.delete(predecessorId) || changed;
      }
    }
    knownJobIdsByOffset.current.set(
      replacementPlan.jobsPage.offset,
      currentIds,
    );
    if (changed) onSelectionChange(next);
  }, [
    onSelectionChange,
    pageJobIds,
    replacementPlan.jobsPage.offset,
    selectedReplacements,
  ]);

  const replacementValue = (
    job: CatalogReviewReplacementPlan["jobs"][number],
  ): CatalogReviewReplacementEncodeInput =>
    selectedReplacements.get(job.predecessorEncodeJobId) ??
    drafts.get(job.predecessorEncodeJobId) ?? {
      predecessorEncodeJobId:
        job.predecessorEncodeJobId as CatalogReviewReplacementEncodeInput["predecessorEncodeJobId"],
      encodingProfileId:
        job.proposedEncodingProfileId as CatalogReviewReplacementEncodeInput["encodingProfileId"],
      outputPath: job.proposedOutputPath,
    };
  const updateReplacement = (
    job: CatalogReviewReplacementPlan["jobs"][number],
    change: Partial<CatalogReviewReplacementEncodeInput>,
  ) => {
    const value = { ...replacementValue(job), ...change };
    setDrafts((current) => new Map(current).set(
      job.predecessorEncodeJobId,
      value,
    ));
    if (selectedReplacements.has(job.predecessorEncodeJobId)) {
      onSelectionChange(new Map(selectedReplacements).set(
        job.predecessorEncodeJobId,
        value,
      ));
    }
  };
  const selectedReplacementCount = selectedReplacements.size;

  return (
    <fieldset className="catalog-replacement-plan">
      <legend>Corrected replacement encodes</legend>
      <p className="catalog-help">
        Choose replacements explicitly. Prior profiles and output paths are
        proposals and remain editable before this review is accepted. Up to
        {` ${MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES} replacements `}
        may be queued in one atomic operation.
      </p>
      {selectedReplacementCount >=
          MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES ? (
        <p className="catalog-help" role="status">
          {MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES} replacements selected
          {"; deselect one before choosing another"}
        </p>
      ) : null}
      <ul className="catalog-replacement-jobs">
        {replacementPlan.jobs.map((job) => {
          const field = `replacement:${job.predecessorEncodeJobId}`;
          const selected = selectedReplacements.has(
            job.predecessorEncodeJobId,
          );
          const value = replacementValue(job);
          return (
            <li key={job.predecessorEncodeJobId}>
              <label>
                <input
                  type="checkbox"
                  name={`${field}:selected`}
                  checked={selected}
                  disabled={
                    isSaving || !isAvailable ||
                    (!selected && selectedReplacementCount >=
                      MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES)
                  }
                  onChange={(event) => {
                    const next = new Map(selectedReplacements);
                    if (event.target.checked) {
                      next.set(job.predecessorEncodeJobId, value);
                    } else {
                      next.delete(job.predecessorEncodeJobId);
                    }
                    onSelectionChange(next);
                  }}
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
                    value={value.encodingProfileId}
                    disabled={isSaving || !isAvailable}
                    required
                    onChange={(event) => updateReplacement(job, {
                      encodingProfileId:
                        event.target.value as CatalogReviewReplacementEncodeInput["encodingProfileId"],
                    })}
                  >
                    {!replacementPlan.encodingProfiles.some(
                      (profile) => profile.id === value.encodingProfileId,
                    ) ? (
                      <option value={value.encodingProfileId}>
                        Selected profile · {value.encodingProfileId}
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
                    value={value.outputPath}
                    disabled={isSaving || !isAvailable}
                    maxLength={4_096}
                    required
                    onChange={(event) => updateReplacement(job, {
                      outputPath: event.target.value,
                    })}
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
          onClick={() => onJobsPage(Math.max(
            0,
            replacementPlan.jobsPage.offset -
              replacementPlan.jobsPage.limit,
          ))}
        >Previous affected Encode Jobs</button>
        <button
          type="button"
          disabled={!replacementPlan.jobsPage.hasNext || isSaving}
          onClick={() => onJobsPage(
            replacementPlan.jobsPage.offset +
              replacementPlan.jobsPage.limit,
          )}
        >Next affected Encode Jobs</button>
        <button
          type="button"
          disabled={
            !replacementPlan.encodingProfilesPage.hasPrevious || isSaving
          }
          onClick={() => onProfilesPage(Math.max(
            0,
            replacementPlan.encodingProfilesPage.offset -
              replacementPlan.encodingProfilesPage.limit,
          ))}
        >Previous Encoding Profiles</button>
        <button
          type="button"
          disabled={
            !replacementPlan.encodingProfilesPage.hasNext || isSaving
          }
          onClick={() => onProfilesPage(
            replacementPlan.encodingProfilesPage.offset +
              replacementPlan.encodingProfilesPage.limit,
          )}
        >Next Encoding Profiles</button>
      </div>
    </fieldset>
  );
}
