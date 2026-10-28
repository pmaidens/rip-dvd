import type {
  ArchiveArtifact,
  ArchiveArtifactAction,
} from "@rip-dvd/application";

import { createMutationKey } from "./mutation-key";

export type ArchiveArtifactFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestArchiveArtifact(
  originalDiscArchiveId: string,
  fetcher: ArchiveArtifactFetch = fetch,
): Promise<ArchiveArtifact> {
  const response = await fetcher(
    `/api/operations?kind=original-disc-archives&id=${encodeURIComponent(originalDiscArchiveId)}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("Archive artifact inspection failed");
  const body = await response.json() as {
    item?: { archiveArtifact?: ArchiveArtifact };
  };
  if (body.item?.archiveArtifact === undefined) {
    throw new Error("Archive artifact inspection is unavailable");
  }
  return body.item.archiveArtifact;
}

function artifactAction(
  artifact: ArchiveArtifact,
  name: ArchiveArtifactAction["name"],
): ArchiveArtifactAction {
  const action = artifact.actions.find((candidate) => candidate.name === name);
  if (action === undefined) {
    throw new Error(`Archive artifact action ${name} is unavailable`);
  }
  return action;
}

export async function requestArchiveArtifactAction(
  artifact: ArchiveArtifact,
  name: ArchiveArtifactAction["name"],
  options: { speedMode?: "normal" | "low" } = {},
  fetcher: ArchiveArtifactFetch = fetch,
  mutationKey = createMutationKey(),
): Promise<void> {
  const action = artifactAction(artifact, name);
  if (!action.available || action.expectedInputs === null) {
    throw new Error("Archive artifact action is blocked");
  }
  const recoveryId = artifact.recovery.record?.id;
  if (recoveryId === undefined) {
    throw new Error("Archive Recovery identity is unavailable");
  }
  const path = {
    stop: "stop",
    resume: "resume",
    "verify-disc": "verification",
    "confirm-disc": "confirmation",
    reconcile: "reconciliation",
  }[name];
  const { speedModes: _speedModes, ...expectedInputs } =
    action.expectedInputs;
  const response = await fetcher(
    `/api/archive-recoveries/${encodeURIComponent(recoveryId)}/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutationKey,
        ...expectedInputs,
        ...(name === "resume"
          ? { speedMode: options.speedMode ?? "normal" }
          : {}),
      }),
    },
  );
  if (!response.ok) throw new Error("Archive artifact action failed");
}
