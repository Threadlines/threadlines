/**
 * The theme layer every window carries (docs/design/custom-themes.md,
 * "Trying"): the "Keep Aurora?" bar that every trial shows, the import
 * dialog, and dropping a theme file anywhere on the window. The bar and the
 * dialog are a chunk of their own (ThemeTrialBarContent.tsx), fetched the
 * first time a trial starts or a file waits to import; the drop handling
 * (themeFileDrop.ts) loads once the window is idle.
 */
import { Suspense, useEffect } from "react";

import { lazyWithPreload } from "~/lib/lazyWithPreload";
import { useThemeTrial } from "~/theme/themeStore";
import { useThemeImportStore } from "~/themeLibrary/themeImportState";
import { useThemePickerOpenStore } from "./themePickerOpen";

const Content = lazyWithPreload(() =>
  import("./ThemeTrialBarContent").then((module) => module.ThemeTrialBarContent),
);

/** Installs the window's theme-file drop handling once the window is idle (themeFileDrop.ts). */
function useThemeFileDrop() {
  useEffect(() => {
    let uninstall: (() => void) | null = null;
    let stopped = false;
    const install = () => {
      void import("./themeFileDrop").then(
        (module) => {
          if (!stopped) uninstall = module.installThemeFileDrop();
        },
        () => {},
      );
    };
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(install, { timeout: 2_000 })
        : null;
    const timer = idle === null ? window.setTimeout(install, 350) : null;
    return () => {
      stopped = true;
      if (idle !== null) window.cancelIdleCallback(idle);
      if (timer !== null) window.clearTimeout(timer);
      uninstall?.();
    };
  }, []);
}

export function ThemeTrialBar() {
  const trial = useThemeTrial();
  const pickerOpen = useThemePickerOpenStore((state) => state.open);
  const importing = useThemeImportStore((state) => state.pending !== null);
  useThemeFileDrop();
  if (trial === null && !importing) return null;
  return (
    <Suspense fallback={null}>
      <Content.Component trial={trial} pickerOpen={pickerOpen} />
    </Suspense>
  );
}
