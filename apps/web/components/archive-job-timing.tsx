"use client";

import type { ArchiveJobTiming } from "@rip-dvd/application";
import { useEffect, useState } from "react";
import { formatDuration } from "../lib/display-value";

/** Remounted for each backend observation, so only local elapsed time is added. */
export function ArchiveJobTimingDisplay({ timing, provisional = false }: {
  timing: ArchiveJobTiming;
  provisional?: boolean;
}) {
  const [anchor] = useState(() => performance.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (timing.state !== "running") return;
    const timer = setInterval(() => setElapsedMs(performance.now() - anchor), 1000);
    return () => clearInterval(timer);
  }, [anchor, timing.state]);

  if (timing.state === "unavailable" || timing.elapsedSeconds === null) {
    return <p className="job-timing">Timing unavailable</p>;
  }
  const seconds = timing.state === "running"
    ? Math.max(0, Math.floor((Date.parse(timing.observedAt) -
        Date.parse(timing.startedAt!) + elapsedMs) / 1000))
    : timing.elapsedSeconds;
  return (
    <p className="job-timing">
      {timing.state === "running" ? "Elapsed time" : "Final duration"}: {formatDuration(seconds)}
      {timing.state === "running" && provisional ? (
        <> <span>Provisional, job status unconfirmed</span></>
      ) : null}
    </p>
  );
}
