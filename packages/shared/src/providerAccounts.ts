/**
 * Which agents can hold extra accounts, and where each keeps one.
 *
 * An agent qualifies only when a per-process setting moves its login to a
 * folder of its own without touching `HOME`, and its sign-in honors the same
 * setting (see `docs/providers/extra-accounts-plan.md`). Cursor and fx keep
 * one login per user in the OS keychain, so they don't.
 *
 * @module providerAccounts
 */

/** Drivers that offer "Add another account", in Settings order. */
export const PROVIDER_ACCOUNT_DRIVER_KINDS = [
  "codex",
  "claudeAgent",
  "opencode",
  "antigravity",
] as const;

const PROVIDER_ACCOUNT_DRIVER_SET: ReadonlySet<string> = new Set(PROVIDER_ACCOUNT_DRIVER_KINDS);

export function supportsProviderAccounts(driver: string): boolean {
  return PROVIDER_ACCOUNT_DRIVER_SET.has(driver);
}

/**
 * The instance config key that holds an account's folder: Codex's shadow
 * home, Claude's `CLAUDE_CONFIG_DIR`, OpenCode's database folder. `null` for
 * Antigravity, which already keeps every instance in its own profile.
 */
export function providerAccountFolderField(
  driver: string,
): "shadowHomePath" | "accountFolder" | null {
  switch (driver) {
    case "codex":
      return "shadowHomePath";
    case "claudeAgent":
    case "opencode":
      return "accountFolder";
    default:
      return null;
  }
}
