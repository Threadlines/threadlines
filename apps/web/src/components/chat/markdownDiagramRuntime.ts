/**
 * The Mermaid renderer, loaded the first time a reply holds a diagram
 * (MarkdownDiagram.tsx imports this module dynamically). pele draws Mermaid
 * syntax to SVG, fetching one small chunk per diagram type; its colors come
 * from `--pele-*` variables (index.css), so a theme change needs no redraw.
 */
import DOMPurify from "dompurify";
import { renderAsync } from "pele/lazy";

export interface DrawnDiagram {
  readonly svg: string;
  /** Its natural size, for the full-size view. */
  readonly width: number;
  readonly height: number;
}

/**
 * Draws `source`, or throws with pele's reason when it isn't a diagram pele can
 * read. Links and images stay off (a diagram from an agent opens nothing), and
 * the SVG goes through DOMPurify even though pele escapes what it writes.
 */
export async function renderDiagram(
  source: string,
  options: { readonly idPrefix: string; readonly fontFamily: string | undefined },
): Promise<DrawnDiagram> {
  const result = await renderAsync(source, {
    idPrefix: options.idPrefix,
    ...(options.fontFamily ? { fontFamily: options.fontFamily } : {}),
    // Keep the direction the diagram was written in; it scales to the column.
    autoDirection: false,
    links: false,
    images: false,
  });
  const svg = DOMPurify.sanitize(result.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  return { svg, width: result.width, height: result.height };
}
