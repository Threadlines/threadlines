/**
 * The link behind every "Report a problem" button: GitHub's bug report form
 * with the version and setup already filled in. The person reads the form and
 * submits it from their own GitHub account, on a public page, so this only
 * ever carries the short facts below: never logs, paths or project names.
 *
 * @module reportIssue
 */

const BUG_REPORT_FORM_URL = "https://github.com/Threadlines/threadlines/issues/new";

export type ReportIssueApp = "desktop app" | "browser" | "phone" | "tablet";

export interface ReportIssueContext {
  readonly version: string;
  readonly app: ReportIssueApp;
  /** "macOS", "Windows", "iOS" and the like, or null when it couldn't be told. */
  readonly operatingSystem: string | null;
}

const NODE_PLATFORM_LABELS: Partial<Record<string, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** A plain name for Node's `process.platform`, as the desktop app knows it. */
export function nodePlatformLabel(platform: string): string | null {
  return NODE_PLATFORM_LABELS[platform] ?? null;
}

/** The form's address, with its "Version" and "Your setup" fields filled in. */
export function buildReportIssueUrl(context: ReportIssueContext): string {
  const setup = [context.operatingSystem, context.app]
    .filter((part) => part !== null && part.trim().length > 0)
    .join(", ");
  const fields = { template: "bug_report.yml", version: context.version, environment: setup };
  const query = Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${BUG_REPORT_FORM_URL}?${query}`;
}
