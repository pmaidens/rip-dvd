import { MAX_DVD_AUDIO_STREAMS_PER_TITLE } from "@rip-dvd/data-access";
import { EncodeOutputValidationError } from "./encode-output-validator.js";
import { createHandBrakeLogReader } from "./handbrake-log-reader.js";

/** HandBrake 1.9.2 hb_display_job_info logs each output's input DVD stream ID.
 * A surround preset may emit several outputs for one input. Retain that mapping,
 * rather than treating an output count as proof that every source survived. */
export function createHandBrakeAudioProvenanceParser() {
  let task = "";
  let configuration = false;
  let invalid = false;
  let outputTrack: number | null = null;
  let sources: number[] = [];
  function line(value: string) {
    if (invalid) return;
    if (value.startsWith("Starting Task: ")) {
      task = value.slice("Starting Task: ".length); configuration = false;
    } else if (value === "job configuration:") {
      configuration = task === "Encoding Pass" || task === "Analysis Pass";
      if (configuration) { sources = []; outputTrack = null; }
    } else if (configuration && value.startsWith("* audio track ")) {
      const match = /^\* audio track (\d+)$/.exec(value);
      if (outputTrack !== null || !match || Number(match[1]) !== sources.length + 1 ||
          sources.length >= MAX_DVD_AUDIO_STREAMS_PER_TITLE * 8) invalid = true;
      else outputTrack = Number(match[1]);
    } else if (configuration && outputTrack !== null && value.startsWith("+ decoder:")) {
      const match = /\(track \d+, id 0x([\da-f]+)\)$/.exec(value);
      if (!match) invalid = true;
      else {
        const packedId = Number.parseInt(match[1]!, 16);
        // DVD private-stream IDs pack the substream above the 0xbd PES ID.
        const sourceId = packedId > 0xff && packedId <= 0xffff && (packedId & 0xff) === 0xbd
          ? packedId >>> 8 : packedId;
        if (!Number.isSafeInteger(sourceId)) invalid = true;
        sources.push(sourceId); outputTrack = null;
      }
    }
  }
  const reader = createHandBrakeLogReader(line, () => { invalid = true; });
  return {
    push: reader.push,
    finish(): readonly number[] {
      reader.finish();
      if (invalid || outputTrack !== null || !configuration || task !== "Encoding Pass") throw new EncodeOutputValidationError("HandBrake audio provenance is invalid",
        { kind: "validation_check", check: "audio_timing" });
      return [...sources];
    },
  };
}
