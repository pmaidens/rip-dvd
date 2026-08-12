import React from "react";

import { displayTerm } from "../lib/display-term";
import { integerFormValue } from "./catalog-review-form";
import { orderMediaItemHierarchy } from "./catalog-review-hierarchy";
import {
  mediaItemKinds,
  type CatalogReviewMediaItem,
  type CreateMappingProposalInput,
  type MappingProposal,
  type MediaItemKind,
} from "./catalog-review-model";

const actionMediaItemKinds = {
  movie: "movie",
  bonus_feature: "bonus_feature",
  trailer: "trailer",
  chapters: "other",
  other: "other",
  main_feature: "movie",
} satisfies Record<MappingProposal["action"], MediaItemKind>;

function sourceDescription(proposal: MappingProposal): string {
  const source = proposal.sourceIdentity;
  if (source.kind === "main_feature") {
    return "DVD main feature";
  }
  if (source.kind === "dvd_title") {
    return `exact whole Title ${source.titleNumber}`;
  }
  return `Title ${source.titleNumber} chapter range`;
}

export function CatalogReviewMappingProposal({
  proposal,
  proposedTitle,
  mediaItems,
  isSaving,
  error,
  onCancel,
  onCreate,
}: {
  proposal: MappingProposal;
  proposedTitle: string;
  mediaItems: CatalogReviewMediaItem[];
  isSaving: boolean;
  error: string | null;
  onCancel(): void;
  onCreate(input: CreateMappingProposalInput): void;
}) {
  const hierarchy = orderMediaItemHierarchy(mediaItems);
  const source = proposal.sourceIdentity;

  function createProposal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parentId = String(form.get("parentId") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();
    const sourceIdentity = source.kind === "dvd_chapters"
      ? {
          kind: source.kind,
          titleNumber: source.titleNumber,
          chapterStart: integerFormValue(form, "chapterStart") ?? 0,
          chapterEnd: integerFormValue(form, "chapterEnd") ?? 0,
        } as const
      : source;
    onCreate({
      mediaItem: {
        parentId: parentId === "" ? null : parentId,
        kind: String(form.get("kind")) as MediaItemKind,
        title: String(form.get("title") ?? "").trim(),
        year: integerFormValue(form, "year") ?? null,
        seasonNumber: integerFormValue(form, "seasonNumber") ?? null,
        episodeNumber: integerFormValue(form, "episodeNumber") ?? null,
      },
      discSelection: {
        sourceIdentity,
        ...(label ? { label } : {}),
      },
    });
  }

  return (
    <section
      className="catalog-mapping-proposal"
      aria-labelledby="active-mapping-proposal"
    >
      <div className="profile-form-heading">
        <div>
          <p className="section-eyebrow">Assisted Mapping</p>
          <h4 id="active-mapping-proposal">Mapping Proposal</h4>
        </div>
        <button type="button" onClick={onCancel} disabled={isSaving}>
          Cancel proposal
        </button>
      </div>
      <p className="catalog-help">
        Review the proposed Media Item and Disc Selection for {sourceDescription(
          proposal,
        )}. Nothing is created until you submit both together.
      </p>
      {error ? (
        <div
          className="catalog-mapping-proposal-error section-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <form className="catalog-form" onSubmit={createProposal}>
        <fieldset>
          <legend>Proposed Media Item</legend>
          <div className="catalog-fields">
            <label>
              Title
              <input
                name="title"
                required
                maxLength={256}
                defaultValue={proposedTitle}
              />
            </label>
            <label>
              Kind
              <select
                name="kind"
                defaultValue={actionMediaItemKinds[proposal.action]}
              >
                {mediaItemKinds.map((kind) => (
                  <option key={kind} value={kind}>{displayTerm(kind)}</option>
                ))}
              </select>
            </label>
            <label>
              Parent
              <select name="parentId" defaultValue="">
                <option value="">No parent</option>
                {hierarchy.map(({ item, depth }) => (
                  <option key={item.id} value={item.id}>
                    {`${"— ".repeat(depth)}${item.title}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Year
              <input name="year" type="number" min="1800" max="9999" />
            </label>
            <label>
              Season number
              <input name="seasonNumber" type="number" min="0" />
            </label>
            <label>
              Episode number
              <input name="episodeNumber" type="number" min="1" />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Proposed Disc Selection</legend>
          <div className="catalog-fields">
            <label>
              Source
              <input value={sourceDescription(proposal)} readOnly />
            </label>
            {source.kind !== "main_feature" ? (
              <label>
                DVD title
                <input
                  name="titleNumber"
                  type="number"
                  value={source.titleNumber}
                  readOnly
                />
              </label>
            ) : null}
            {source.kind === "dvd_chapters" ? (
              <>
                <label>
                  First chapter
                  <input
                    name="chapterStart"
                    type="number"
                    min="1"
                    max={source.chapterEnd}
                    required
                    defaultValue={source.chapterStart}
                  />
                </label>
                <label>
                  Last chapter
                  <input
                    name="chapterEnd"
                    type="number"
                    min="1"
                    max={source.chapterEnd}
                    required
                    defaultValue={source.chapterEnd}
                  />
                </label>
              </>
            ) : null}
            <label>
              Label
              <input name="label" maxLength={256} placeholder="Optional" />
            </label>
          </div>
        </fieldset>
        <button type="submit" disabled={isSaving}>
          Create Media Item and Disc Selection
        </button>
      </form>
    </section>
  );
}
