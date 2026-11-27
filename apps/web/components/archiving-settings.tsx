"use client";

import { useEffect, useRef, useState } from "react";

import { createMutationKey } from "../lib/mutation-key";

async function readSavedValue(response: Response): Promise<boolean> {
  if (!response.ok) throw new Error("Archiving settings request failed.");
  const body = await response.json();
  if (typeof body?.automaticallyArchiveInsertedDvds !== "boolean") {
    throw new Error("Archiving settings response is invalid.");
  }
  return body.automaticallyArchiveInsertedDvds;
}

export function ArchivingSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadingAttempt, setLoadingAttempt] = useState(0);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const [message, setMessage] = useState("Loading Archiving settings…");
  const [problem, setProblem] = useState<string | null>(null);
  const pendingKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/archiving-settings", { signal: controller.signal })
      .then(readSavedValue).then((value) => {
        if (controller.signal.aborted) return;
        setEnabled(value);
        setMessage("");
      }).catch(() => {
        if (controller.signal.aborted) return;
        setProblem("Archiving settings are unavailable.");
        setMessage("");
      });
    return () => controller.abort();
  }, [loadingAttempt]);

  async function save(value: boolean) {
    const mutationKey = pendingKey.current ?? createMutationKey();
    pendingKey.current = mutationKey;
    setPendingValue(value);
    setProblem(null);
    setMessage("Saving Archiving settings…");
    try {
      const response = await fetch("/api/archiving-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutationKey, automaticallyArchiveInsertedDvds: value }),
      });
      if (!response.ok) throw new Error("Archiving settings request failed.");
      // A replay returns the original mutation result, which another operator may have changed.
      const saved = await readSavedValue(await fetch("/api/archiving-settings"));
      pendingKey.current = null;
      setEnabled(saved);
      setMessage(saved ? "Automatic archiving enabled." : "Automatic archiving disabled.");
    } catch {
      setProblem("The saved Archiving setting could not be confirmed. Try changing it again.");
      setMessage("");
    } finally {
      setPendingValue(null);
    }
  }

  return <section id="archiving" aria-labelledby="archiving-heading">
    <h2 id="archiving-heading">Archiving</h2>
    <label>
      <input
        type="checkbox"
        checked={(pendingValue ?? enabled) === true}
        disabled={enabled === null || pendingValue !== null}
        aria-describedby="automatic-archiving-description"
        onChange={(event) => void save(event.currentTarget.checked)}
      />
      {" "}Automatically archive inserted DVDs
    </label>
    <p id="automatic-archiving-description">
      After Disc Inspection, the Archive Worker queues eligible DVDs from enabled drives.
      Turning this off only affects future automatic requests.
    </p>
    <p role="status">{message}</p>
    {problem && <p role="alert">{problem}</p>}
    {problem && enabled === null && <button onClick={() => {
      setProblem(null);
      setMessage("Loading Archiving settings…");
      setLoadingAttempt((attempt) => attempt + 1);
    }}>Try again</button>}
  </section>;
}
