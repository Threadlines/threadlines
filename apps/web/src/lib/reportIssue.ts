import { buildReportIssueUrl, type ReportIssueApp } from "@threadlines/shared/reportIssue";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { describeThisBrowser } from "../relayDevice";

/**
 * GitHub's bug form for this copy of Threadlines, as every "Report a problem"
 * button opens it: the version, the system and how Threadlines is open
 * already filled in.
 */
export function reportIssueUrl(): string {
  const device = describeThisBrowser();
  const app: ReportIssueApp = isElectron
    ? "desktop app"
    : device.kind === "phone" || device.kind === "tablet"
      ? device.kind
      : "browser";
  return buildReportIssueUrl({
    version: APP_VERSION,
    app,
    operatingSystem: device.platform ?? null,
  });
}
