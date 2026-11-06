/**
 * Which themes an agent may ask a settings card to switch to
 * (docs/design/custom-themes.md, "Switching"): the built-ins, the starters,
 * and the themes in this computer's library. The app the user accepts the
 * card in looks the name up again among every library it follows, and a
 * theme new to that device starts its trial there.
 */
import { placePathLabel, THEME_LABELS } from "@threadlines/shared/appPlaces";
import type { CheckedEdit } from "@threadlines/shared/settingsEdits";
import { STARTER_THEMES } from "@threadlines/shared/themeStarters";

/** Every name a theme change may use here, lowercased: built-in ids, starter ids and names, library names. */
export function themeNamesOffered(libraryNames: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(
    [
      ...Object.keys(THEME_LABELS),
      ...STARTER_THEMES.flatMap((starter) => [starter.id, starter.manifest.name]),
      ...libraryNames,
    ].map((name) => name.trim().toLowerCase()),
  );
}

/** Why a request's theme changes can't be made here, for the agent; null when they can. */
export function themeChangesProblem(
  edits: ReadonlyArray<CheckedEdit>,
  libraryNames: ReadonlyArray<string>,
): string | null {
  const offered = themeNamesOffered(libraryNames);
  for (const { edit, place, value } of edits) {
    if (edit.control.kind !== "theme") continue;
    if (typeof value === "string" && offered.has(value.trim().toLowerCase())) continue;
    const library =
      libraryNames.length > 0
        ? `, or one in the library: ${libraryNames.map((name) => `"${name}"`).join(", ")}`
        : "";
    return `${placePathLabel(place)}: there's no theme called "${String(value)}". Use "system", "light", "dark", a starter (${STARTER_THEMES.map((starter) => `"${starter.manifest.name}"`).join(", ")})${library}.`;
  }
  return null;
}
