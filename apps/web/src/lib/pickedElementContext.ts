import type { DesktopPreviewPickedElement } from "@threadlines/contracts";

/**
 * Turns a picked element into something an agent can act on later.
 *
 * Deliberately a description rather than a handle. The node id that identified
 * the element while picking dies with the document, and by the time the agent
 * reads the message the page may have reloaded -- but a role, an accessible
 * name and a selector still find it, and they are how the agent identifies
 * elements everywhere else in this feature.
 *
 * The text is meant to be read by a person too: it lands in the composer where
 * the user can edit or delete it before sending.
 */
export function describePickedElementForComposer(element: DesktopPreviewPickedElement): string {
  const parts: string[] = [];

  // Role and name first: that is how you would ask someone else to find it.
  if (element.role !== null && element.name !== null) {
    parts.push(`${element.role} "${element.name}"`);
  } else if (element.name !== null) {
    parts.push(`"${element.name}"`);
  } else {
    parts.push(`<${element.tagName}>`);
  }

  if (element.selector !== "") {
    parts.push(`selector: ${element.selector}`);
  }

  // Only when it says something the name did not.
  if (element.text !== null && element.text !== element.name) {
    const trimmed = element.text.length > 80 ? `${element.text.slice(0, 80)}…` : element.text;
    parts.push(`text: "${trimmed}"`);
  }

  parts.push(`${element.rect.width}×${element.rect.height} at ${element.url}`);

  return `[selected element] ${parts.join(" · ")}`;
}
