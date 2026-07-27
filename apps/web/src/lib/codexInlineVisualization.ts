export const CODEX_INLINE_VISUALIZATION_DIRECTIVE = "::codex-inline-vis";

const DIRECTIVE_LINE =
  /^ {0,3}::codex-inline-vis\{file="([a-z0-9]+(?:-[a-z0-9]+)*\.html)"\}[ \t]*$/;
const FENCE_START = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export type CodexInlineVisualizationSegment =
  | { readonly type: "markdown"; readonly key: string; readonly text: string }
  | { readonly type: "visualization"; readonly key: string; readonly file: string };

interface OpenFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

function nextFenceState(line: string, current: OpenFence | null): OpenFence | null {
  const match = FENCE_START.exec(line);
  if (!match?.[1]) {
    return current;
  }

  const fence = match[1];
  const marker = fence[0] as "`" | "~";
  if (current === null) {
    return { marker, length: fence.length };
  }

  const remainder = match[2] ?? "";
  if (marker === current.marker && fence.length >= current.length && remainder.trim() === "") {
    return null;
  }
  return current;
}

/**
 * Splits only standalone visualization directives outside fenced code. During
 * streaming, an unfinished directive on the final line is hidden until Codex
 * has emitted its closing syntax.
 */
export function parseCodexInlineVisualizations(
  text: string,
  options: { readonly isStreaming?: boolean } = {},
): ReadonlyArray<CodexInlineVisualizationSegment> {
  const lines = text.split("\n");
  const segments: CodexInlineVisualizationSegment[] = [];
  let markdownLines: string[] = [];
  let markdownStart = 0;
  let offset = 0;
  let openFence: OpenFence | null = null;

  const flushMarkdown = () => {
    if (markdownLines.length === 0) {
      return;
    }
    const markdown = markdownLines.join("\n");
    if (markdown.length > 0) {
      segments.push({ type: "markdown", key: `markdown:${markdownStart}`, text: markdown });
    }
    markdownLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLastLine = index === lines.length - 1;
    const directive = openFence === null ? DIRECTIVE_LINE.exec(line) : null;

    if (directive?.[1]) {
      flushMarkdown();
      segments.push({
        type: "visualization",
        key: `visualization:${offset}`,
        file: directive[1],
      });
      markdownStart = offset + line.length + 1;
    } else {
      const isPartialStreamingDirective =
        options.isStreaming === true &&
        isLastLine &&
        openFence === null &&
        line.trimStart().startsWith(CODEX_INLINE_VISUALIZATION_DIRECTIVE);
      if (!isPartialStreamingDirective) {
        if (markdownLines.length === 0) {
          markdownStart = offset;
        }
        markdownLines.push(line);
        openFence = nextFenceState(line, openFence);
      }
    }

    offset += line.length + (isLastLine ? 0 : 1);
  }

  flushMarkdown();
  return segments;
}

export function stripCodexInlineVisualizationDirectives(text: string): string {
  const segments = parseCodexInlineVisualizations(text);
  if (!segments.some((segment) => segment.type === "visualization")) {
    return text;
  }
  return segments
    .filter(
      (segment): segment is Extract<CodexInlineVisualizationSegment, { type: "markdown" }> =>
        segment.type === "markdown",
    )
    .map((segment) => segment.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
