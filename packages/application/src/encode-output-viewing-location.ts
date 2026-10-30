import type { DataAccess } from "@rip-dvd/data-access";
import type { IntervalClassification } from "./encode-output-correspondence.js";
import type { EncodeOutputInspection } from "./encode-output-inspection.js";
import { openBrowserRendition } from "./encode-output-rendition.js";
import { inspectEncodeOutputIdentity } from "./encode-output-inspection.js";

type Interval = NonNullable<IntervalClassification["outputInterval"]>;
export interface EncodeOutputViewingLocation {
  renditionId: string;
  mediaIdentity: string | null;
  reasonCode: string | null;
  reason: string | null;
  targets: { intervalIndex: number; canonicalOutputInterval: Interval; renditionInterval: Interval; seekSeconds: number }[];
}

/** Consume existing canonical correspondence and the independently measured
 * viewing clock. Neither source estimates nor duration ratios locate media.
 */
export async function inspectEncodeOutputViewingLocation(
  access: DataAccess, renditionId: string,
  inspection: EncodeOutputInspection,
  intervals: IntervalClassification[], enabled?: boolean,
): Promise<EncodeOutputViewingLocation> {
  const unavailable = (reasonCode: string, reason: string): EncodeOutputViewingLocation => ({
    renditionId, mediaIdentity: null, reasonCode, reason, targets: [],
  });
  const record = access.browserRenditions.find(renditionId);
  if (!record || record.sourceIdentity !== inspection.artifact.identity || record.sourceAuthorityRevision !== inspection.authorityRevision ||
      JSON.parse(record.sourceJson).file.mutationRevision !== inspection.artifact.file.mutationRevision) {
    return unavailable("RENDITION_SOURCE_CHANGED", "The rendition does not represent this inspected canonical output generation.");
  }
  const timeline = record.timeline;
  if (timeline?.policyVersion !== "browser-rendition-exact-video-v1" || timeline.status !== "verified" ||
      intervals.some((interval) => interval.evidence.observedOutputBytesSha256 !== timeline.canonicalBytesSha256)) {
    return unavailable("RENDITION_TIMELINE_UNVERIFIED", "The canonical output location has no measured relationship to this rendition's clock. Ordinary playback remains available.");
  }
  let opened;
  try { opened = await openBrowserRendition(access, renditionId, enabled); }
  catch {
    return unavailable("RENDITION_MEDIA_UNAVAILABLE", "The exact measured rendition media is unavailable. Ordinary playback can be reviewed separately.");
  }
  try {
    const current = inspectEncodeOutputIdentity(access, inspection.artifact.identity);
    if (current.authorityRevision !== inspection.authorityRevision || current.artifact.file.mutationRevision !== inspection.artifact.file.mutationRevision) {
      return unavailable("RENDITION_SOURCE_CHANGED", "Canonical output evidence changed while checking the rendition target. Refresh inspection before seeking.");
    }
    const targets: EncodeOutputViewingLocation["targets"] = [];
    for (const interval of intervals) {
      if (interval.status !== "verified" || !interval.outputInterval) continue;
      const output = interval.outputInterval;
      const first = timeline.frames.findIndex((frame) => frame.canonical.startMilliseconds === output.startMilliseconds);
      const measured = interval.evidence.measuredCorrespondence;
      const count = measured?.status === "measured" ? measured.outputVideo.frameCount : 0;
      const frames = first < 0 ? [] : timeline.frames.slice(first, first + count);
      if (!count || frames.length !== count || Math.max(...frames.map((frame) => frame.canonical.endMilliseconds)) !== output.endMilliseconds) continue;
      const renditionInterval = {
        startMilliseconds: timeline.frames[first]!.rendition.startMilliseconds,
        endMilliseconds: Math.max(...frames.map((frame) => frame.rendition.endMilliseconds)),
      };
      targets.push({ intervalIndex: interval.intervalIndex, canonicalOutputInterval: output, renditionInterval,
        seekSeconds: renditionInterval.startMilliseconds / 1000 });
    }
    return { renditionId, mediaIdentity: opened.rendition.media!.identity, targets,
      reasonCode: targets.length ? null : "OUTPUT_SEEK_UNAVAILABLE",
      reason: targets.length ? null : "No verified canonical interval has a proved seek target in this rendition. Ordinary playback remains available." };
  } finally { await opened.file.close(); }
}
