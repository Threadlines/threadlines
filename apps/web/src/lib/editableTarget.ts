/**
 * Whether an event target or element already takes typing: inside an input,
 * a textarea, a select or an editable surface. Whatever would grab the
 * keyboard on its own (type-to-edit, a terminal appearing) leaves it be.
 */
export function isEditableEventTarget(target: EventTarget | null | undefined): boolean {
  const element = target as Partial<Element> | null | undefined;
  if (!element || typeof element.closest !== "function") {
    return false;
  }
  return element.closest("input, textarea, select, [contenteditable]") !== null;
}
