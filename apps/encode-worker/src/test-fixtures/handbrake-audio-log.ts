export function audioLog(sourceIds: readonly number[] = [128]): string {
  const lines = ["[00:00:01] Starting Task: Encoding Pass", "[00:00:01] job configuration:"];
  for (const [index, id] of sourceIds.entries()) lines.push(`[00:00:01] * audio track ${index + 1}`,
    `[00:00:01] + decoder: Synthetic audio (track ${sourceIds.indexOf(id) + 1}, id 0x${((id << 8) | 0xbd).toString(16)})`);
  return `${lines.join("\n")}\n`;
}
