/**
 * The trial bar and the import dialog (ThemeTrialBar.tsx loads this module
 * only while a trial runs or a file waits to import).
 *
 * The bar floats at the top of the window, clear of the composer and its
 * controls. The bar and the dialog are drawn with the built-in tokens, not the
 * candidate theme's, so they stay readable whatever the candidate does. Keep
 * saves a theme that isn't in a library yet (an agent's offer, an imported
 * file) and commits it; Undo, Esc and the countdown put the old theme back.
 */
import type { ThemeBase } from "@threadlines/contracts";
import { BUILTIN_THEME_TOKENS } from "@threadlines/shared/themeBuiltinTokens";
import { THEME_TOKEN_NAMES } from "@threadlines/shared/themeTokens";
import { type CSSProperties, useEffect, useState } from "react";

import {
  endThemeTrial,
  startThemeTrial,
  type ThemeTrial,
  useActiveTheme,
} from "~/theme/themeStore";
import { describeTheme } from "~/themeLibrary/themeCatalog";
import { useThemeImportStore } from "~/themeLibrary/themeImportState";
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
import { keepThemeTrial } from "./themeTrialState";

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

/** The bar for a running trial (hidden while the /theme strip is open), and the import dialog. */
export function ThemeTrialBarContent(props: {
  readonly trial: ThemeTrial | null;
  readonly pickerOpen: boolean;
}) {
  return (
    <>
      {props.trial !== null && !props.pickerOpen ? (
        <TrialBar key={props.trial.id} trial={props.trial} />
      ) : null}
      <ThemeImportDialog />
    </>
  );
}
