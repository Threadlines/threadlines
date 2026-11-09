/**
 * A theme's credits as the import and export dialogs show them: who made it,
 * its license and its link (which opens in the browser), joined on one line,
 * then whatever the dialog adds. Nothing at all when the theme has none.
 */
import type { ThemeCredits } from "@threadlines/contracts";
import {
  cleanThemeCredits,
  THEME_LICENSE_WORDS,
  themeCreditsLine,
} from "@threadlines/shared/themeSharing";
import type { ReactNode } from "react";

import { openExternalUrl } from "~/lib/externalLinks";

export function ThemeCreditsText({
  credits,
  showLicenseTerms = false,
  children,
  ...props
}: {
  readonly credits: ThemeCredits | undefined;
  /** Also say what the license lets you do, on a line of its own. */
  readonly showLicenseTerms?: boolean;
  /** A sentence after the credit line. */
  readonly children?: ReactNode;
  readonly "data-testid"?: string;
}) {
  const clean = cleanThemeCredits(credits);
  if (clean === null) return null;
  const line = themeCreditsLine(clean);
  return (
    <p className="text-[13px] text-muted-foreground" data-testid={props["data-testid"]}>
      {line}
      {clean.link !== undefined ? (
        <>
          {line !== null ? " · " : null}
          <button
            type="button"
            className="text-primary-readable underline-offset-2 hover:underline"
            onClick={() => openExternalUrl(clean.link!)}
          >
            {clean.link.replace(/^https:\/\//, "").replace(/\/$/, "")}
          </button>
        </>
      ) : null}
      {children ? <>. {children}</> : null}
      {showLicenseTerms && clean.license !== undefined ? (
        <span className="block">{THEME_LICENSE_WORDS[clean.license].lets}</span>
      ) : null}
    </p>
  );
}
