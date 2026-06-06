const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/u;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
