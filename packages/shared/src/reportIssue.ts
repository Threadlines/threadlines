/**
 * "Report a problem": the bug report a person writes in Threadlines, as the
 * server posts it to GitHub from their own account (a body laid out like the
 * issue form's), and as the link to GitHub's form carries it when they finish
 * there instead. Issues are public, so a report only ever holds what the
 * person typed plus the version and setup: never logs, paths or project names
 * they didn't put there themselves.
 *
 * @module reportIssue
 */

export const THREADLINES_REPOSITORY = "Threadlines/threadlines";

const BUG_REPORT_FORM_URL = `https://github.com/${THREADLINES_REPOSITORY}/issues/new`;
const TITLE_PREFIX = "[Bug]: ";

/**
 * Starts the hidden line that ends every report the app posts. A workflow
 * labels issues carrying it (GitHub drops labels the reporter can't set), and
 * the server finds a report it already posted by the id after it.
 */
export const REPORT_ISSUE_MARKER_PREFIX = "<!-- threadlines:report-a-problem";

/** Longer addresses risk GitHub turning the page away; past this a link carries only the facts. */
export const REPORT_ISSUE_URL_MAX_LENGTH = 8_000;

export type ReportIssueApp = "desktop app" | "browser" | "phone" | "tablet";

/** What the person wrote. Empty optional parts are left out. */
export interface ReportIssueDraft {
  readonly title: string;
  readonly whatHappened: string;
  readonly steps: string;
  readonly expected: string;
  readonly errorText: string;
}

/** "Windows, desktop app": the system, then how Threadlines is open. */
export function describeReportSetup(input: {
  readonly app: ReportIssueApp;
  /** "macOS", "Windows", "iOS" and the like, or null when it couldn't be told. */
  readonly operatingSystem: string | null;
}): string {
  return [input.operatingSystem, input.app]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(", ");
}

/** The issue's title, marked like the bug form marks it. */
export function reportIssueTitle(title: string): string {
  return `${TITLE_PREFIX}${title.trim()}`;
}

export function reportIssueMarker(submissionId: string): string {
  return `${REPORT_ISSUE_MARKER_PREFIX} ${submissionId} -->`;
}

/** A code block whose fence no run of backticks inside the text can close. */
function fenced(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * The issue body: the bug form's sections in its order, so a report from the
 * app reads like one from the form. With a submission id it ends with the
 * hidden marker; without one it is the text a person pastes into the form.
 */
export function buildReportIssueBody(input: {
  readonly draft: ReportIssueDraft;
  readonly version: string;
  readonly setup: string;
  readonly submissionId?: string;
}): string {
  const { draft } = input;
  const sections: Array<readonly [heading: string, text: string]> = [
    ["What happened?", draft.whatHappened.trim()],
    ["How can we make it happen?", draft.steps.trim()],
    ["Version", input.version.trim()],
    ["Your setup", input.setup.trim()],
  ];
  if (draft.expected.trim().length > 0) {
    sections.push(["What did you expect instead?", draft.expected.trim()]);
  }
  const errorText = draft.errorText.replace(/^\s*\n|\s+$/g, "");
  if (errorText.length > 0) {
    sections.push(["Error text or logs", fenced(errorText)]);
  }
  const body = sections.map(([heading, text]) => `### ${heading}\n\n${text}`).join("\n\n");
  return input.submissionId === undefined
    ? body
    : `${body}\n\n${reportIssueMarker(input.submissionId)}\n`;
}

/**
 * GitHub's bug form with its fields filled in through their ids: always the
 * version and setup, and whatever the person already wrote. The caller checks
 * the length against REPORT_ISSUE_URL_MAX_LENGTH.
 */
export function buildReportIssueUrl(input: {
  readonly version: string;
  readonly setup: string;
  readonly draft?: ReportIssueDraft;
}): string {
  const { draft } = input;
  const fields: Array<readonly [string, string]> = [["template", "bug_report.yml"]];
  if (draft && draft.title.trim().length > 0) {
    fields.push(["title", reportIssueTitle(draft.title)]);
  }
  fields.push(["version", input.version], ["environment", input.setup]);
  if (draft) {
    fields.push(
      ["actual", draft.whatHappened.trim()],
      ["steps", draft.steps.trim()],
      ["expected", draft.expected.trim()],
      ["logs", draft.errorText.trim()],
    );
  }
  const query = fields
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${BUG_REPORT_FORM_URL}?${query}`;
}
