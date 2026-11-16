/**
 * Which drivers can run a room's side answer or review here: a locked-down,
 * read-only runtime that cannot edit, ask the user, or load the user's or
 * the project's hooks, plugins and MCP servers (docs/design/rooms-slice-2.md).
 *
 * Codex and Claude lock down on every platform. Grok's lockdown rests on its
 * own kernel sandbox, which keeps a checkout read-only on macOS only: on
 * Linux, Landlock still lets a command change a file's mode, timestamps and
 * extended attributes, and before kernel 6.2 truncate it; Windows has none.
 * Every other driver is refused: nothing in it guarantees read-only.
 *
 * The room tools read this, and the server reports Grok's answer to clients
 * (`ExecutionEnvironmentCapabilities.grokAnswersOnTheSide`).
 */
const GROK_SIDE_ANSWER_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin"]);

export function driverAnswersOnTheSide(
  driver: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  switch (driver) {
    case "codex":
    case "claudeAgent":
      return true;
    case "grok":
      return GROK_SIDE_ANSWER_PLATFORMS.has(platform);
    default:
      return false;
  }
}

/** The drivers that can, in words, for a refusal. */
export function sideAnswerDriversInWords(platform: NodeJS.Platform = process.platform): string {
  return driverAnswersOnTheSide("grok", platform)
    ? "Codex, Claude and Grok agents can"
    : "only Codex and Claude agents can";
}
