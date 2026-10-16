import { formatInlineTerminalContextLabel as formatInlineTerminalContextSelectionLabel } from "~/lib/terminalContext";

const TERMINAL_CONTEXT_HEADER_PATTERN = /^(.*?)\s+line(?:s)?\s+(\d+)(?:-(\d+))?$/i;

export function buildInlineTerminalContextText(
  contexts: ReadonlyArray<{
    header: string;
  }>,
): string {
  return contexts
    .map((context) => context.header.trim())
    .filter((header) => header.length > 0)
    .map(formatInlineTerminalContextLabel)
    .join(" ");
}

export function formatInlineTerminalContextLabel(header: string): string {
  const trimmedHeader = header.trim();
  const match = TERMINAL_CONTEXT_HEADER_PATTERN.exec(trimmedHeader);
  if (!match) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  const lineStart = Number.parseInt(match[2] ?? "", 10);
  const lineEnd = Number.parseInt(match[3] ?? match[2] ?? "", 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  return formatInlineTerminalContextSelectionLabel({
    terminalLabel: match[1]?.trim() || "terminal",
    lineStart,
    lineEnd,
  });
}

export function textContainsInlineTerminalContextLabels(
  text: string,
  contexts: ReadonlyArray<{
    header: string;
  }>,
): boolean {
  let searchStartIndex = 0;

  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const matchIndex = text.indexOf(label, searchStartIndex);
    if (matchIndex === -1) {
      return false;
    }
    searchStartIndex = matchIndex + label.length;
  }

  return true;
}

/** One run of a sent message as it is drawn: words, or a terminal context's chip. */
export type UserMessagePiece<Context> =
  | { readonly kind: "text"; readonly text: string; readonly start: number }
  | { readonly kind: "terminal-context"; readonly context: Context };

/**
 * A sent message in the order it is drawn. When the text still carries every
 * context's inline label, in order, each label is where its chip goes;
 * otherwise the chips lead and the text follows. UserMessageBody draws these;
 * find in chat reads the text runs.
 */
export function splitUserMessageText<Context extends { readonly header: string }>(
  text: string,
  contexts: ReadonlyArray<Context>,
): { readonly embedded: boolean; readonly pieces: UserMessagePiece<Context>[] } {
  if (contexts.length > 0 && textContainsInlineTerminalContextLabels(text, contexts)) {
    const pieces: UserMessagePiece<Context>[] = [];
    let cursor = 0;
    for (const context of contexts) {
      const label = formatInlineTerminalContextLabel(context.header);
      const matchIndex = text.indexOf(label, cursor);
      if (matchIndex > cursor) {
        pieces.push({ kind: "text", text: text.slice(cursor, matchIndex), start: cursor });
      }
      pieces.push({ kind: "terminal-context", context });
      cursor = matchIndex + label.length;
    }
    if (cursor < text.length) {
      pieces.push({ kind: "text", text: text.slice(cursor), start: cursor });
    }
    return { embedded: true, pieces };
  }
  const pieces: UserMessagePiece<Context>[] = contexts.map((context) => ({
    kind: "terminal-context",
    context,
  }));
  if (text.length > 0) {
    pieces.push({ kind: "text", text, start: 0 });
  }
  return { embedded: false, pieces };
}
