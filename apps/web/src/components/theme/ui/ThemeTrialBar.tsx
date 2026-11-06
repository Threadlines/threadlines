/**
 * The theme layer every window carries (docs/design/custom-themes.md,
 * "Trying"): the "Keep Aurora?" bar that every trial shows, the import
 * dialog, and dropping a theme file anywhere on the window. The bar and the
 * dialog are a chunk of their own (ThemeTrialBarContent.tsx), fetched the
 * first time a trial starts or a file waits to import.
 */
import { Suspense, useEffect } from "react";

import { lazyWithPreload } from "~/lib/lazyWithPreload";
import { useThemeTrial } from "~/theme/themeStore";
import { isThemeFileName, useThemeImportStore } from "~/themeLibrary/themeImportState";
import { useThemePickerOpenStore } from "./themePickerOpen";

const Content = lazyWithPreload(() =>
  import("./ThemeTrialBarContent").then((module) => module.ThemeTrialBarContent),
);

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
      // Reading and checking the file loads only when one arrives.
      void import("~/themeLibrary/themeFiles").then((files) => files.importThemeFile(file));
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
  const importing = useThemeImportStore((state) => state.pending !== null);
  useThemeFileDrop();
  if (trial === null && !importing) return null;
  return (
    <Suspense fallback={null}>
      <Content.Component trial={trial} pickerOpen={pickerOpen} />
    </Suspense>
  );
}
