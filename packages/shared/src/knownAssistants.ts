/**
 * The always-on assistants Threadlines knows (contracts' KnownAssistant):
 * their names, and the guess at which one signed in. The guess reads the site
 * the sign-in returns to, then the name it gave: Grok Bot signs in as
 * "Cursor" through cursor.com, since it runs on Cursor's service. A guess
 * only: the user can pick another in the approval dialog and in Change.
 */
import type { KnownAssistant } from "@threadlines/contracts";

export const KNOWN_ASSISTANT_NAMES: Record<KnownAssistant, string> = {
  "grok-bot": "Grok Bot",
  chatgpt: "ChatGPT",
  claude: "Claude",
  muse: "Muse",
  cursor: "Cursor",
};

/** The order a picker lists them in. */
export const KNOWN_ASSISTANTS: ReadonlyArray<KnownAssistant> = [
  "grok-bot",
  "chatgpt",
  "claude",
  "muse",
  "cursor",
];

/** Sites sign-ins return to. Cursor's are Grok Bot's: the always-on assistant that signs in through them. */
const BY_HOST: ReadonlyArray<readonly [string, KnownAssistant]> = [
  ["cursor.com", "grok-bot"],
  ["cursor.sh", "grok-bot"],
  ["x.ai", "grok-bot"],
  ["grok.com", "grok-bot"],
  ["chatgpt.com", "chatgpt"],
  ["openai.com", "chatgpt"],
  ["claude.ai", "claude"],
  ["claude.com", "claude"],
  ["anthropic.com", "claude"],
  ["meta.ai", "muse"],
];

/** Names given at sign-in, or typed for a key. */
const BY_NAME: ReadonlyArray<readonly [RegExp, KnownAssistant]> = [
  [/\bgrok\b/iu, "grok-bot"],
  [/\b(chatgpt|openai|dots?)\b/iu, "chatgpt"],
  [/\bclaude\b/iu, "claude"],
  [/\b(muse|meta)\b/iu, "muse"],
  [/\bcursor\b/iu, "cursor"],
];

/** Which known assistant a sign-in looks like; null when nothing says. */
export function guessKnownAssistant(input: {
  /** The site its sign-in returns to, or its checked site; null for a key. */
  readonly host: string | null;
  /** The name it gave, or the key's name. */
  readonly name: string;
}): KnownAssistant | null {
  if (input.host !== null) {
    const host = input.host.toLowerCase().replace(/:\d+$/u, "");
    const byHost = BY_HOST.find(([site]) => host === site || host.endsWith(`.${site}`));
    if (byHost !== undefined) return byHost[1];
  }
  return BY_NAME.find(([pattern]) => pattern.test(input.name))?.[1] ?? null;
}

/** What Threadlines calls an assistant: the known one's name, else the name it gave. */
export const assistantDisplayName = (assistant: KnownAssistant | null, givenName: string) =>
  assistant === null ? givenName : KNOWN_ASSISTANT_NAMES[assistant];
