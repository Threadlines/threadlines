/**
 * Helpers for the documents the app shows in sandboxed srcdoc frames (agent
 * pages, MCP app cards): putting the host's wrapper (content policy, theme,
 * bootstrap script) ahead of everything the framed content says.
 */

/**
 * A value as a script literal that nothing in it can end early: `<`, `>` and
 * `/` (a closing script tag) and the two line separators JSON leaves bare are
 * written as escapes, which read back as the same characters.
 */
export const scriptLiteral = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * Where a document's leading doctype ends, when the document opens with one
 * (after a byte order mark or white space); null otherwise. Only that exact
 * opening counts: anything else before a doctype (a comment, say) could hide
 * markup from a scan that the browser's parser would run, so such a document
 * gets the wrapper's own doctype first instead, and the parser ignores the
 * later one. The doctype ends at its first `>`, as the parser ends it.
 */
function leadingDoctypeEnd(content: string): number | null {
  let index = content.startsWith("\uFEFF") ? 1 : 0;
  // The parser's own white space: tab, line feed, form feed, return, space.
  while (index < content.length && /[\t\n\f\r ]/u.test(content[index]!)) index += 1;
  if (content.slice(index, index + 9).toLowerCase() !== "<!doctype") return null;
  const end = content.indexOf(">", index + 9);
  return end === -1 ? null : end + 1;
}

/**
 * `wrapper` put first in an HTML document, after its doctype if it has one.
 * Nothing the document says can come before it, so no script of the
 * document's runs outside the wrapper's content policy. The document's own
 * `<html>` and `<head>` tags after it are merged by the parser as usual; a
 * second content policy of its own can only narrow the wrapper's.
 */
export function wrapHtmlDocument(content: string, wrapper: string): string {
  const doctypeEnd = leadingDoctypeEnd(content);
  return doctypeEnd !== null
    ? `${content.slice(0, doctypeEnd)}${wrapper}${content.slice(doctypeEnd)}`
    : `<!doctype html>${wrapper}${content}`;
}
