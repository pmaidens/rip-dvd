"use client";

import { useEffect, useRef, useState } from "react";

import type {
  DvdAudioStream,
  DvdSubtitleStream,
  DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";

import type {
  CatalogReviewCoverage,
  CatalogReviewCoverageStatus as CatalogReviewTitleCoverageStatus,
} from "@rip-dvd/data-access";
import { formatVolumeLabel } from "../lib/catalog-label";
import { formatCountLabel } from "../lib/format-count-label";
import { CatalogReviewEpisodicMappingProposal } from "./catalog-review-episodic-mapping-proposal";
import { CatalogReviewMappingProposal } from "./catalog-review-mapping-proposal";
import type {
  CatalogReviewMediaItem,
  CreateEpisodicMappingProposalInput,
  CreateMappingProposalInput,
  EpisodicMappingProposal,
  MappingProposal,
  MappingProposalAction,
} from "./catalog-review-model";

export type TitleSuggestion =
  | "Feature-length candidate"
  | "Episode or long-extra candidate"
  | "Short or extra candidate"
  | "Very short or menu candidate";

export function titleSuggestion(durationSeconds: number): TitleSuggestion {
  if (durationSeconds >= 3_600) {
    return "Feature-length candidate";
  }
  if (durationSeconds >= 1_200) {
    return "Episode or long-extra candidate";
  }
  if (durationSeconds >= 120) {
    return "Short or extra candidate";
  }
  return "Very short or menu candidate";
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(hours > 0 || minutes > 0 ? [`${minutes}m`] : []),
    `${seconds}s`,
  ].join(" ");
}

function streamLanguage(stream: {
  language?: string;
  languageCode?: string;
}): string {
  return stream.language ?? stream.languageCode ?? "Unknown language";
}

function streamId(id: number): string {
  return `0x${id.toString(16)}`;
}

function languageSummary(
  streams: readonly (DvdAudioStream | DvdSubtitleStream)[],
): string {
  const languages = [...new Set(streams.map(streamLanguage))];
  return languages.length > 0 ? languages.join(", ") : "None";
}

function mappingProposalIdentity(proposal: MappingProposal): string {
  const source = proposal.sourceIdentity;
  if (source.kind === "main_feature") {
    return `${proposal.action}:main_feature`;
  }
  if (source.kind === "dvd_title") {
    return `${proposal.action}:title:${source.titleNumber}`;
  }
  return `${proposal.action}:title:${source.titleNumber}:chapters:${source.chapterStart}-${source.chapterEnd}`;
}

