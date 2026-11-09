/**
 * Export, made ready to share (docs/design/custom-themes.md, "Sharing"). The
 * file never says which thread made the theme and leaves the prompt out unless
 * its author keeps it. A theme that already carries credits (a starter, or
 * someone else's theme) keeps them; one without takes its author's own, which
 * this device remembers for the next export.
 */
import {
  THEME_LICENSES,
  ThemeCredits,
  type ThemeLicense,
  type ThemeManifest,
} from "@threadlines/contracts";
import {
  cleanThemeCredits,
  THEME_LICENSE_WORDS,
  themeForSharing,
} from "@threadlines/shared/themeSharing";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { exportThemeFile } from "~/themeLibrary/themeFiles";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { LabeledField } from "../../ui/labeled-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { ThemeCreditsText } from "./ThemeCreditsText";

const REMEMBERED_CREDITS_KEY = "threadlines:theme-export-credits";
const isCredits = Schema.is(ThemeCredits);
/** What a person may pick for their own theme; MIT stays the starters'. */
const OWN_LICENSES = THEME_LICENSES.filter((license) => license !== "MIT");

export function ThemeExportDialog({
  manifest,
  name,
  onClose,
}: {
  readonly manifest: ThemeManifest;
  /** The name the theme goes by here, which the file takes. */
  readonly name: string;
  readonly onClose: () => void;
}) {
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
  const [includePrompt, setIncludePrompt] = useState(false);
  const given = cleanThemeCredits({
    ...(author.trim() ? { author } : {}),
    ...(link.trim() ? { link } : {}),
    license,
  });
  // The schema is the rule: an https address, names and links within their lengths.
  const valid = own !== null || given === null || isCredits(given);
  const prompt = manifest.prompt?.trim() ? manifest.prompt : null;

  const save = () => {
    if (!valid) return;
    if (own === null && given !== null) setRemembered(given);
    exportThemeFile(themeForSharing(manifest, { name, includePrompt, credits: given }));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md" data-testid="theme-export-dialog">
        <DialogHeader>
          <DialogTitle>Export {name}</DialogTitle>
          <DialogDescription>
            A theme file anyone can add with Import theme file. It never says which thread made the
            theme.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {own !== null ? (
            <ThemeCreditsText credits={own} data-testid="theme-export-credits">
              The file keeps its credit.
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
          )}
          {prompt !== null ? (
            <div className="grid gap-1.5">
              <label className="flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                Include the prompt
                <Switch
                  checked={includePrompt}
                  onCheckedChange={(checked) => setIncludePrompt(Boolean(checked))}
                />
              </label>
              <p className="line-clamp-3 text-xs text-muted-foreground">{prompt}</p>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={save}>
            Export
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
