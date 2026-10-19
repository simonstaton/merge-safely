export const TRUNCATED_MARKER = "[truncated]";

/** Cut `text` to at most `maxBytes` UTF-8 bytes (plus the marker line). */
export function truncateOutput(text: string, maxBytes: number, forced = false): { output: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes && !forced) return { output: text, truncated: false };
  let end = Math.min(buf.length, maxBytes);
  // Back off to a code point boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && end < buf.length && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  const head = buf.subarray(0, end).toString("utf8");
  return { output: `${head}${head.endsWith("\n") ? "" : "\n"}${TRUNCATED_MARKER}`, truncated: true };
}
