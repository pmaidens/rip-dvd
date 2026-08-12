"use client";

import { useState } from "react";

import type {
  DvdAudioStream,
  DvdSubtitleStream,
  DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";

import type {
  CatalogReviewCoverage,
  CatalogReviewTitleCoverageStatus,
} from "../lib/catalog-review-coverage";
import { CatalogReviewMappingProposal } from "./catalog-review-mapping-proposal";
import type {
  CatalogReviewMediaItem,
  CreateMappingProposalInput,
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

const LOWERCASE_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function formatVolumeLabel(volumeLabel: string): string {
  const separated = volumeLabel
    .replace(/[_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    separated.length === 0 ||
    (separated !== separated.toUpperCase() &&
      separated !== separated.toLowerCase())
  ) {
    return separated;
  }
  return separated
    .toLowerCase()
    .split(" ")
    .map((word, index) =>
      index > 0 && LOWERCASE_TITLE_WORDS.has(word)
        ? word
        : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`
    )
    .join(" ");
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

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
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
                          : countLabel(stream.channels, "channel"),
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

const coverageFilters = [
  { value: "all", label: "All" },
  { value: "unmapped", label: "Unmapped" },
  { value: "mapped", label: "Mapped" },
  { value: "partially_mapped", label: "Partially mapped" },
] as const satisfies readonly { value: CoverageFilter; label: string }[];

const coverageStatusLabels = {
  mapped: "Mapped",
  partially_mapped: "Partially mapped",
  unmapped: "Unmapped",
} satisfies Record<CatalogReviewTitleCoverageStatus, string>;

export function CatalogReviewEvidence({
  coverage,
  volumeLabel,
  titles,
  mediaItems = [],
  activeMappingProposal = null,
  isSaving = false,
  mappingProposalError = null,
  onStartMappingProposal,
  onCancelMappingProposal = () => undefined,
  onCreateMappingProposal = () => undefined,
}: {
  coverage: CatalogReviewCoverage;
  volumeLabel: string;
  titles: readonly DvdTitle[];
  mediaItems?: CatalogReviewMediaItem[];
  activeMappingProposal?: MappingProposal | null;
  isSaving?: boolean;
  mappingProposalError?: string | null;
  onStartMappingProposal?(proposal: MappingProposal): void;
  onCancelMappingProposal?(): void;
  onCreateMappingProposal?(input: CreateMappingProposalInput): void;
}) {
  const [filter, setFilter] = useState<CoverageFilter>("all");
  const coverageByTitle = new Map(
    coverage.titles.map((title) => [title.titleNumber, title]),
  );
  const statusForTitle = (title: DvdTitle) =>
    coverageByTitle.get(title.number)?.status ?? "unmapped";
  const visibleTitles = titles.filter(
    (title) => filter === "all" || statusForTitle(title) === filter,
  );
  const collapsedVeryShortTitles = visibleTitles.filter(
    (title) =>
      statusForTitle(title) === "unmapped" && title.durationSeconds < 120,
  );
  const listedTitles = visibleTitles.filter(
    (title) =>
      statusForTitle(title) !== "unmapped" || title.durationSeconds >= 120,
  );
  const longestDuration = Math.max(
    ...titles.map((title) => title.durationSeconds),
  );
  const proposedTitle = formatVolumeLabel(volumeLabel);
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
      durationSeconds: title.durationSeconds,
      status: "unmapped" as const,
      hasOverlap: false,
    };
    const proposalSource = activeMappingProposal?.sourceIdentity;
    const activeTitleProposal = proposalSource?.kind === "dvd_title" ||
        proposalSource?.kind === "dvd_chapters"
      ? proposalSource.titleNumber === title.number
      : false;
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
                {formatDuration(title.durationSeconds)} · {countLabel(
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
          {onStartMappingProposal ? (
            <div
              className="catalog-title-actions"
              role="group"
              aria-label={`Map Title ${title.number}`}
            >
              <button
                type="button"
                disabled={isSaving}
                onClick={() => startWholeTitleProposal(title.number, "movie")}
              >
                Map as movie
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={() =>
                  startWholeTitleProposal(title.number, "bonus_feature")}
              >
                Map as bonus feature
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => startWholeTitleProposal(title.number, "trailer")}
              >
                Map as trailer
              </button>
              <button
                type="button"
                disabled={isSaving}
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
                disabled={isSaving}
                onClick={() => startWholeTitleProposal(title.number, "other")}
              >
                Map as other
              </button>
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
      {onStartMappingProposal ? (
        <div className="catalog-archive-mapping-action">
          <button
            type="button"
            disabled={isSaving}
            onClick={() => onStartMappingProposal({
              action: "main_feature",
              sourceIdentity: { kind: "main_feature" },
            })}
          >
            Map DVD main feature
          </button>
          <span>
            Archive-level action; HandBrake resolves the source during encode.
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
          {listedTitles.length > 0 ? (
            <ol className="catalog-title-evidence-list">
              {listedTitles.map(renderTitleEvidence)}
            </ol>
          ) : null}
          {collapsedVeryShortTitles.length > 0 ? (
            <details className="catalog-coverage-collapsed">
              <summary>
                {countLabel(
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
