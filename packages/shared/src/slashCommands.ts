import type { ServerProviderSlashCommand } from "@threadlines/contracts";

/**
 * Rules for the slash commands an agent advertises (ACP
 * `available_commands_update`) and for telling a message that runs one.
 * An agent's list is untrusted input that reaches every client, so it is
 * capped and cleaned before anything stores or sends it.
 */

/** The most commands kept from one list; the rest are dropped. */
export const SLASH_COMMANDS_MAX = 200;
/** Longest description and input hint kept, in characters (code points). */
export const SLASH_COMMAND_DESCRIPTION_MAX = 300;
export const SLASH_COMMAND_HINT_MAX = 120;

/**
 * A name a message can start with: a letter, digit or `_`, then up to 63 of
 * those or `.`, `:` and `-`. No `/` (a path is not a command), no spaces, no
 * invisible or direction-changing characters.
 */
const SLASH_COMMAND_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]{0,63}$/u;

export function isSlashCommandName(name: string): boolean {
  return SLASH_COMMAND_NAME.test(name);
}

/**
 * The command a message starts with: `/` then a name, then whitespace or
 * the end. `undefined` for anything else, a leading space or a path
 * (`/tmp/out.log`) included.
 */
export function slashCommandAtStart(text: string): string | undefined {
  const match = /^\/([^\s/]+)(?=\s|$)/u.exec(text);
  const name = match?.[1];
  return name !== undefined && isSlashCommandName(name) ? name : undefined;
}

/** Drops control and format characters (bidi overrides among them) and caps the length without splitting a character. */
function cleanText(text: string, max: number): string | undefined {
  const cleaned = Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim());
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).join("")}…` : cleaned.join("");
}

/**
 * An advertised list in the composer's terms: names without a leading `/`,
 * each once (the first wins), only valid names, capped in count and length.
 */
export function cleanSlashCommands(
  commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | null | undefined;
    readonly input?: { readonly hint: string } | null | undefined;
  }>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const cleaned: Array<ServerProviderSlashCommand> = [];
  for (const command of commands) {
    if (cleaned.length >= SLASH_COMMANDS_MAX) break;
    const name = command.name.trim().replace(/^\//u, "");
    if (!isSlashCommandName(name) || seen.has(name)) continue;
    seen.add(name);
    const description = cleanText(command.description ?? "", SLASH_COMMAND_DESCRIPTION_MAX);
    const hint = cleanText(command.input?.hint ?? "", SLASH_COMMAND_HINT_MAX);
    cleaned.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return cleaned;
}

/** Whether two command lists say the same thing, in the same order. */
export function sameSlashCommands(
  left: ReadonlyArray<ServerProviderSlashCommand>,
  right: ReadonlyArray<ServerProviderSlashCommand>,
): boolean {
  return (
    left.length === right.length &&
    left.every((command, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        command.name === other.name &&
        command.description === other.description &&
        command.input?.hint === other.input?.hint
      );
    })
  );
}
