/**
 * Selected-line context for the chat composer.
 *
 * When a user selects lines in the internal file viewer and sends them to
 * chat, the selection is serialized into the composer prompt as a fenced
 * block headed by the `path:Lx-Ly` reference, so the provider (and the user
 * re-reading the draft) can identify exactly which file span is quoted.
 */

const FENCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  js: "js",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mjs: "js",
  cjs: "js",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "ts",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

export function inferFenceLanguage(relativePath: string): string {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  const extension = basename.includes(".") ? (basename.split(".").at(-1) ?? "") : "";
  return FENCE_LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? "";
}

export interface FileSelectionContext {
  relativePath: string;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  selectedText: string;
  /**
   * Whole-file reference: serialized as an `@path` mention (the agent reads
   * the file itself) instead of quoting contents, so it costs no context.
   */
  wholeFile?: boolean;
}

/** A file selection attached to a composer draft as a context chip. */
export interface FileSelectionContextDraft extends FileSelectionContext {
  id: string;
  threadId: string;
  createdAt: string;
}

export function normalizeFileSelectionContextDraft(
  threadId: string,
  context: FileSelectionContextDraft,
): FileSelectionContextDraft | null {
  const relativePath = context.relativePath.trim();
  const selectedText = context.selectedText.replace(/\n+$/, "");
  const startLine = Math.max(1, Math.min(context.startLine, context.endLine));
  const endLine = Math.max(context.startLine, context.endLine);
  if (
    relativePath.length === 0 ||
    (!context.wholeFile && selectedText.trim().length === 0) ||
    context.id.trim().length === 0 ||
    context.createdAt.trim().length === 0
  ) {
    return null;
  }
  return {
    id: context.id.trim(),
    threadId,
    createdAt: context.createdAt.trim(),
    relativePath,
    startLine,
    endLine,
    selectedText,
    ...(context.wholeFile ? { wholeFile: true } : {}),
  };
}

export function fileSelectionContextDedupKey(context: FileSelectionContext): string {
  return context.wholeFile
    ? `${context.relativePath}:file`
    : `${context.relativePath}:${context.startLine}-${context.endLine}`;
}

export function formatFileSelectionContextLabel(context: FileSelectionContext): string {
  const basename = context.relativePath.split("/").at(-1) ?? context.relativePath;
  return context.wholeFile ? basename : `${basename} ${formatFileSelectionLineRange(context)}`;
}

/**
 * Serialize attached file selections into the outgoing prompt, mirroring how
 * transcript highlights are appended at send time.
 */
export function appendFileSelectionContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<FileSelectionContext>,
): string {
  let next = prompt;
  for (const context of contexts) {
    next = appendBlockToPrompt(
      next,
      context.wholeFile ? `@${context.relativePath}` : formatFileSelectionContextBlock(context),
    );
  }
  return next;
}

export function formatFileSelectionLineRange(context: {
  startLine: number;
  endLine: number;
}): string {
  return context.startLine === context.endLine
    ? `L${context.startLine}`
    : `L${context.startLine}-L${context.endLine}`;
}

export function formatFileSelectionContextBlock(context: FileSelectionContext): string {
  const fenceLanguage = inferFenceLanguage(context.relativePath);
  const rangeLabel = formatFileSelectionLineRange(context);
  // Widen the fence when the selection itself contains backtick fences.
  const fence = context.selectedText.includes("```") ? "````" : "```";
  return [
    `\`${context.relativePath}:${rangeLabel.replaceAll("L", "")}\``,
    `${fence}${fenceLanguage}`,
    context.selectedText.replace(/\n+$/, ""),
    fence,
  ].join("\n");
}

/**
 * Append a standalone block to an existing composer prompt, preserving any
 * text the user already typed.
 */
export function appendBlockToPrompt(prompt: string, block: string): string {
  const trimmedPrompt = prompt.replace(/\s+$/, "");
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}\n` : `${block}\n`;
}

/**
 * Append a file selection block to an existing composer prompt, preserving
 * any text the user already typed.
 */
export function appendFileSelectionToPrompt(prompt: string, context: FileSelectionContext): string {
  return appendBlockToPrompt(prompt, formatFileSelectionContextBlock(context));
}

/**
 * Extract the selected line span (inclusive, 1-based) from file text.
 */
export function sliceFileSelection(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n");
  const start = Math.max(1, Math.min(startLine, endLine));
  const end = Math.min(lines.length, Math.max(startLine, endLine));
  return lines.slice(start - 1, end).join("\n");
}
