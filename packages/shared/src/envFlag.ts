// The spellings effect's `Config.boolean` accepts, so a flag read straight
// from `process.env` means the same thing as one read through `Config`.
export const ENV_FLAG_TRUE_VALUES: ReadonlySet<string> = new Set(["true", "yes", "on", "1", "y"]);
export const ENV_FLAG_FALSE_VALUES: ReadonlySet<string> = new Set(["false", "no", "off", "0", "n"]);

/** `true`/`false` for a recognized on/off environment value, otherwise undefined. */
export function parseBooleanEnvFlag(raw: string | undefined): boolean | undefined {
  const value = raw?.trim();
  if (value === undefined) return undefined;
  if (ENV_FLAG_TRUE_VALUES.has(value)) return true;
  if (ENV_FLAG_FALSE_VALUES.has(value)) return false;
  return undefined;
}
