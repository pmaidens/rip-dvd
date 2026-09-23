"use client";

import { useEffect, useRef, useState } from "react";
import type { DiscSelectionSourceIdentityInput } from "@rip-dvd/data-access";

import type {
  CatalogReviewArchiveEvidence,
  CatalogReviewMediaItem,
  CatalogReviewRearchiveProposal,
  SaveRearchiveMappingProposalInput,
} from "./catalog-review-model";
import { ArchiveBoundaryDescription } from "./archive-boundary-description";
import { ArchiveIntegrityDescription } from "./archive-integrity-description";
import { CatalogReviewMediaItemSearchPicker } from "./catalog-review-media-item-search-picker";

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

function RearchiveArchiveEvidence({
  heading,
  archive,
}: {
  heading: string;
  archive: CatalogReviewArchiveEvidence;
}) {
  return (
    <div>
      <dt>{heading}</dt>
      <dd>
        <span>
          {archive.discKind.toUpperCase()} · {
            archive.archiveFormat.toUpperCase()
          } · {archive.integrity.replaceAll("_", " ")}
        </span>
        <ArchiveIntegrityDescription {...archive} />
        <p>
          Integrity policy: {archive.integrityPolicyVersion ?? "not recorded"}
        </p>
        {archive.badSectorCountsByTitle !== null &&
            archive.badSectorCountsByTitle.length > 0
          ? (
            <p>
              Unreadable sectors by title: {
                archive.badSectorCountsByTitle.map((count) =>
                  `Title ${count.titleNumber}: ${count.badSectorCount}`
                ).join("; ")
              }
            </p>
          )
          : null}
        <p>
          Boundary evidence: {archive.boundaryEvidence === null
            ? "not recorded"
            : `${archive.boundaryEvidence.policyVersion}; ${
              archive.boundaryEvidence.publishedSizeBytes.toLocaleString(
                "en-US",
              )
            } published bytes`}
        </p>
        <ArchiveBoundaryDescription
          boundaryEvidence={archive.boundaryEvidence}
        />
      </dd>
    </div>
  );
}

export function CatalogReviewRearchiveProposal({
  proposal,
  mediaItems,
  isSaving,
  onPreview,
  onSave,
  onAccept,
}: {
  proposal: CatalogReviewRearchiveProposal;
  mediaItems: CatalogReviewMediaItem[];
  isSaving: boolean;
  onPreview(input: SaveRearchiveMappingProposalInput): Promise<
    CatalogReviewRearchiveProposal
  >;
  onSave(input: SaveRearchiveMappingProposalInput): void;
  onAccept(): void;
}) {
  const [mappings, setMappings] = useState<
    SaveRearchiveMappingProposalInput["mappings"]
  >(() => proposal.mappings.map((mapping) => ({
    sourceDiscSelectionId: mapping.sourceDiscSelectionId,
    ...mapping.proposedMapping,
  })));
  const [preview, setPreview] = useState(proposal);
  const [isPreviewCurrent, setIsPreviewCurrent] = useState(true);
  const [isSavedCurrent, setIsSavedCurrent] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [additionalMediaItems, setAdditionalMediaItems] = useState<
    CatalogReviewMediaItem[]
  >([]);
  const [searchMappingId, setSearchMappingId] = useState<string | null>(null);
  const previewRequestId = useRef(0);

  useEffect(() => {
    previewRequestId.current += 1;
    setMappings(proposal.mappings.map((mapping) => ({
      sourceDiscSelectionId: mapping.sourceDiscSelectionId,
      ...mapping.proposedMapping,
    })));
    setPreview(proposal);
    setIsPreviewCurrent(true);
    setIsSavedCurrent(true);
    setPreviewError(null);
    setAdditionalMediaItems([]);
    setSearchMappingId(null);
  }, [proposal]);

  const updateMapping = (
    sourceDiscSelectionId: string,
    change: (
      mapping: SaveRearchiveMappingProposalInput["mappings"][number],
    ) => SaveRearchiveMappingProposalInput["mappings"][number],
  ) => {
    previewRequestId.current += 1;
    setIsPreviewCurrent(false);
    setIsSavedCurrent(false);
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
  const selectableMediaItems = [
    ...new Map(
      [...mediaItems, ...additionalMediaItems].map((item) => [item.id, item]),
    ).values(),
  ];
  const mediaItemsById = new Map(
    selectableMediaItems.map((item) => [item.id, item]),
  );

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
        <RearchiveArchiveEvidence
          heading="Prior archive"
          archive={proposal.sourceArchive}
        />
        <RearchiveArchiveEvidence
          heading="Fresh archive"
          archive={proposal.targetArchive}
        />
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
                {selectableMediaItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.title}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => setSearchMappingId((current) =>
                current === mapping.sourceDiscSelectionId
                  ? null
                  : mapping.sourceDiscSelectionId
              )}
            >
              {searchMappingId === mapping.sourceDiscSelectionId
                ? "Close Media Item search"
                : "Find another Media Item"}
            </button>
            {searchMappingId === mapping.sourceDiscSelectionId ? (
              <CatalogReviewMediaItemSearchPicker
                initialQuery={
                  mediaItemsById.get(mapping.mediaItemId)?.title ?? ""
                }
                selectedMediaItemId={mapping.mediaItemId}
                inputName={`rearchiveMediaItemId-${mapping.sourceDiscSelectionId}`}
                isSaving={isSaving}
                onSelect={(result) => {
                  setAdditionalMediaItems((current) =>
                    current.some((item) => item.id === result.mediaItem.id)
                      ? current
                      : [...current, result.mediaItem]
                  );
                  updateMapping(
                    mapping.sourceDiscSelectionId,
                    (current) => ({
                      ...current,
                      mediaItemId: result.mediaItem.id,
                    }),
                  );
                  setSearchMappingId(null);
                }}
              />
            ) : null}
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
            {prior === null ? (
              <button
                type="button"
                disabled={isSaving}
                onClick={() => {
                  previewRequestId.current += 1;
                  setMappings((current) => current.filter(
                    (candidate) =>
                      candidate.sourceDiscSelectionId !==
                        mapping.sourceDiscSelectionId,
                  ));
                  setSearchMappingId(null);
                  setIsPreviewCurrent(false);
                  setIsSavedCurrent(false);
                  setPreviewError(null);
                }}
              >
                Remove stale proposal row
              </button>
            ) : null}
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
            const requestId = previewRequestId.current + 1;
            previewRequestId.current = requestId;
            setIsPreviewCurrent(false);
            setPreviewError(null);
            void onPreview({ mappings }).then((result) => {
              if (previewRequestId.current !== requestId) return;
              setPreview(result);
              setIsPreviewCurrent(true);
            }).catch((error) => {
              if (previewRequestId.current !== requestId) return;
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
        <button
          type="button"
          disabled={isSaving || !proposal.persisted || !isSavedCurrent ||
            !isPreviewCurrent || preview.state !== "ready"}
          onClick={onAccept}
        >
          Accept re-archive
        </button>
      </div>
    </section>
  );
}
