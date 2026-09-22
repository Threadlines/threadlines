/**
 * Byte sizes as people read them. Diagnostics reports exact process figures;
 * downloads report the round number a user recognises on a progress line, so
 * both roundings live here rather than being re-invented per surface.
 */
const BYTE_UNITS = ["KB", "MB", "GB"] as const;

function scaleBytes(value: number): { readonly scaled: number; readonly unit: string } {
  if (value < 1024) {
    return { scaled: value, unit: "B" };
  }
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < BYTE_UNITS.length - 1);
  return { scaled: next, unit: BYTE_UNITS[unitIndex] ?? "GB" };
}

/** Two significant decimals, e.g. "1.25 GB", "630.6 MB". */
export function formatBytes(value: number): string {
  const { scaled, unit } = scaleBytes(value);
  return unit === "B" ? `${value} B` : `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${unit}`;
}

function downloadDecimals(scaled: number): number {
  return scaled >= 100 ? 0 : 1;
}

/** A download size, rounded the way the catalog advertises it: "631 MB". */
export function formatDownloadSize(value: number): string {
  const { scaled, unit } = scaleBytes(value);
  return unit === "B" ? `${value} B` : `${scaled.toFixed(downloadDecimals(scaled))} ${unit}`;
}

/**
 * A download's progress as one phrase in a single unit: "230 of 631 MB". Both
 * halves are scaled by the total, so the number on the left never changes
 * units as it grows.
 */
export function formatDownloadProgress(done: number, total: number): string {
  const { scaled: scaledTotal, unit } = scaleBytes(total);
  const divisor = total === 0 ? 1 : total / scaledTotal;
  const scaledDone = Math.min(Math.max(done, 0), total) / divisor;
  const decimals = downloadDecimals(scaledTotal);
  return `${scaledDone.toFixed(decimals)} of ${scaledTotal.toFixed(decimals)} ${unit}`;
}
