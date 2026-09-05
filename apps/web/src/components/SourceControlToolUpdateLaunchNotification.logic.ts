import type {
  SourceControlDiscoveryResult,
  SourceControlToolVersionAdvisory,
} from "@threadlines/contracts";

import { sourceControlToolAdvisoryDismissalKey } from "../sourceControlToolAdvisoryDismissal";

export interface SourceControlToolUpdateNotice {
  readonly label: string;
  readonly advisory: SourceControlToolVersionAdvisory;
  readonly dismissalKey: string;
}

/**
 * Every git / GitHub CLI advisory the launch toast should mention: security
 * floors and plain newer releases alike. The server marks notifiable
 * advisories with a key derived from the latest release, so the dismissal
 * expires on its own when the next release ships.
 */
export function collectSourceControlToolUpdateNotices(input: {
  readonly discovery: SourceControlDiscoveryResult;
  readonly environmentKey: string;
}): ReadonlyArray<SourceControlToolUpdateNotice> {
  return [...input.discovery.versionControlSystems, ...input.discovery.sourceControlProviders]
    .flatMap((item) => {
      const advisory = item.versionAdvisory;
      if (
        (advisory?.status !== "recommended_update" && advisory?.status !== "behind_latest") ||
        advisory.notificationKey === null
      ) {
        return [];
      }

      const dismissalKey = sourceControlToolAdvisoryDismissalKey({
        environmentKey: input.environmentKey,
        notificationKey: advisory.notificationKey,
      });
      return dismissalKey ? [{ label: item.label, advisory, dismissalKey }] : [];
    })
    .sort((left, right) => left.dismissalKey.localeCompare(right.dismissalKey));
}

export function sourceControlToolUpdateNoticeSetKey(
  notices: ReadonlyArray<SourceControlToolUpdateNotice>,
): string | null {
  return notices.length > 0 ? notices.map((notice) => notice.dismissalKey).join("|") : null;
}

export interface SourceControlToolUpdateToastCopy {
  readonly type: "warning" | "info";
  readonly title: string;
  readonly description: string;
}

/** Toast wording: security floors read as recommended, plain releases as available. */
export function sourceControlToolUpdateToastCopy(
  notices: ReadonlyArray<SourceControlToolUpdateNotice>,
): SourceControlToolUpdateToastCopy {
  const hasSecurityNotice = notices.some((notice) => notice.advisory.severity === "warning");
  const verb = hasSecurityNotice ? "recommended" : "available";
  const labels = notices.map((notice) => notice.label).join(" and ");

  if (notices.length === 1) {
    const notice = notices[0]!;
    return {
      type: hasSecurityNotice ? "warning" : "info",
      title: `${notice.label} update ${verb}`,
      description: notice.advisory.message ?? `A newer ${notice.label} release is available.`,
    };
  }

  return {
    type: hasSecurityNotice ? "warning" : "info",
    title: `${notices.length} source control updates ${verb}`,
    description: hasSecurityNotice
      ? `${labels} have newer releases, including a recommended security fix.`
      : `${labels} have newer releases.`,
  };
}
