export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownCodeFences(value: string): string {
  let cursor = 0;
  const result: string[] = [];
  while (cursor < value.length) {
    const opening = value.indexOf("```", cursor);
    if (opening === -1) {
      result.push(value.slice(cursor));
      break;
    }
    const closing = value.indexOf("```", opening + 3);
    if (closing === -1) {
      result.push(value.slice(cursor));
      break;
    }

    let bodyStart = opening + 3;
    let languageEnd = bodyStart;
    while (languageEnd < closing && /[\w-]/u.test(value[languageEnd] ?? "")) {
      languageEnd += 1;
    }
    if (languageEnd > bodyStart && /\s/u.test(value[languageEnd] ?? "")) {
      bodyStart = languageEnd;
    }
    while (bodyStart < closing && /\s/u.test(value[bodyStart] ?? "")) {
      bodyStart += 1;
    }

    result.push(value.slice(cursor, opening));
    result.push(value.slice(bodyStart, closing).trim());
    cursor = closing + 3;
  }
  return result.join("");
}

function parseSubagentResult(value: string): { nickname: string; output: string } | null {
  const prefix = "The subagent was named `";
  if (!value.startsWith(prefix)) return null;

  const nicknameEnd = value.indexOf("`.", prefix.length);
  if (nicknameEnd === -1) return null;
  const nickname = value.slice(prefix.length, nicknameEnd);
  if (nickname.length === 0) return null;

  let remainder = value.slice(nicknameEnd + 2).trimStart();
  const idPrefix = "ID: `";
  if (!remainder.startsWith(idPrefix)) return null;
  const idEnd = remainder.indexOf("`", idPrefix.length);
  if (idEnd === -1 || idEnd === idPrefix.length) return null;

  remainder = remainder.slice(idEnd + 1).trimStart();
  const outputPrefix = "Output:";
  if (!remainder.startsWith(outputPrefix)) return null;
  const fencedOutput = remainder.slice(outputPrefix.length).trim();
  if (!fencedOutput.startsWith("```") || !fencedOutput.endsWith("```")) return null;

  return { nickname, output: stripMarkdownCodeFences(fencedOutput) };
}

export function formatForkSourceExcerpt(text: string, maxLength: number): string {
  const trimmed = text.trim();
  const subagentResult = parseSubagentResult(trimmed);
  if (subagentResult) {
    const { nickname } = subagentResult;
    const output = collapseWhitespace(subagentResult.output);
    const summary =
      output.length > 0
        ? `Subagent ${nickname} completed with output: ${output}`
        : `Subagent ${nickname} completed.`;
    return truncate(summary, maxLength);
  }

  return truncate(collapseWhitespace(stripMarkdownCodeFences(trimmed)), maxLength);
}
