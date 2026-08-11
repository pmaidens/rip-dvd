import type { EncodeJobProgress } from "@rip-dvd/data-access";

const MAX_PROGRESS_BUFFER_BYTES = 65_536;

function progressFromSegment(segment: string): EncodeJobProgress | null {
  const encoding =
    /Encoding:\s+task\s+\d+\s+of\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%/.exec(
      segment,
    );
  if (encoding) {
    const eta = /ETA\s+([0-9]+)h([0-9]+)m([0-9]+)s/.exec(segment);
    return {
      phase: "encoding",
      progressPercent: Math.min(100, Math.floor(Number(encoding[1]))),
      etaSeconds: eta
        ? Number(eta[1]) * 3_600 + Number(eta[2]) * 60 + Number(eta[3])
        : null,
    };
  }
  const preview =
    /Scanning title\s+\d+\s+of\s+\d+,\s+preview\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%/.exec(
      segment,
    );
  if (preview) {
    return {
      phase: "previewing",
      progressPercent: Math.min(100, Math.floor(Number(preview[1]))),
      etaSeconds: null,
    };
  }
  const scanning =
    /Scanning title\s+\d+\s+of\s+\d+,\s+([0-9]+(?:\.[0-9]+)?)\s*%/.exec(
      segment,
    );
  return scanning
    ? {
        phase: "scanning",
        progressPercent: Math.min(100, Math.floor(Number(scanning[1]))),
        etaSeconds: null,
      }
    : null;
}

export function createProgressParser(
  onProgress: (progress: EncodeJobProgress) => void,
) {
  let buffer = "";
  return (text: string, flush = false) => {
    buffer = `${buffer}${text}`.slice(-MAX_PROGRESS_BUFFER_BYTES);
    const segments = buffer.split(/[\r\n]/);
    buffer = flush ? "" : (segments.pop() ?? "");
    for (const segment of segments) {
      const progress = progressFromSegment(segment);
      if (progress) {
        onProgress(progress);
      }
    }
    if (flush && buffer.trim() !== "") {
      const progress = progressFromSegment(buffer);
      if (progress) {
        onProgress(progress);
      }
      buffer = "";
    }
  };
}
