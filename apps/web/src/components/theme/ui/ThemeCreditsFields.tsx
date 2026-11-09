/**
 * The credit a shared theme carries, as the export and Share to Showcase
 * dialogs ask for it (docs/design/custom-themes.md, "Sharing"). A theme that
 * already has credits (someone else's, or a starter) keeps them and shows
 * them; one without takes a name, a link and a license, which this device
 * remembers for the next share.
 */
import {
  THEME_LICENSES,
  ThemeCredits,
  type ThemeLicense,
  type ThemeManifest,
} from "@threadlines/contracts";
import { cleanThemeCredits, THEME_LICENSE_WORDS } from "@threadlines/shared/themeSharing";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Input } from "../../ui/input";
import { LabeledField } from "../../ui/labeled-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { ThemeCreditsText } from "./ThemeCreditsText";

const REMEMBERED_CREDITS_KEY = "threadlines:theme-export-credits";
const isCredits = Schema.is(ThemeCredits);
/** What a person may pick for their own theme; MIT stays the starters'. */
const OWN_LICENSES = THEME_LICENSES.filter((license) => license !== "MIT");

export interface ThemeCreditsDraft {
  /** The credits the theme already carries, which it keeps; null when it has none. */
  readonly own: ThemeCredits | null;
  /** What the person gave, cleaned; null when nothing. */
  readonly given: ThemeCredits | null;
  /** Their license, which a share without credits of its own takes. */
  readonly license: ThemeLicense;
  /** The link is an https address and everything fits. */
  readonly valid: boolean;
  /** Remembers what they gave, for the next share. */
  readonly remember: () => void;
  /** The fields, or the credit the theme keeps. */
  readonly fields: ReactNode;
}

export function useThemeCreditsDraft(
  manifest: ThemeManifest,
  /** What to say under credits a theme keeps. */
  keepsLine: string,
): ThemeCreditsDraft {
  const [remembered, setRemembered] = useLocalStorage<ThemeCredits, ThemeCredits>(
    REMEMBERED_CREDITS_KEY,
    {},
    ThemeCredits,
  );
  const own = cleanThemeCredits(manifest.credits);
  const [author, setAuthor] = useState(remembered.author ?? "");
  const [link, setLink] = useState(remembered.link ?? "");
  const [license, setLicense] = useState<ThemeLicense>(
    remembered.license !== undefined && remembered.license !== "MIT"
      ? remembered.license
      : "CC-BY-4.0",
  );
  const given = cleanThemeCredits({
    ...(author.trim() ? { author } : {}),
    ...(link.trim() ? { link } : {}),
    license,
  });
  // The schema is the rule: an https address, names and links within their lengths.
  const valid = own !== null || given === null || isCredits(given);

  const fields =
    own !== null ? (
      <ThemeCreditsText credits={own} data-testid="theme-export-credits">
        {keepsLine}
      </ThemeCreditsText>
    ) : (
      <>
        <LabeledField label="Credit" optional hint="The name people see with your theme.">
          <Input
            nativeInput
            size="sm"
            value={author}
            maxLength={60}
            placeholder="Your name"
            onChange={(event) => setAuthor(event.target.value)}
          />
        </LabeledField>
        <LabeledField
          label="Link"
          optional
          hint={
            link.trim() !== "" && !valid
              ? "Use a full address that starts with https://"
              : "Your site or profile."
          }
        >
          <Input
            nativeInput
            size="sm"
            type="url"
            value={link}
            maxLength={200}
            placeholder="https://"
            aria-invalid={!valid}
            onChange={(event) => setLink(event.target.value)}
          />
        </LabeledField>
        <LabeledField label="License" hint={THEME_LICENSE_WORDS[license].lets}>
          <Select
            value={license}
            onValueChange={(next) => {
              if (next !== null) setLicense(next as ThemeLicense);
            }}
          >
            <SelectTrigger size="sm" aria-label="License">
              <SelectValue>{THEME_LICENSE_WORDS[license].name}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {OWN_LICENSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {THEME_LICENSE_WORDS[option].name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </LabeledField>
      </>
    );

  return {
    own,
    given,
    license,
    valid,
    remember: () => {
      if (own === null && given !== null) setRemembered(given);
    },
    fields,
  };
}
