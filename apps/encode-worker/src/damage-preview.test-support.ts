import { writeFileSync } from "node:fs";
import type { DamagePreviewGenerator } from "./damage-preview-generator.js";

export const bytes = Buffer.from("synthetic canonical MKV bytes for adapter transport");
export function media(overrides: Partial<DamagePreviewGenerator> = {}): DamagePreviewGenerator {
  return {
    versions: async () => ({ handbrake: "synthetic-handbrake-v1", ffprobe: "synthetic-probe-v1" }),
    scan: async () => ({ navigation: { videoTitleSetNumber: 1, titleSetTitleNumber: 1, programChainNumber: 1 }, selectedPath: [{ programNumber: 1, cellNumber: 1, vobId: 1, cellId: 1 }], durationMilliseconds: 500_000, chapterDurations: [125_000, 125_000, 125_000, 125_000], audio: [{ sourceId: 128, physicalId: 128, trackNumber: 1, codec: "ac3", channels: 2 }], subtitles: [], angleCount: 1 }),
    async generate(request) { writeFileSync(request.outputPath, bytes); request.onOutput("Encoding: task 1 of 1, 100.00 %"); },
    inspect: async (path) => ({ videoStartMilliseconds: 0, durationMilliseconds: /\/0(?:\.partial)?\.mkv$/.test(path) ? 45_000 : 339_000, videoCount: 1, audioCount: 1, subtitleCount: 0 }),
    requireInactive() {}, whenInactive: async () => undefined,
    ...overrides,
  };
}
