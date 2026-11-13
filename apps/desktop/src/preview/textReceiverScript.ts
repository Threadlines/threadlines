/**
 * What in the page would take text an agent types now, asked in the frame
 * that holds the keyboard.
 *
 * Typing clicks its target first and then sends text to whatever the page has
 * focused. When the click lands on something that takes no text (a button, a
 * label, a layer over the field), inserted text goes nowhere, and a "select
 * all" sent to clear the field selects the whole page instead: the user sees
 * every word on the page highlighted and the agent hears that it typed. So the
 * receiver is found first, and clearing happens here, in the same step that
 * checks it, and only inside it.
 *
 * - `field`: a text input, a textarea, rich text (contenteditable), or
 *   anything else the page's own editor says takes text where its cursor is,
 *   which covers a field inside a component whose insides cannot be read (a
 *   closed shadow root).
 * - `editContext`: an editor that draws its own text (EditContext, as newer
 *   code editors do). It takes inserted text and selects on its own shortcut,
 *   so it is not cleared here.
 * - `none`: nothing that takes text. Date and time pickers are here too: they
 *   look like inputs and ignore inserted text.
 *
 * Judged by the focused element, and by a cursor that is in or on it: a
 * cursor left behind in a field the user typed in earlier would otherwise
 * pass for focus. Known gap: an EditContext editor inside a closed shadow
 * root reads as `none`. The script runs among the page's own scripts, so a
 * page that lies to it only misleads typing on itself.
 */
export type TextReceiver = "field" | "editContext" | "none";

/** Input types that take typed text. The rest are pickers, toggles and buttons. */
const TEXT_INPUT_TYPES = ["text", "search", "url", "tel", "email", "password", "number"];

export function isTextReceiver(value: unknown): value is TextReceiver {
  return value === "field" || value === "editContext" || value === "none";
}

/**
 * The script that names the receiver. With `clearBefore` (a time in epoch
 * milliseconds) it also selects a `field`'s contents, so the text typed next
 * replaces them, unless it only gets to run after that time: a page too busy
 * to answer must not change its selection once the caller has given up.
 */
export function buildTextReceiverScript(options?: { readonly clearBefore: number }): string {
  return `
(() => {
  const CLEAR_BEFORE = ${JSON.stringify(options?.clearBefore ?? null)};
  const TEXT_INPUT_TYPES = ${JSON.stringify(TEXT_INPUT_TYPES)};
  const clears = CLEAR_BEFORE !== null;
  if (clears && Date.now() > CLEAR_BEFORE) {
    return "none";
  }

  let focused = document.activeElement;
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) {
    focused = focused.shadowRoot.activeElement;
  }
  if (!focused) {
    return "none";
  }
  if (focused.editContext) {
    return "editContext";
  }

  const tag = focused.localName;
  if (tag === "input" || tag === "textarea") {
    if (focused.disabled || focused.readOnly) {
      return "none";
    }
    if (tag === "input" && !TEXT_INPUT_TYPES.includes(focused.type)) {
      return "none";
    }
    if (clears) {
      focused.select();
    }
    return "field";
  }

  const selection = getSelection();
  const anchor = selection ? selection.anchorNode : null;
  const cursorInside = anchor !== null && (anchor === focused || focused.contains(anchor));
  if (!cursorInside) {
    if (focused.isContentEditable) {
      // Focused by script with the cursor left elsewhere: bring it in, or
      // "select all" below would act on wherever it was.
      if (clears) {
        selection.selectAllChildren(focused);
        selection.collapseToEnd();
      }
    } else {
      // A field that cannot be read shows its cursor from outside as pointing
      // at the element that holds it.
      const pointedAt =
        anchor !== null && anchor.nodeType === Node.ELEMENT_NODE
          ? anchor.childNodes[selection.anchorOffset]
          : null;
      const cursorOnIt = pointedAt != null && (pointedAt === focused || pointedAt.contains(focused));
      if (!cursorOnIt) {
        return "none";
      }
    }
  }
  if (!focused.isContentEditable && !document.queryCommandEnabled("insertText")) {
    return "none";
  }
  if (clears) {
    // The browser's own "select all": with the cursor in a field it takes
    // that field's contents, and editors that watch for it hear about it.
    document.execCommand("selectAll");
  }
  return "field";
})()
`;
}
