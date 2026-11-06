/**
 * The theme layer every window carries (docs/design/custom-themes.md,
 * "Trying"): the "Keep Aurora?" bar that every trial shows, the import
 * dialog, and dropping a theme file anywhere on the window.
 *
 * The bar floats at the top of the window, clear of the composer and its
 * controls. The bar and the dialog are drawn with the built-in tokens, not the
 * candidate theme's, so they stay readable whatever the candidate does. Keep
 * saves a theme that isn't in a library yet (an agent's offer, an imported
 * file) and commits it; Undo, Esc and the countdown put the old theme back.
 */
import type { ThemeBase } from "@threadlines/contracts";
import { BUILTIN_THEME_TOKENS, THEME_TOKEN_NAMES } from "@threadlines/shared/themeTokens";
import { type CSSProperties, useEffect, useState } from "react";
import { create } from "zustand";

import {
  commitThemeTrial,
  endThemeTrial,
  startThemeTrial,
  type ThemeTrial,
  useActiveTheme,
  useThemeTrial,
} from "~/theme/themeStore";
import { describeTheme } from "~/themeLibrary/themeCatalog";
import { importThemeFile, isThemeFileName, useThemeImportStore } from "~/themeLibrary/themeFiles";
import { currentLibraryThemes, saveThemeToLibrary } from "~/themeLibrary/themeLibraryState";
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
import { toastManager } from "../../ui/toast";

/** The built-in UI font, as index.css declares it. */
const BUILTIN_FONT_SANS =
  '"Schibsted Grotesk Variable", "Schibsted Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** CSS variables that put the built-in theme back inside an element. */
export function builtinThemeStyle(base: ThemeBase): CSSProperties {
  const tokens = BUILTIN_THEME_TOKENS[base];
  const style: Record<string, string> = {
    colorScheme: base,
    fontFamily: BUILTIN_FONT_SANS,
    "--font-sans": BUILTIN_FONT_SANS,
  };
  for (const name of THEME_TOKEN_NAMES) style[`--${name}`] = tokens[name];
  return style as CSSProperties;
}

/** Whether the /theme strip is open: it handles its own keys and hides the bar. */
export const useThemePickerOpenStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Seconds until a trial ends by itself, updated four times a second while it runs. */
function useSecondsLeft(trial: ThemeTrial | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (trial === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [trial]);
  return trial === null ? 0 : Math.max(0, Math.ceil((trial.expiresAt - now) / 1000));
}

/** Keeps a trial: saves a theme that isn't in a library yet, then commits it. */
export async function keepThemeTrial(trial: ThemeTrial): Promise<void> {
  if (trial.choice.kind !== "unsaved" || trial.manifest === null) {
    commitThemeTrial(trial.id);
    return;
  }
  // Already in the library (an agent offered a theme you have): keep that entry.
  const { hash } = trial.choice;
  const existing = currentLibraryThemes().find((theme) => theme.entry.hash === hash);
  if (existing) {
    commitThemeTrial(trial.id, {
      kind: "library",
      entryId: existing.entry.entryId,
      hash,
      name: existing.entry.name,
      environmentId: existing.holders[0] ?? null,
    });
    return;
  }
  try {
    const saved = await saveThemeToLibrary(trial.manifest, trial.name);
    commitThemeTrial(trial.id, {
      kind: "library",
      entryId: saved.entry.entryId,
      hash: saved.entry.hash,
      name: saved.entry.name,
      environmentId: saved.environmentId,
    });
  } catch (error) {
    // Kept on this device either way; the library copy can be saved later.
    commitThemeTrial(trial.id);
    toastManager.add({
      type: "warning",
      title: `Kept ${trial.name} on this device only`,
      description: `It couldn't be saved to your library: ${
        error instanceof Error ? error.message : "try again from Settings"
      }`,
    });
  }
}

function TrialBar({ trial }: { readonly trial: ThemeTrial }) {
  const active = useActiveTheme();
  const secondsLeft = useSecondsLeft(trial);
  const [keeping, setKeeping] = useState(false);
  return (
    <div
      role="alertdialog"
      aria-label={`Keep ${trial.name}?`}
      data-theme-trial-bar
      style={builtinThemeStyle(active.base)}
      className="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+var(--app-titlebar-height,38px)+12px)] z-[60] mx-auto flex w-[min(460px,calc(100vw-24px))] items-center gap-3 rounded-[var(--app-radius-large)] border border-border bg-popover px-4 py-2.5 text-popover-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          endThemeTrial(trial.id);
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] leading-5 font-medium">Keep {trial.name}?</div>
        <div className="text-[12px] leading-4 text-muted-foreground" aria-live="polite">
          Switches back in {secondsLeft}s
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={() => endThemeTrial(trial.id)}>
        Undo
      </Button>
      <Button
        size="sm"
        autoFocus
        disabled={keeping}
        onClick={() => {
          setKeeping(true);
          void keepThemeTrial(trial).finally(() => setKeeping(false));
        }}
      >
        Keep
      </Button>
    </div>
  );
}

function ThemeImportDialog() {
  const pending = useThemeImportStore((state) => state.pending);
  const clear = () => useThemeImportStore.getState().set(null);
  const active = useActiveTheme();
  if (pending === null) return null;
  const manifest = pending.ok ? pending.manifest : null;
  const still = manifest?.backdrop?.still ?? null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : clear())}>
      <DialogPopup className="max-w-md" style={builtinThemeStyle(active.base)}>
        <DialogHeader>
          <DialogTitle>{manifest ? manifest.name : "This theme can't be used"}</DialogTitle>
          <DialogDescription>
            {manifest
              ? describeTheme({ base: manifest.base, hasArt: manifest.backdrop !== undefined })
              : pending.fileName}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {still ? (
            <img
              src={still}
              alt=""
              className="aspect-[16/10] w-full rounded-[var(--app-radius-surface)] object-cover ring-1 ring-border"
            />
          ) : null}
          {manifest?.backdrop ? (
            <p className="text-[13px] text-muted-foreground">
              Live art made by someone else. It runs walled off, with no internet, and stops when
              you're not using Threadlines.
            </p>
          ) : null}
          {!pending.ok ? (
            <ul className="list-disc space-y-1 ps-5 text-[13px] text-muted-foreground">
              {pending.errors.slice(0, 6).map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={clear}>
            {pending.ok ? "Cancel" : "Close"}
          </Button>
          {pending.ok ? (
            <Button
              onClick={() => {
                startThemeTrial({
                  choice: { kind: "unsaved", hash: pending.hash, name: pending.manifest.name },
                  manifest: pending.manifest,
                });
                clear();
              }}
            >
              Try it
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A theme file dropped anywhere on the window opens the import dialog. Other
 * files keep going to whatever takes them (the composer's attachments);
 * dropped where nothing takes them, nothing happens.
 */
function useThemeFileDrop() {
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDropCapture = (event: DragEvent) => {
      const file = [...(event.dataTransfer?.files ?? [])].find((item) =>
        isThemeFileName(item.name),
      );
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      void importThemeFile(file);
    };
    const onDrop = (event: DragEvent) => {
      if (!event.defaultPrevented && event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDropCapture, true);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDropCapture, true);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}

export function ThemeTrialBar() {
  const trial = useThemeTrial();
  const pickerOpen = useThemePickerOpenStore((state) => state.open);
  useThemeFileDrop();
  return (
    <>
      {trial !== null && !pickerOpen ? <TrialBar key={trial.id} trial={trial} /> : null}
      <ThemeImportDialog />
    </>
  );
}
