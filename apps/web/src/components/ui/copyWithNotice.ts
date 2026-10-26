import { copyTextToClipboard } from "~/lib/clipboard";

import { toastManager } from "./toast";
import { failureNotice } from "./toastHelpers";

/** Long enough to see, short enough that copies don't pile up. */
const COPIED_NOTICE_VISIBLE_MS = 2_000;

/**
 * Copies `value` and confirms it in a one-line notice ("Copied path"). For
 * menu items and other controls that are gone by the time the copy lands; a
 * copy button that stays on screen shows a check on itself instead
 * (`useCopyToClipboard`). `what` names the thing in lowercase: "path",
 * "thread ID", "link address". Resolves whether the copy worked.
 */
export function copyWithNotice(value: string, what: string): Promise<boolean> {
  return copyTextToClipboard(value).then(
    () => {
      toastManager.add({
        type: "success",
        title: `Copied ${what}`,
        data: { dismissAfterVisibleMs: COPIED_NOTICE_VISIBLE_MS },
      });
      return true;
    },
    (error: unknown) => {
      toastManager.add(failureNotice({ title: `Couldn't copy ${what}`, error }));
      return false;
    },
  );
}