function TechnicalStreamDetails({ title }: { title: DvdTitle }) {
  return (
    <details className="catalog-stream-details">
      <summary>Technical stream details</summary>
      {title.audioStreams.length === 0 && title.subtitles.length === 0 ? (
        <p>No stream technical details were recorded.</p>
      ) : (
        <div className="catalog-stream-groups">
          {title.audioStreams.length > 0 ? (
            <section aria-label={`Title ${title.number} audio streams`}>
              <h5>Audio</h5>
              <ul>
                {title.audioStreams.map((stream) => (
                  <li key={stream.id}>
                    <strong>Audio stream {streamId(stream.id)}</strong>
                    <span>
                      {[
                        streamLanguage(stream),
                        stream.format,
                        stream.channels === undefined
                          ? undefined
                          : formatCountLabel(stream.channels, "channel"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {title.subtitles.length > 0 ? (
            <section aria-label={`Title ${title.number} subtitle streams`}>
              <h5>Subtitles</h5>
              <ul>
                {title.subtitles.map((stream) => (
                  <li key={stream.id}>
                    <strong>Subtitle stream {streamId(stream.id)}</strong>
                    <span>
                      {[streamLanguage(stream), stream.content]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </details>
  );
}

type CoverageFilter = "all" | CatalogReviewTitleCoverageStatus;

const coverageStatusLabels = {
  mapped: "Mapped",
  partially_mapped: "Partially mapped",
  unmapped: "Unmapped",
} satisfies Record<CatalogReviewTitleCoverageStatus, string>;

const coverageFilters: readonly { value: CoverageFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...(["unmapped", "mapped", "partially_mapped"] as const).map((value) => ({
    value,
    label: coverageStatusLabels[value],
  })),
];

export function CatalogReviewEvidence({
  coverage,
  volumeLabel,
  titles,
  mediaItems = [],
  activeMappingProposal = null,
  activeEpisodicMappingProposal = null,
  isSaving = false,
  mappingProposalError = null,
  onStartMappingProposal,
  onCancelMappingProposal = () => undefined,
  onCreateMappingProposal = () => undefined,
  onStartEpisodicMappingProposal,
  onCancelEpisodicMappingProposal = () => undefined,
  onCreateEpisodicMappingProposal = () => undefined,
}: {
  coverage: CatalogReviewCoverage;
  volumeLabel: string;
  titles: readonly DvdTitle[];
  mediaItems?: CatalogReviewMediaItem[];
  activeMappingProposal?: MappingProposal | null;
  activeEpisodicMappingProposal?: EpisodicMappingProposal | null;
  isSaving?: boolean;
  mappingProposalError?: string | null;
  onStartMappingProposal?(proposal: MappingProposal): void;
  onCancelMappingProposal?(): void;
  onCreateMappingProposal?(input: CreateMappingProposalInput): void;
  onStartEpisodicMappingProposal?(proposal: EpisodicMappingProposal): void;
  onCancelEpisodicMappingProposal?(): void;
  onCreateEpisodicMappingProposal?(
    input: CreateEpisodicMappingProposalInput,
  ): void;
}) {
  const [filter, setFilter] = useState<CoverageFilter>("all");
  const [selectedEpisodicTitleNumbers, setSelectedEpisodicTitleNumbers] =
    useState<Set<number>>(() => new Set());
  const [episodicSelectionError, setEpisodicSelectionError] = useState<
    string | null
  >(null);
  const startingEpisodeNumberInput = useRef<HTMLInputElement>(null);
  const coverageByTitle = new Map(
    coverage.titles.map((title) => [title.titleNumber, title]),
  );
  useEffect(() => {
    const unmappedTitleNumbers = new Set(
      coverage.titles
        .filter((title) => title.status === "unmapped")
        .map((title) => title.titleNumber),
    );
    setSelectedEpisodicTitleNumbers((current) => {
      const retained = new Set(
        [...current].filter((titleNumber) =>
          unmappedTitleNumbers.has(titleNumber)
        ),
      );
      return retained.size === current.size ? current : retained;
    });
  }, [coverage.titles]);
  const statusForTitle = (title: DvdTitle) =>
    coverageByTitle.get(title.number)?.status ?? "unmapped";
  const proposalSource = activeMappingProposal?.sourceIdentity;
  const activeProposalTitleNumber = proposalSource?.kind === "dvd_title" ||
      proposalSource?.kind === "dvd_chapters"
    ? proposalSource.titleNumber
    : null;
  const activeEpisodicTitleNumbers = new Set(
    activeEpisodicMappingProposal?.episodes.map(({ titleNumber }) =>
      titleNumber
    ) ?? [],
  );
  const isActiveProposalTitle = (title: DvdTitle) =>
    title.number === activeProposalTitleNumber;
  const isActiveEpisodicTitle = (title: DvdTitle) =>
    activeEpisodicTitleNumbers.has(title.number);
  const isActiveEvidenceTitle = (title: DvdTitle) =>
    isActiveProposalTitle(title) || isActiveEpisodicTitle(title);
  const visibleTitles = titles.filter(
    (title) =>
      isActiveEvidenceTitle(title) || filter === "all" ||
      statusForTitle(title) === filter,
  );
  const collapsedVeryShortTitles = visibleTitles.filter(
    (title) =>
      !isActiveEvidenceTitle(title) && statusForTitle(title) === "unmapped" &&
      title.durationSeconds < 120,
  );
  const listedTitles = visibleTitles.filter(
    (title) =>
      isActiveEvidenceTitle(title) || statusForTitle(title) !== "unmapped" ||
      title.durationSeconds >= 120,
  );
  const listedTitlesByNumber = new Map(
    listedTitles.map((title) => [title.number, title]),
  );
  const activeEpisodicTitles = activeEpisodicMappingProposal?.episodes
    .map(({ titleNumber }) => listedTitlesByNumber.get(titleNumber))
    .filter((title): title is DvdTitle => title !== undefined) ?? [];
  const otherListedTitles = activeEpisodicMappingProposal === null
    ? listedTitles
    : listedTitles.filter((title) => !isActiveEpisodicTitle(title));
  const longestDuration = Math.max(
    ...titles.map((title) => title.durationSeconds),
  );
  const proposedTitle = formatVolumeLabel(volumeLabel);
  const mainFeatureAssistedMappingUnavailable =
    coverage.mainFeatureSelections > 0;
  function toggleEpisodicTitle(titleNumber: number) {
    setSelectedEpisodicTitleNumbers((current) => {
      const next = new Set(current);
      if (next.has(titleNumber)) {
        next.delete(titleNumber);
      } else {
        next.add(titleNumber);
      }
      return next;
    });
  }
  function startEpisodicProposal() {
    const firstEpisodeNumber = Number(startingEpisodeNumberInput.current?.value);
    if (
      !Number.isSafeInteger(firstEpisodeNumber) ||
      firstEpisodeNumber < 1
    ) {
      setEpisodicSelectionError(
        "Starting episode number must be a positive whole number.",
      );
      return;
    }
    if (
      firstEpisodeNumber >
        Number.MAX_SAFE_INTEGER - selectedEpisodicTitleNumbers.size + 1
    ) {
      setEpisodicSelectionError(
        "Starting episode number must leave room for every selected title.",
      );
      return;
    }
    if (selectedEpisodicTitleNumbers.size === 0) {
      return;
    }
    setEpisodicSelectionError(null);
    const selectedTitles = titles
      .filter((title) => selectedEpisodicTitleNumbers.has(title.number))
      .sort((left, right) => left.number - right.number);
    onStartEpisodicMappingProposal?.({
      episodes: selectedTitles.map((title, index) => {
        const episodeNumber = firstEpisodeNumber + index;
        return {
          titleNumber: title.number,
          title: `Episode ${episodeNumber}`,
          episodeNumber,
        };
      }),
    });
  }
  function startWholeTitleProposal(
    titleNumber: number,
    action: Exclude<MappingProposalAction, "chapters" | "main_feature">,
  ) {
    onStartMappingProposal?.({
      action,
      sourceIdentity: { kind: "dvd_title", titleNumber },
    });
  }
  function renderTitleEvidence(title: DvdTitle) {
    const titleCoverage = coverageByTitle.get(title.number) ?? {
      titleNumber: title.number,
      status: "unmapped" as const,
      hasOverlap: false,
    };
    const activeTitleProposal = isActiveProposalTitle(title);
    const hasExistingCoverage = titleCoverage.status !== "unmapped";
    const assistedMappingDisabled = isSaving || hasExistingCoverage ||
      activeEpisodicMappingProposal !== null;
    return (
      <li
        key={title.number}
        className={activeTitleProposal
          ? "catalog-title-evidence catalog-title-evidence-active"
          : "catalog-title-evidence"}
      >
        <div className="catalog-title-evidence-content">
          <header className="catalog-title-evidence-heading">
            <div>
              <h4>Title {title.number}</h4>
              <p>
                {formatDuration(title.durationSeconds)} · {formatCountLabel(
                  title.chapters,
                  "chapter",
                )}
              </p>
            </div>
            <div className="catalog-title-badges">
              <span
                className={`catalog-coverage-state is-${titleCoverage.status}`}
              >
                {coverageStatusLabels[titleCoverage.status]}
              </span>
              {title.durationSeconds === longestDuration ? (
                <span className="catalog-factual-badge">Longest title</span>
              ) : null}
              <span className="catalog-title-suggestion">
                <span>Title Suggestion</span>
                <strong>{titleSuggestion(title.durationSeconds)}</strong>
              </span>
            </div>
          </header>
          {titleCoverage.hasOverlap ? (
            <p className="catalog-coverage-warning" role="status">
              <strong>Overlapping Disc Selections</strong>
              <span>Ranges are counted once and remain valid.</span>
            </p>
          ) : null}
          <p className="catalog-language-summary">
            <span>Audio: {languageSummary(title.audioStreams)}</span>
            <span>Subtitles: {languageSummary(title.subtitles)}</span>
          </p>
          <TechnicalStreamDetails title={title} />
          {onStartEpisodicMappingProposal && !hasExistingCoverage ? (
            <label className="catalog-episodic-title-choice">
              <input
                type="checkbox"
                name="episodicTitleNumbers"
                value={title.number}
                checked={selectedEpisodicTitleNumbers.has(title.number)}
                disabled={isSaving || activeEpisodicMappingProposal !== null}
                onChange={() => toggleEpisodicTitle(title.number)}
              />
              Select Title {title.number} for episodic mapping
            </label>
          ) : null}
          {onStartMappingProposal ? (
            <div className="catalog-title-mapping-controls">
              <div
                className="catalog-title-actions"
                role="group"
                aria-label={`Map Title ${title.number}`}
              >
                <button
                  type="button"
                  disabled={assistedMappingDisabled}
                  onClick={() => startWholeTitleProposal(title.number, "movie")}
                >
                  Map as movie
                </button>
                <button
                  type="button"
                  disabled={assistedMappingDisabled}
                  onClick={() =>
                    startWholeTitleProposal(title.number, "bonus_feature")}
                >
                  Map as bonus feature
                </button>
                <button
                  type="button"
                  disabled={assistedMappingDisabled}
                  onClick={() =>
                    startWholeTitleProposal(title.number, "trailer")}
                >
                  Map as trailer
                </button>
                <button
                  type="button"
                  disabled={assistedMappingDisabled}
                  onClick={() =>
                    startWholeTitleProposal(
                      title.number,
                      "existing_media_item",
                    )}
                >
                  Map to existing Media Item
                </button>
                <button
                  type="button"
                  disabled={assistedMappingDisabled}
                  onClick={() => onStartMappingProposal({
                    action: "chapters",
                    sourceIdentity: {
                      kind: "dvd_chapters",
                      titleNumber: title.number,
                      chapterStart: 1,
                      chapterEnd: title.chapters,
                    },
                  })}
                >
                  Map chapters
                </button>
                <button
                  type="button"
                  disabled={assistedMappingDisabled}
                  onClick={() => startWholeTitleProposal(title.number, "other")}
                >
                  Map as other
                </button>
              </div>
              {hasExistingCoverage ? (
                <p className="catalog-help">
                  Assisted Mapping is unavailable for covered titles. Use
                  manual Disc Selection controls for intentional overlaps.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {activeTitleProposal && activeMappingProposal ? (
          <CatalogReviewMappingProposal
            key={mappingProposalIdentity(activeMappingProposal)}
            proposal={activeMappingProposal}
            proposedTitle={proposedTitle}
            mediaItems={mediaItems}
            isSaving={isSaving}
            error={mappingProposalError}
            onCancel={onCancelMappingProposal}
            onCreate={onCreateMappingProposal}
          />
        ) : null}
      </li>
    );
  }
  return (
    <section
      className="catalog-pane catalog-evidence"
      aria-labelledby="archived-scan-evidence"
    >
      <h3 id="archived-scan-evidence">Archived Scan Evidence</h3>
      <p className="catalog-help">
        Archived Scan Evidence is read-only disc structure captured during
        scanning. Reviewed catalog decisions remain separate until you save a
        Disc Selection.
      </p>
      <dl className="catalog-volume-labels">
        <div>
          <dt>Original volume label</dt>
          <dd>
            <code>{volumeLabel}</code>
          </dd>
        </div>
        <div>
          <dt>Formatted label suggestion</dt>
          <dd>{formatVolumeLabel(volumeLabel) || "Unlabeled disc"}</dd>
        </div>
      </dl>
      {coverage.mainFeatureSelections > 1 ? (
        <p className="catalog-coverage-warning" role="status">
          <strong>Overlapping Disc Selections</strong>
          <span>
            Exact main-feature sources remain separate catalog identities.
          </span>
        </p>
      ) : null}
      {onStartMappingProposal ? (
        <div className="catalog-archive-mapping-action">
          <button
            type="button"
            disabled={isSaving || mainFeatureAssistedMappingUnavailable}
            onClick={() => onStartMappingProposal({
              action: "main_feature",
              sourceIdentity: { kind: "main_feature" },
            })}
          >
            Map DVD main feature
          </button>
          <span>
            {mainFeatureAssistedMappingUnavailable
              ? "Assisted Mapping is unavailable because this archive already has an active main-feature Disc Selection. Use manual or correction Disc Selection controls for intentional overlaps."
              : "Archive-level action; HandBrake resolves the source during encode."}
          </span>
        </div>
      ) : null}
      {activeMappingProposal?.sourceIdentity.kind === "main_feature" ? (
        <CatalogReviewMappingProposal
          key={mappingProposalIdentity(activeMappingProposal)}
          proposal={activeMappingProposal}
          proposedTitle={proposedTitle}
          mediaItems={mediaItems}
          isSaving={isSaving}
          error={mappingProposalError}
          onCancel={onCancelMappingProposal}
          onCreate={onCreateMappingProposal}
        />
      ) : null}
      <p className="catalog-suggestion-help">
        Title Suggestions use duration only. They do not identify content,
        select a source, or create a Disc Selection.
      </p>
      {onStartEpisodicMappingProposal && titles.length > 0 ? (
        <section
          className="catalog-episodic-selection"
          aria-labelledby="episodic-title-selection"
        >
          <div>
            <h4 id="episodic-title-selection">Bulk episode mapping</h4>
            <p className="catalog-help">
              Select whole DVD titles, then provide the required starting
              episode number. The initial proposal follows DVD title order.
            </p>
          </div>
          <label>
            Starting episode number
            <input
              name="episodicStartingEpisodeNumber"
              type="number"
              min="1"
              required
              defaultValue="1"
              ref={startingEpisodeNumberInput}
              disabled={isSaving || activeEpisodicMappingProposal !== null}
            />
          </label>
          <button
            type="button"
            disabled={
              isSaving ||
              activeMappingProposal !== null ||
              activeEpisodicMappingProposal !== null ||
              selectedEpisodicTitleNumbers.size === 0
            }
            onClick={startEpisodicProposal}
          >
            Create episodic proposal
          </button>
          <span aria-live="polite">
            {formatCountLabel(
              selectedEpisodicTitleNumbers.size,
              "selected title",
            )}
          </span>
          {episodicSelectionError ? (
            <p className="catalog-episodic-selection-error" role="alert">
              {episodicSelectionError}
            </p>
          ) : null}
        </section>
      ) : null}
      {titles.length === 0 ? (
        <p className="catalog-empty">
          No reviewable DVD titles were recorded.
        </p>
      ) : (
        <>
          <div
            className="catalog-coverage-filters"
            role="group"
            aria-label="Title coverage filter"
          >
            {coverageFilters.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {activeEpisodicMappingProposal ? (
            <div className="catalog-episodic-workspace">
              <ol className="catalog-title-evidence-list">
                {activeEpisodicTitles.map(renderTitleEvidence)}
              </ol>
              <CatalogReviewEpisodicMappingProposal
                key={activeEpisodicMappingProposal.episodes
                  .map((episode) => episode.titleNumber).join("-")}
                proposal={activeEpisodicMappingProposal}
                proposedTitle={proposedTitle}
                isSaving={isSaving}
                error={mappingProposalError}
                onCancel={onCancelEpisodicMappingProposal}
                onCreate={onCreateEpisodicMappingProposal}
              />
            </div>
          ) : null}
          {otherListedTitles.length > 0 ? (
            <ol className="catalog-title-evidence-list">
              {otherListedTitles.map(renderTitleEvidence)}
            </ol>
          ) : null}
          {collapsedVeryShortTitles.length > 0 ? (
            <details className="catalog-coverage-collapsed">
              <summary>
                {formatCountLabel(
                  collapsedVeryShortTitles.length,
                  "very-short unmapped title",
                )}
              </summary>
              <ol className="catalog-title-evidence-list">
                {collapsedVeryShortTitles.map(renderTitleEvidence)}
              </ol>
            </details>
          ) : null}
          {visibleTitles.length === 0 ? (
            <p className="catalog-empty">No titles match this filter.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
