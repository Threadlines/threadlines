import type {
  SourceControlDiscoveryResult,
  SourceControlToolVersionAdvisory,
} from "@threadlines/contracts";

import { sourceControlToolAdvisoryDismissalKey } from "../sourceControlToolAdvisoryDismissal";

export interface SourceControlToolUpdateWarning {
  readonly label: string;
  readonly advisory: SourceControlToolVersionAdvisory;
  readonly dismissalKey: string;
}

export function collectSourceControlToolUpdateWarnings(input: {
  readonly discovery: SourceControlDiscoveryResult;
  readonly environmentKey: string;
}): ReadonlyArray<SourceControlToolUpdateWarning> {
  return [...input.discovery.versionControlSystems, ...input.discovery.sourceControlProviders]
    .flatMap((item) => {
      const advisory = item.versionAdvisory;
      if (
        advisory?.status !== "recommended_update" ||
        advisory.severity !== "warning" ||
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

export function sourceControlToolUpdateWarningSetKey(
  warnings: ReadonlyArray<SourceControlToolUpdateWarning>,
): string | null {
  return warnings.length > 0 ? warnings.map((warning) => warning.dismissalKey).join("|") : null;
}
