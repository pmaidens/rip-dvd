/** Consume stderr separately from progress and retain at most one bounded line. */
export function createHandBrakeLogReader(line: (value: string) => void, overflow: () => void) {
  let buffer = "";
  const emit = () => { line(buffer.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim()); buffer = ""; };
  return {
    push(text: string) {
      for (const part of text.split(/(?<=[\r\n])/)) {
        buffer += part;
        if (buffer.length > 65_536) { overflow(); buffer = ""; }
        if (/[\r\n]$/.test(part)) emit();
      }
    },
    finish() { if (buffer !== "") emit(); },
  };
}
