/**
 * Keeping a trial, shared by the trial bar and the composer's /theme strip
 * (both load it only when they open).
 *
 * A theme an agent offered again (a new version on the same chat offer) updates
 * the copy kept from an earlier version, so iterating on one theme leaves one
 * entry in the library; Keep both adds it as a new one instead.
 */
import { useMemo } from "react";

import { commitThemeTrial, type ThemeTrial } from "~/theme/themeStore";
import {
  keepThemeInLibrary,
  keptCopyOfOffer,
  type LibraryTheme,
  useLibraryThemes,
} from "~/themeLibrary/themeLibraryState";
import { toastManager } from "../../ui/toast";

/** The library entry keeping this trial would update (keptCopyOfOffer); null for none. */
export function themeUpdateTarget(
  trial: ThemeTrial,
  library: ReadonlyArray<LibraryTheme>,
): LibraryTheme | null {
  if (trial.choice.kind !== "unsaved" || trial.manifest === null) return null;
  return keptCopyOfOffer(library, trial.manifest, trial.choice.hash);
}

/** The entry the trial bar's Keep would update, as the library changes. */
export function useThemeUpdateTarget(trial: ThemeTrial): LibraryTheme | null {
  const library = useLibraryThemes();
  return useMemo(() => themeUpdateTarget(trial, library), [trial, library]);
}

/**
 * Keeps a trial: commits it, first keeping it in the library
 * (keepThemeInLibrary: the entry that has it, an update of the copy kept from
 * an earlier version of the same offer, or a new entry). `asCopy` (Keep both)
 * always adds a new entry.
 */
export async function keepThemeTrial(
  trial: ThemeTrial,
  options: { readonly asCopy?: boolean } = {},
): Promise<void> {
  if (trial.choice.kind !== "unsaved" || trial.manifest === null) {
    commitThemeTrial(trial.id);
    return;
  }
  try {
    const kept = await keepThemeInLibrary(
      { manifest: trial.manifest, name: trial.name, hash: trial.choice.hash },
      options,
    );
    commitThemeTrial(trial.id, {
      kind: "library",
      entryId: kept.entry.entryId,
      hash: kept.entry.hash,
      name: kept.entry.name,
      environmentId: kept.environmentId,
    });
  } catch (error) {
    // Kept on this device either way; Settings can save it to the library later.
    commitThemeTrial(trial.id);
    toastManager.add({
      type: "warning",
      title: `Kept ${trial.name} on this device only`,
      description: `It couldn't be saved to your library: ${
        error instanceof Error ? error.message : "try again from Settings"
      }`,
    });
  }
}
