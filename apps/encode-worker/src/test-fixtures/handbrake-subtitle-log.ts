// Synthetic HandBrake 1.9.2 stderr. No source media or operator logs.
export function subtitleLog({
  sourceCount = 2,
  search = false,
  reused = false,
  noForcedHits = false,
}: {
  sourceCount?: number;
  search?: boolean;
  reused?: boolean;
  noForcedHits?: boolean;
} = {}): string {
  const lines: string[] = [];
  if (search) {
    lines.push(
      "[00:00:01] Starting Task: Subtitle Scan",
      "[00:00:01] job configuration:",
      "[00:00:01]  * Foreign Audio Search: Passthru, Forced Only, Default",
      `[00:00:02] Subtitle track 1 (id 0x21bd) 'English': 40 hits (${noForcedHits ? 0 : reused ? 40 : 3} forced)`,
      `[00:00:02] Found a subtitle candidate with id 0x21bd${noForcedHits ? "" : " (contains forced subs)"}`,
    );
  }
  lines.push("[00:00:03] Starting Task: Encoding Pass", "[00:00:03] job configuration:");
  let output = 0;
  if (search) {
    lines.push(`[00:00:03]  * subtitle track ${++output}, English (track 1, id 0x21bd, Picture) -> Passthru${noForcedHits ? "" : ", Forced Only"}, Default`);
  }
  for (let source = 1; source <= sourceCount; source++) {
    if (search && (reused || noForcedHits) && source === 2) continue;
    lines.push(`[00:00:03]  * subtitle track ${++output}, English (track ${source - 1}, id 0x${(0x1f + source).toString(16)}bd, Picture) -> Passthru`);
  }
  return `${lines.join("\n")}\n`;
}
