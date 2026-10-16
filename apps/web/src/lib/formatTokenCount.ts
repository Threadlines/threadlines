/** Compact token counts for dense UI: 298 -> "298", 4100 -> "4.1k", 1200000 -> "1.2m". */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens < 1000) return String(Math.round(tokens));
  const [value, suffix] = tokens < 1_000_000 ? [tokens / 1000, "k"] : [tokens / 1_000_000, "m"];
  const rounded = value.toFixed(1);
  return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded}${suffix}`;
}
