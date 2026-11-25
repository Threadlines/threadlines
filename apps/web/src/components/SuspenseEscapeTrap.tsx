import { useEffect } from "react";

/**
 * Keeps Escape responsive during the brief Suspense window while a lazy
 * dialog or popover chunk loads, so pressing Escape immediately after
 * opening cancels it instead of letting it appear once the chunk arrives.
 */
export function SuspenseEscapeTrap({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return null;
}
