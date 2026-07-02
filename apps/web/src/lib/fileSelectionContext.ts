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
 * Append a file selection block to an existing composer prompt, preserving
 * any text the user already typed.
 */
export function appendFileSelectionToPrompt(prompt: string, context: FileSelectionContext): string {
  const block = formatFileSelectionContextBlock(context);
  const trimmedPrompt = prompt.replace(/\s+$/, "");
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}\n` : `${block}\n`;
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
