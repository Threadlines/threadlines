/**
 * Keeping a trial, shared by the trial bar and the composer's /theme strip
 * (both load it only when they open).
 */
import { commitThemeTrial, type ThemeTrial } from "~/theme/themeStore";
import { currentLibraryThemes, saveThemeToLibrary } from "~/themeLibrary/themeLibraryState";
import { toastManager } from "../../ui/toast";

/** Keeps a trial: saves a theme that isn't in a library yet, then commits it. */
export async function keepThemeTrial(trial: ThemeTrial): Promise<void> {
  if (trial.choice.kind !== "unsaved" || trial.manifest === null) {
    commitThemeTrial(trial.id);
    return;
  }
  // Already in the library (an agent offered a theme you have): keep that entry.
  const { hash } = trial.choice;
  const existing = currentLibraryThemes().find((theme) => theme.entry.hash === hash);
  if (existing) {
    commitThemeTrial(trial.id, {
      kind: "library",
      entryId: existing.entry.entryId,
      hash,
      name: existing.entry.name,
      environmentId: existing.holders[0] ?? null,
    });
    return;
  }
  try {
    const saved = await saveThemeToLibrary(trial.manifest, trial.name);
    commitThemeTrial(trial.id, {
      kind: "library",
      entryId: saved.entry.entryId,
      hash: saved.entry.hash,
      name: saved.entry.name,
      environmentId: saved.environmentId,
    });
  } catch (error) {
    // Kept on this device either way; the library copy can be saved later.
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
