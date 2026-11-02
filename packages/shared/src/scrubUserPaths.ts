/**
 * Replaces every occurrence of the user's home directory (either separator
 * style, any casing) with `~` so what leaves the computer (a crash report, an
 * answer to an assistant) carries no usernames or absolute personal paths.
 */
export function scrubUserPaths(text: string, homeDirectory: string): string {
  if (homeDirectory.length === 0) {
    return text;
  }
  const variants = new Set([
    homeDirectory,
    homeDirectory.replaceAll("\\", "/"),
    homeDirectory.replaceAll("/", "\\"),
  ]);
  let scrubbed = text;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    scrubbed = scrubbed.replace(new RegExp(escaped, "gi"), "~");
  }
  return scrubbed;
}
