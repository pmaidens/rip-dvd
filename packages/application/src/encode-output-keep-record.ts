import type { KeptFailedEncodeOutput } from "@rip-dvd/data-access";
import type { EncodeOutputKeepPreflight } from "./encode-output-keep-preflight.js";

export function presentKeptFailedEncodeOutput(record: KeptFailedEncodeOutput | null) {
  if (record === null) return null;
  const { evidenceJson, ...kept } = record;
  return { ...kept, evidence: JSON.parse(evidenceJson) as EncodeOutputKeepPreflight };
}
