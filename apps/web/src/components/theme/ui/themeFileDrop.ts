/**
 * A theme file dropped anywhere on the window opens the import dialog. Other
 * files keep going to whatever takes them (the composer's attachments);
 * dropped where nothing takes them, nothing happens. ThemeTrialBar.tsx
 * installs it once the window is idle, so startup doesn't carry it.
 */
import { isThemeFileName } from "~/themeLibrary/themeImportState";

/** Listens for theme files dropped on the window; returns the way to stop. */
export function installThemeFileDrop(): () => void {
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDropCapture = (event: DragEvent) => {
    const file = [...(event.dataTransfer?.files ?? [])].find((item) => isThemeFileName(item.name));
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
}
