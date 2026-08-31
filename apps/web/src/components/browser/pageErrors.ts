import type {
  DesktopPreviewConsoleEntry,
  DesktopPreviewNetworkFailure,
} from "@threadlines/contracts";

/** One distinct problem the page reported, with how often it recurred. */
export interface PageErrorItem {
  kind: "console" | "request";
  text: string;
  count: number;
}

/**
 * Distills what the page reported into distinct issues.
 *
 * The raw feed overstates how broken a page is, in ways that would teach the
 * user to ignore the badge:
 *
 * - Chromium logs a "Failed to load resource" console error for every failed
 *   request, so each one arrived twice; the network entry knows the URL and
 *   status, the console shadow knows less, and only the entry is kept.
 * - Aborted requests are the page changing its mind -- cancelled beacons,
 *   superseded fetches -- and DevTools does not flag them either.
 * - The same problem recurring is one problem: repeats collapse onto one
 *   item with a count, and request URLs are compared without their query
 *   string, which is where cache busters and per-request tokens live.
 */
export function distillPageErrors(input: {
  console: ReadonlyArray<DesktopPreviewConsoleEntry>;
  networkFailures: ReadonlyArray<DesktopPreviewNetworkFailure>;
}): PageErrorItem[] {
  const items = new Map<string, PageErrorItem>();
  const add = (kind: PageErrorItem["kind"], text: string) => {
    const key = `${kind}::${text}`;
    const existing = items.get(key);
    if (existing === undefined) {
      items.set(key, { kind, text, count: 1 });
    } else {
      existing.count += 1;
    }
  };
  for (const entry of input.console) {
    if (entry.level !== "error" || entry.text.startsWith("Failed to load resource")) {
      continue;
    }
    add("console", entry.text.trim());
  }
  for (const failure of input.networkFailures) {
    if (failure.errorText === "net::ERR_ABORTED") {
      continue;
    }
    const url = failure.url.split("?")[0] ?? failure.url;
    const suffix =
      failure.status !== null
        ? ` (status ${failure.status})`
        : failure.errorText !== null
          ? ` (${failure.errorText})`
          : "";
    add("request", `${url}${suffix}`);
  }
  return [...items.values()];
}

/**
 * The errors as a small text file: the agent gets the real messages and
 * URLs, and the composer shows a file chip rather than a wall of pasted
 * text.
 */
export function pageErrorsAttachment(
  url: string | null,
  items: ReadonlyArray<PageErrorItem>,
): { name: string; text: string } {
  let host = "page";
  try {
    host = new URL(url ?? "").host.replace(/[:.]/g, "-") || "page";
  } catch {
    // A tab that has not navigated yet has no address worth naming the file by.
  }
  const lines = [
    ...(url === null ? [] : [`Errors reported by ${url}:`, ""]),
    ...items.map(
      (item) =>
        `${item.kind === "console" ? "console error" : "request failed"}: ${item.text}` +
        (item.count > 1 ? ` (${item.count} times)` : ""),
    ),
  ];
  return { name: `page-errors-${host}.txt`, text: lines.join("\n") };
}
