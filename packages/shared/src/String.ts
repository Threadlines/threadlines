export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

const SUBAGENT_RESULT_PATTERN =
  /^The subagent was named\s+`([^`]+)`\.\s+ID:\s+`[^`]+`\s+Output:\s+```(?:[\w-]+)?\s*([\s\S]*?)\s*```\s*$/iu;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownCodeFences(value: string): string {
  return value.replace(/```(?:[\w-]+)?\s*([\s\S]*?)\s*```/gu, (_match, body: string) =>
    body.trim(),
  );
}

export function formatForkSourceExcerpt(text: string, maxLength: number): string {
  const trimmed = text.trim();
  const subagentResult = SUBAGENT_RESULT_PATTERN.exec(trimmed);
  if (subagentResult) {
    const nickname = subagentResult[1] ?? "subagent";
    const output = collapseWhitespace(stripMarkdownCodeFences(subagentResult[2] ?? ""));
    const summary =
      output.length > 0
        ? `Subagent ${nickname} completed with output: ${output}`
        : `Subagent ${nickname} completed.`;
    return truncate(summary, maxLength);
  }

  return truncate(collapseWhitespace(stripMarkdownCodeFences(trimmed)), maxLength);
}
