/**
 * The "Add another account" form's rules: the name and color it suggests,
 * and what it tells the user per agent.
 *
 * @module providerAccounts.logic
 */
import { PROVIDER_ACCENT_SWATCHES } from "../../providerInstances";

const SUGGESTED_NAMES = ["Work", "Personal"] as const;

/** "Work", then "Personal", then "Account 2", "Account 3"…, never a name in use. */
export function suggestAccountName(existingNames: ReadonlyArray<string>): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const preset = SUGGESTED_NAMES.find((name) => !taken.has(name.toLowerCase()));
  if (preset) return preset;
  for (let index = 2; ; index += 1) {
    const name = `Account ${index}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** The first preset color no other account of this agent wears. */
export function suggestAccountColor(existingColors: ReadonlyArray<string | undefined>): string {
  const taken = new Set(existingColors.flatMap((color) => (color ? [color.toLowerCase()] : [])));
  // The first swatch is the brand blue the badges already use for plain rows.
  const free = PROVIDER_ACCENT_SWATCHES.slice(1).find((color) => !taken.has(color.toLowerCase()));
  return free ?? PROVIDER_ACCENT_SWATCHES[1];
}

export interface AccountFormCopy {
  /** One line under the fields: what the account keeps to itself. */
  readonly note: string;
  readonly submitLabel: string;
  /** Whether submitting goes straight on to the agent's sign-in. */
  readonly startsSignIn: boolean;
}

export function accountFormCopy(driver: string, agentName: string): AccountFormCopy {
  switch (driver) {
    case "claudeAgent":
      return {
        note: `It gets its own private folder, so signing in here won't sign you out of ${agentName} in your terminal. Your instructions, settings and skills come along.`,
        submitLabel: `Sign in to ${agentName}`,
        startsSignIn: true,
      };
    case "codex":
      return {
        note: `It gets its own private folder, so signing in here won't sign you out of ${agentName} in your terminal. Your chats and settings stay shared.`,
        submitLabel: `Sign in to ${agentName}`,
        startsSignIn: true,
      };
    case "antigravity":
      return {
        note: "It gets its own Google sign-in, separate from your other Antigravity accounts.",
        submitLabel: "Sign in with Google",
        startsSignIn: true,
      };
    default:
      return {
        note: `It keeps its own sign-ins and chat history, separate from ${agentName}'s shared ones.`,
        submitLabel: "Add account",
        startsSignIn: false,
      };
  }
}

/** "Add a Claude account", "Add an OpenCode account". */
export function addAccountMenuLabel(agentName: string): string {
  return `Add ${/^[aeiou]/iu.test(agentName) ? "an" : "a"} ${agentName} account`;
}

/**
 * Whether removing this account deletes a folder Threadlines made (and signs
 * it out), which decides what the confirmation says. Antigravity keeps every
 * account in a profile Threadlines owns. The server re-checks before deleting
 * anything; this only picks the words.
 */
export function isThreadlinesAccountFolder(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly config: unknown;
}): boolean {
  if (input.driver === "antigravity") return true;
  const config = (input.config ?? {}) as Record<string, unknown>;
  const folder = [config.accountFolder, config.shadowHomePath].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!folder) return false;
  const segments = folder
    .trim()
    .split(/[\\/]+/u)
    .filter(Boolean);
  return segments.at(-1) === input.instanceId && segments.at(-2) === "accounts";
}
