/**
 * The always-on assistants Threadlines knows (contracts' KnownAssistant):
 * their names, and the guess at which one a connection is.
 *
 * A sign-in is guessed from the site it returns to, never from the name it
 * gives: anyone can call itself "ChatGPT", but the sign-in ends at that site,
 * so a client that names someone else's can't finish it. Grok Bot signs in as
 * "Cursor" through cursor.com, since it runs on Cursor's service. A key is
 * guessed from the label the user typed. Only a guess: the user can pick
 * another in the approval dialog and in Change.
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

/** Labels the user typed for a key. Never applied to the name a sign-in gives. */
const BY_NAME: ReadonlyArray<readonly [RegExp, KnownAssistant]> = [
  [/\bgrok\b/iu, "grok-bot"],
  [/\b(chatgpt|openai|dots?)\b/iu, "chatgpt"],
  [/\bclaude\b/iu, "claude"],
  [/\b(muse|meta)\b/iu, "muse"],
  [/\bcursor\b/iu, "cursor"],
];

/** Which known assistant a sign-in is, by the site it returns to (or its checked site); null: none. */
export function assistantOfSignInHost(host: string): KnownAssistant | null {
  // An app's return address (`cursor://anysphere.cursor-mcp/`, `com.example.app:`) names no site,
  // whatever host it carries: only a site's own host, with or without a port, counts.
  if (/\/|:(?!\d+$)/u.test(host)) return null;
  const bare = host.toLowerCase().replace(/:\d+$/u, "");
  return BY_HOST.find(([site]) => bare === site || bare.endsWith(`.${site}`))?.[1] ?? null;
}

/** Which known assistant a key is, by the label the user typed for it ("Muse work"); null: none. */
export function assistantOfKeyLabel(label: string): KnownAssistant | null {
  return BY_NAME.find(([pattern]) => pattern.test(label))?.[1] ?? null;
}

/** What Threadlines calls an assistant: the known one's name, else the name it gave. */
export const assistantDisplayName = (assistant: KnownAssistant | null, givenName: string) =>
  assistant === null ? givenName : KNOWN_ASSISTANT_NAMES[assistant];
