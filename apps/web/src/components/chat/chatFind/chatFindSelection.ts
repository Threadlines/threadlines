/** Text the reader selected in the chat list, to search for. */
export function selectedChatText(container: Element | null): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) return null;
  const anchor = selection.getRangeAt(0).commonAncestorContainer;
  return container.contains(anchor) ? selection.toString() : null;
}
