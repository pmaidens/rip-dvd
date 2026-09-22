"use client";

import { useEffect, useState } from "react";
import type { DiscSelectionSourceIdentityInput } from "@rip-dvd/data-access";

import type {
  CatalogReviewMediaItem,
  CatalogReviewRearchiveProposal,
  SaveRearchiveMappingProposalInput,
} from "./catalog-review-model";
import { ArchiveBoundaryDescription } from "./archive-boundary-description";
import { ArchiveIntegrityDescription } from "./archive-integrity-description";

function sourceIdentityForKind(
  kind: DiscSelectionSourceIdentityInput["kind"],
): DiscSelectionSourceIdentityInput {
  if (kind === "main_feature") return { kind };
  if (kind === "dvd_title") return { kind, titleNumber: 1 };
  return { kind, titleNumber: 1, chapterStart: 1, chapterEnd: 1 };
}

function sourceIdentityLabel(
  source: DiscSelectionSourceIdentityInput,
): string {
  if (source.kind === "main_feature") return "Main feature";
  if (source.kind === "dvd_title") return `Title ${source.titleNumber}`;
  return `Title ${source.titleNumber}, chapters ${source.chapterStart}–${source.chapterEnd}`;
}

export function CatalogReviewRearchiveProposal({
  proposal,
  mediaItems,
  isSaving,
  onPreview,
  onSave,
}: {
  proposal: CatalogReviewRearchiveProposal;
  mediaItems: CatalogReviewMediaItem[];
  isSaving: boolean;
  onPreview(input: SaveRearchiveMappingProposalInput): Promise<
    CatalogReviewRearchiveProposal
  >;
  onSave(input: SaveRearchiveMappingProposalInput): void;
}) {
  const [mappings, setMappings] = useState<
    SaveRearchiveMappingProposalInput["mappings"]
  >(() => proposal.mappings.map((mapping) => ({
    sourceDiscSelectionId: mapping.sourceDiscSelectionId,
    ...mapping.proposedMapping,
  })));
  const [preview, setPreview] = useState(proposal);
  const [isPreviewCurrent, setIsPreviewCurrent] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setMappings(proposal.mappings.map((mapping) => ({
      sourceDiscSelectionId: mapping.sourceDiscSelectionId,
      ...mapping.proposedMapping,
    })));
    setPreview(proposal);
    setIsPreviewCurrent(true);
    setPreviewError(null);
  }, [proposal]);

  const updateMapping = (
    sourceDiscSelectionId: string,
    change: (
      mapping: SaveRearchiveMappingProposalInput["mappings"][number],
    ) => SaveRearchiveMappingProposalInput["mappings"][number],
  ) => {
    setIsPreviewCurrent(false);
    setPreviewError(null);
    setMappings((current) => current.map((mapping) =>
      mapping.sourceDiscSelectionId === sourceDiscSelectionId
        ? change(mapping)
        : mapping
    ));
  };
  const mappingState = new Map(
    preview.mappings.map((mapping) => [
      mapping.sourceDiscSelectionId,
      mapping,
    ]),
  );
  const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));

  return (
    <section
      className="catalog-pane rearchive-mapping-proposal"
      aria-labelledby="rearchive-mapping-proposal-title"
    >
      <p className="section-eyebrow">Fresh archive review</p>
      <h3 id="rearchive-mapping-proposal-title">
        Re-archive Mapping Proposal
      </h3>
      <p>
        Review mappings from {proposal.sourceArchive.discLabel} against the
        fresh inspection for {proposal.targetArchive.discLabel}. Saving keeps
        this proposal separate from active Disc Selections until Re-archive
        Acceptance.
      </p>
      <dl className="catalog-summary-list">
        <div>
          <dt>Prior archive</dt>
          <dd>
            <span>
              {proposal.sourceArchive.discKind.toUpperCase()} · {
                proposal.sourceArchive.archiveFormat.toUpperCase()
              } · {proposal.sourceArchive.integrity.replaceAll("_", " ")}
            </span>
            <ArchiveIntegrityDescription {...proposal.sourceArchive} />
            <p>
              Boundary evidence: {proposal.sourceArchive.boundaryEvidence === null
                ? "not recorded"
                : `${proposal.sourceArchive.boundaryEvidence.policyVersion}; ${
                  proposal.sourceArchive.boundaryEvidence.publishedSizeBytes
                    .toLocaleString("en-US")
                } published bytes`}
            </p>
            <ArchiveBoundaryDescription
              boundaryEvidence={proposal.sourceArchive.boundaryEvidence}
            />
          </dd>
        </div>
        <div>
          <dt>Fresh archive</dt>
          <dd>
            <span>
              {proposal.targetArchive.discKind.toUpperCase()} · {
                proposal.targetArchive.archiveFormat.toUpperCase()
              } · {proposal.targetArchive.integrity.replaceAll("_", " ")}
            </span>
            <ArchiveIntegrityDescription {...proposal.targetArchive} />
            <p>
              Boundary evidence: {proposal.targetArchive.boundaryEvidence === null
                ? "not recorded"
                : `${proposal.targetArchive.boundaryEvidence.policyVersion}; ${
                  proposal.targetArchive.boundaryEvidence.publishedSizeBytes
                    .toLocaleString("en-US")
                } published bytes`}
            </p>
            <ArchiveBoundaryDescription
              boundaryEvidence={proposal.targetArchive.boundaryEvidence}
            />
          </dd>
        </div>
        <div>
          <dt>Review state</dt>
          <dd>{preview.state.replaceAll("_", " ")}</dd>
        </div>
      </dl>
      {mappings.length === 0 ? (
        <div className="section-message section-error" role="status">
          The prior archive has no active mappings. This proposal is incomplete.
        </div>
      ) : null}
      {mappings.map((mapping, index) => {
        const status = mappingState.get(mapping.sourceDiscSelectionId);
        const prior = proposal.mappings.find(
          (candidate) =>
            candidate.sourceDiscSelectionId === mapping.sourceDiscSelectionId,
        )?.priorMapping ?? null;
        const source = mapping.sourceIdentity;
        return (
          <fieldset key={mapping.sourceDiscSelectionId}>
            <legend>Prior mapping {index + 1}</legend>
            <p>
              Prior selection: {prior === null
                ? "No longer active"
                : `${
                  mediaItemsById.get(prior.mediaItemId)?.title ??
                    "Unknown Media Item"
                } · ${sourceIdentityLabel(prior.sourceIdentity)}${
                  prior.label === null ? "" : ` · ${prior.label}`
                }`}
            </p>
            <label>
              Media Item
              <select
                value={mapping.mediaItemId}
                disabled={isSaving}
                onChange={(event) => updateMapping(
                  mapping.sourceDiscSelectionId,
                  (current) => ({
                    ...current,
                    mediaItemId: event.target.value,
                  }),
                )}
              >
                {mediaItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.title}</option>
                ))}
              </select>
            </label>
            <label>
              Source
              <select
                value={source.kind}
                disabled={isSaving}
                onChange={(event) => updateMapping(
                  mapping.sourceDiscSelectionId,
                  (current) => ({
                    ...current,
                    sourceIdentity: sourceIdentityForKind(
                      event.target.value as DiscSelectionSourceIdentityInput["kind"],
                    ),
                  }),
                )}
              >
                <option value="main_feature">Main feature</option>
                <option value="dvd_title">DVD title</option>
                <option value="dvd_chapters">DVD chapters</option>
              </select>
            </label>
            {source.kind !== "main_feature" ? (
              <label>
                Title number
                <input
                  type="number"
                  min="1"
                  value={source.titleNumber}
                  disabled={isSaving}
                  onChange={(event) => updateMapping(
                    mapping.sourceDiscSelectionId,
                    (current) => ({
                      ...current,
                      sourceIdentity: {
                        ...current.sourceIdentity,
                        titleNumber: Number(event.target.value),
                      } as DiscSelectionSourceIdentityInput,
                    }),
                  )}
                />
              </label>
            ) : null}
            {source.kind === "dvd_chapters" ? (
              <>
                <label>
                  First chapter
                  <input
                    type="number"
                    min="1"
                    value={source.chapterStart}
                    disabled={isSaving}
                    onChange={(event) => updateMapping(
                      mapping.sourceDiscSelectionId,
                      (current) => ({
                        ...current,
                        sourceIdentity: {
                          ...current.sourceIdentity,
                          chapterStart: Number(event.target.value),
                        } as DiscSelectionSourceIdentityInput,
                      }),
                    )}
                  />
                </label>
                <label>
                  Last chapter
                  <input
                    type="number"
                    min="1"
                    value={source.chapterEnd}
                    disabled={isSaving}
                    onChange={(event) => updateMapping(
                      mapping.sourceDiscSelectionId,
                      (current) => ({
                        ...current,
                        sourceIdentity: {
                          ...current.sourceIdentity,
                          chapterEnd: Number(event.target.value),
                        } as DiscSelectionSourceIdentityInput,
                      }),
                    )}
                  />
                </label>
              </>
            ) : null}
            <label>
              Label
              <input
                value={mapping.label ?? ""}
                disabled={isSaving}
                onChange={(event) => updateMapping(
                  mapping.sourceDiscSelectionId,
                  (current) => ({
                    ...current,
                    label: event.target.value === ""
                      ? null
                      : event.target.value,
                  }),
                )}
              />
            </label>
            <p
              className={status?.state === "valid"
                ? "section-message"
                : "section-message section-error"}
              role="status"
            >
              {isPreviewCurrent && status?.state === "valid"
                ? "Valid for the fresh inspection"
                : isPreviewCurrent
                ? status?.reason ?? "Preview required"
                : "Preview required after editing"}
            </p>
          </fieldset>
        );
      })}
      {previewError ? (
        <div className="section-message section-error" role="alert">
          {previewError}
        </div>
      ) : null}
      <div className="profile-actions">
        <button
          type="button"
          disabled={isSaving}
          onClick={() => {
            setPreviewError(null);
            void onPreview({ mappings }).then((result) => {
              setPreview(result);
              setIsPreviewCurrent(true);
            }).catch((error) => {
              setIsPreviewCurrent(false);
              setPreviewError(error instanceof Error
                ? error.message
                : "Proposal preview failed");
            });
          }}
        >
          Preview proposal
        </button>
        <button
          type="button"
          disabled={isSaving || !isPreviewCurrent || preview.state !== "ready"}
          onClick={() => onSave({ mappings })}
        >
          {proposal.persisted ? "Save proposal changes" : "Save reviewed proposal"}
        </button>
      </div>
    </section>
  );
}
