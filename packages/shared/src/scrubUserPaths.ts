const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces the user's home directory (either separator style, any casing) with
 * `~` so what leaves the computer (a crash report, an answer to an assistant)
 * carries no usernames or absolute personal paths. Only the whole path counts:
 * with home `/root`, neither `fix/root-parser` nor `/home/rootless` changes.
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
    scrubbed = scrubbed.replace(
      new RegExp(`(?<![\\w.~-])${escaped(variant)}(?![\\w.-])`, "gi"),
      "~",
    );
  }
  return scrubbed;
}

/**
 * Undoes `scrubUserPaths` for what comes back: an assistant answering with an
 * option it was shown as `~/cache` means the option that really says
 * `/home/a/cache`.
 */
export function restoreUserPaths(text: string, homeDirectory: string): string {
  if (homeDirectory.length === 0) {
    return text;
  }
  return text.replace(/(?<![\w.~/\\-])~(?=$|[/\\])/g, () => homeDirectory);
}
