export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

/** A base's Pierre theme, or the fitted code colors of a built-in or custom theme (theme/codeTheme.ts). */
export type DiffThemeName =
  | (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES]
  | `tl-code-${"light" | "dark"}`
  | `tl-custom-${string}`;

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}
