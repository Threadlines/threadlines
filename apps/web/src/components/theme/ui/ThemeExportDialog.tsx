/**
 * Export, made ready to share (docs/design/custom-themes.md, "Sharing"). The
 * file never says which thread made the theme and leaves the prompt out unless
 * its author keeps it. A theme that already carries credits (a starter, or
 * someone else's theme) keeps them; one without takes its author's own, which
 * this device remembers for the next export.
 */
import type { ThemeManifest } from "@threadlines/contracts";
import { themeForSharing } from "@threadlines/shared/themeSharing";
import { useState } from "react";

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
import { useThemeCreditsDraft } from "./ThemeCreditsFields";
import { ThemePromptSwitch } from "./ThemePromptSwitch";

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
  const credits = useThemeCreditsDraft(manifest, "The file keeps its credit.");
  const [includePrompt, setIncludePrompt] = useState(false);

  const save = () => {
    if (!credits.valid) return;
    credits.remember();
    exportThemeFile(themeForSharing(manifest, { name, includePrompt, credits: credits.given }));
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
          {credits.fields}
          <ThemePromptSwitch
            prompt={manifest.prompt}
            checked={includePrompt}
            onCheckedChange={setIncludePrompt}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!credits.valid} onClick={save}>
            Export
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
