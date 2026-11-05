import { describeReportSetup, type ReportIssueApp } from "@threadlines/shared/reportIssue";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { describeThisBrowser } from "../relayDevice";

/** The version a bug report names: the app's own. */
export const REPORT_ISSUE_VERSION = APP_VERSION;

/**
 * What "Your setup" starts as in a bug report: the system and how
 * Threadlines is open here ("macOS, desktop app"). The person can add to it.
 */
export function defaultReportSetup(): string {
  const device = describeThisBrowser();
  const app: ReportIssueApp = isElectron
    ? "desktop app"
    : device.kind === "phone" || device.kind === "tablet"
      ? device.kind
      : "browser";
  return describeReportSetup({ app, operatingSystem: device.platform ?? null });
}
