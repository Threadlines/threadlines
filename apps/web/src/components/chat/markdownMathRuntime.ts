/**
 * KaTeX, loaded the first time a reply holds math (MarkdownMath.tsx imports
 * this module dynamically) so a session without formulas never pays for it.
 * copy-tex makes a selection across a formula copy its TeX, not its glyphs.
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import "katex/contrib/copy-tex";

/**
 * A formula as HTML (with MathML for screen readers). Throws on TeX KaTeX
 * can't read, so the caller shows the source instead of KaTeX's red error.
 */
export function renderTex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: true,
    output: "htmlAndMathml",
    // No \href, \url, \includegraphics or HTML extensions from agent output.
    trust: false,
    strict: "ignore",
    // Bounds on what one formula may cost to lay out.
    maxSize: 50,
    maxExpand: 500,
  });
}
