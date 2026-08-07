"use client";

import { useEffect, useState } from "react";

import type {
  ArchiveFormat,
  DiscKind,
  FilesystemVerificationStatus,
  JobStatus,
} from "@rip-dvd/data-access";

import { displayTerm } from "../lib/display-term";

export type FilesystemVerificationInventoryTarget =
  | "original_disc_archive"
  | "encode_job_output";

interface FilesystemVerificationInventoryItemBase {
  id: string;
  status: FilesystemVerificationStatus | null;
  message: string | null;
  verifiedAt: string | null;
}

export type FilesystemVerificationInventoryItem =
  | (FilesystemVerificationInventoryItemBase & {
      target: "encode_job_output";
      mediaTitle: string;
      mediaYear: number | null;
      encodingProfileName: string;
      jobStatus: JobStatus;
      updatedAt: string;
    })
  | (FilesystemVerificationInventoryItemBase & {
      target: "original_disc_archive";
      discLabel: string;
      discKind: DiscKind;
      archiveFormat: ArchiveFormat;
      archivedAt: string;
    });

export interface FilesystemVerificationInventoryPage {
  offset: number;
  limit: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export type FilesystemVerificationInventoryState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "loaded";
      items: FilesystemVerificationInventoryItem[];
      page: FilesystemVerificationInventoryPage;
    };

type InventoryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestFilesystemVerificationInventory(
  target: FilesystemVerificationInventoryTarget,
  offset: number,
  fetcher: InventoryFetch = fetch,
): Promise<Extract<FilesystemVerificationInventoryState, { status: "loaded" }>> {
  const response = await fetcher(
    `/api/filesystem-verification?target=${target}&offset=${offset}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("Filesystem verification inventory request failed");
  }
  const body = (await response.json()) as {
    inventory?: Omit<
      Extract<FilesystemVerificationInventoryState, { status: "loaded" }>,
      "status"
    >;
  };
  if (!body.inventory) {
    throw new Error("Filesystem verification inventory response is invalid");
  }
  return { status: "loaded", ...body.inventory };
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function VerificationResult({
  item,
}: {
  item: FilesystemVerificationInventoryItem;
}) {
  if (!item.status || !item.message || !item.verifiedAt) {
    return <p className="verification-result">Not verified yet.</p>;
  }
  return (
    <div
      className={`verification-result verification-${item.status}`}
      role="status"
      aria-live="polite"
    >
      <strong>{displayTerm(item.status)}</strong>
      <span>{item.message}</span>
      <small>Verified {formatTimestamp(item.verifiedAt)}</small>
    </div>
  );
}

function InventoryIdentity({
  item,
}: {
  item: FilesystemVerificationInventoryItem;
}) {
  if (item.target === "encode_job_output") {
    const title =
      item.mediaYear === null
        ? item.mediaTitle
        : `${item.mediaTitle} (${item.mediaYear})`;
    return (
      <div>
        <div className="verification-identity-heading">
          <h4>{title}</h4>
          <span className={`status status-${item.jobStatus}`}>
            {displayTerm(item.jobStatus)}
          </span>
        </div>
        <p>{item.encodingProfileName}</p>
        <p className="item-time">Updated {formatTimestamp(item.updatedAt)}</p>
        <code className="verification-record-id">{item.id}</code>
      </div>
    );
  }
  return (
    <div>
      <h4>{item.discLabel}</h4>
      <p>
        {displayTerm(item.discKind)} · {item.archiveFormat.toUpperCase()}
      </p>
      <p className="item-time">Archived {formatTimestamp(item.archivedAt)}</p>
      <code className="verification-record-id">{item.id}</code>
    </div>
  );
}

function InventoryList({
  title,
  itemName,
  state,
  target,
  onPage,
  onVerify,
  verifyingTarget,
}: {
  title: string;
  itemName: string;
  state: FilesystemVerificationInventoryState;
  target: FilesystemVerificationInventoryTarget;
  onPage: (offset: number) => void;
  onVerify: (target: FilesystemVerificationInventoryTarget, id: string) => void;
  verifyingTarget: string | null;
}) {
  if (state.status === "loading") {
    return (
      <section className="verification-inventory-list" aria-label={title}>
        <h3>{title}</h3>
        <p className="section-message">Loading known {itemName}s…</p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="verification-inventory-list" aria-label={title}>
        <h3>{title}</h3>
        <p className="section-message section-error" role="status">
          Known {itemName}s are unavailable.
        </p>
      </section>
    );
  }
  return (
    <section className="verification-inventory-list" aria-label={title}>
      <h3>{title}</h3>
      {state.items.length === 0 ? (
        <p className="section-message">No known {itemName}s.</p>
      ) : (
        <div className="item-list">
          {state.items.map((item) => (
            <article className="operation-item" key={item.id}>
              <div className="item-heading">
                <InventoryIdentity item={item} />
              </div>
              <VerificationResult item={item} />
              <button
                type="button"
                disabled={verifyingTarget !== null}
                onClick={() => onVerify(target, item.id)}
              >
                {verifyingTarget === `${target}:${item.id}`
                  ? target === "encode_job_output"
                    ? "Verifying output…"
                    : "Verifying archive…"
                  : target === "encode_job_output"
                    ? "Verify output file"
                    : "Verify archive file"}
              </button>
            </article>
          ))}
        </div>
      )}
      <nav className="profile-actions" aria-label={`${title} pages`}>
        <button
          type="button"
          disabled={!state.page.hasPrevious}
          onClick={() =>
            onPage(Math.max(0, state.page.offset - state.page.limit))
          }
        >
          Previous {target === "encode_job_output" ? "outputs" : "archives"}
        </button>
        <button
          type="button"
          disabled={!state.page.hasNext}
          onClick={() => onPage(state.page.offset + state.page.limit)}
        >
          Next {target === "encode_job_output" ? "outputs" : "archives"}
        </button>
      </nav>
    </section>
  );
}

export function FilesystemVerificationInventoryView({
  encodeOutputs,
  originalArchives,
  onEncodePage = () => undefined,
  onArchivePage = () => undefined,
  onVerify = () => undefined,
  verifyingTarget = null,
}: {
  encodeOutputs: FilesystemVerificationInventoryState;
  originalArchives: FilesystemVerificationInventoryState;
  onEncodePage?: (offset: number) => void;
  onArchivePage?: (offset: number) => void;
  onVerify?: (target: FilesystemVerificationInventoryTarget, id: string) => void;
  verifyingTarget?: string | null;
}) {
  return (
    <section className="dashboard-section wide-section verification-inventory">
      <header className="section-header">
        <div>
          <p className="section-eyebrow">On demand</p>
          <h2>Filesystem Verification</h2>
          <p>
            Check recorded files explicitly. Ordinary dashboard reads continue
            to trust the catalog.
          </p>
        </div>
      </header>
      <div className="verification-inventory-grid">
        <InventoryList
          title="Encode Job outputs"
          itemName="Encode Job output"
          state={encodeOutputs}
          target="encode_job_output"
          onPage={onEncodePage}
          onVerify={onVerify}
          verifyingTarget={verifyingTarget}
        />
        <InventoryList
          title="Original Disc Archives"
          itemName="Original Disc Archive"
          state={originalArchives}
          target="original_disc_archive"
          onPage={onArchivePage}
          onVerify={onVerify}
          verifyingTarget={verifyingTarget}
        />
      </div>
    </section>
  );
}

export function FilesystemVerificationInventory({
  refreshKey,
  onVerify,
  verifyingTarget,
}: {
  refreshKey: number;
  onVerify: (target: FilesystemVerificationInventoryTarget, id: string) => void;
  verifyingTarget: string | null;
}) {
  const [encodeOffset, setEncodeOffset] = useState(0);
  const [archiveOffset, setArchiveOffset] = useState(0);
  const [encodeOutputs, setEncodeOutputs] =
    useState<FilesystemVerificationInventoryState>({ status: "loading" });
  const [originalArchives, setOriginalArchives] =
    useState<FilesystemVerificationInventoryState>({ status: "loading" });

  useEffect(() => {
    let current = true;
    setEncodeOutputs({ status: "loading" });
    void requestFilesystemVerificationInventory(
      "encode_job_output",
      encodeOffset,
    ).then(
      (state) => current && setEncodeOutputs(state),
      () => current && setEncodeOutputs({ status: "error" }),
    );
    return () => {
      current = false;
    };
  }, [encodeOffset, refreshKey]);

  useEffect(() => {
    let current = true;
    setOriginalArchives({ status: "loading" });
    void requestFilesystemVerificationInventory(
      "original_disc_archive",
      archiveOffset,
    ).then(
      (state) => current && setOriginalArchives(state),
      () => current && setOriginalArchives({ status: "error" }),
    );
    return () => {
      current = false;
    };
  }, [archiveOffset, refreshKey]);

  return (
    <FilesystemVerificationInventoryView
      encodeOutputs={encodeOutputs}
      originalArchives={originalArchives}
      onEncodePage={setEncodeOffset}
      onArchivePage={setArchiveOffset}
      onVerify={onVerify}
      verifyingTarget={verifyingTarget}
    />
  );
}
