/**
 * The app root's theme runtime: the live art while the active theme has it,
 * and the desktop's theme events. The art's code (the walled-off frame, its
 * runtime, the zones) is a chunk of its own, fetched only once a theme with
 * art is on; until it reports, glass surfaces stay opaque, so nothing shows
 * through early.
 */
import { Suspense, useEffect } from "react";

import { lazyWithPreload } from "../lib/lazyWithPreload";
import { applyGlassTints } from "./themeApply";
import {
  chooseTheme,
  reportBackdropTooHeavy,
  useActiveTheme,
  useBackdropGeneration,
} from "./themeStore";

const BackdropLayer = lazyWithPreload(() =>
  import("./ThemeBackdropLayer").then((module) => module.ThemeBackdropLayer),
);

/** Mounted in the app shell's root: the backdrop while the active theme has art. */
export function ThemeRuntime() {
  const active = useActiveTheme();
  const generation = useBackdropGeneration();
  const manifest = active.manifest;
  const hasArt = manifest?.backdrop !== undefined && manifest.glass !== undefined;

  useEffect(() => {
    if (!hasArt) applyGlassTints(null);
  }, [hasArt]);

  if (!hasArt || !manifest || !active.tokens || !active.hash) return null;
  return (
    <Suspense fallback={null}>
      <BackdropLayer.Component
        key={`${active.hash}:${generation}`}
        manifest={manifest}
        tokens={active.tokens}
        base={active.base}
        hash={active.hash}
      />
    </Suspense>
  );
}

/**
 * The desktop's theme events, for the app root on every page (sign-in and
 * setup included): View › Reset Theme, and the CPU watchdog's verdict.
 */
export function useDesktopThemeEvents(): void {
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Not a menu action: those wait for the shell to listen, and the escape
    // hatch must reach a page whose shell never got that far.
    const stopReset = bridge.onThemeReset?.(() => chooseTheme({ kind: "builtin", id: "system" }));
    const stopWatchdog = bridge.onBackdropTooHeavy?.(() => reportBackdropTooHeavy());
    return () => {
      stopReset?.();
      stopWatchdog?.();
    };
  }, []);
}
