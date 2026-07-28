import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Copy, and say so.
 *
 * Shared by every "Copy …" item in a transcript context menu: copying is
 * invisible, so the confirmation is the only evidence it worked, and a failure
 * that says nothing reads as the menu item being broken.
 */
export function copyTextWithToast(value: string, title: string): void {
  if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Failed to copy ${title.toLowerCase()}`,
        description: "Clipboard API unavailable.",
      }),
    );
    return;
  }

  void navigator.clipboard.writeText(value).then(
    () => {
      toastManager.add({
        type: "success",
        title: `${title} copied`,
        description: value,
      });
    },
    (error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  );
}
