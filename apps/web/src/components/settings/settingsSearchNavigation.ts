/**
 * Where a settings search result goes, for every host of the search:
 * Settings' own results and the command palette's Settings rows. A place
 * opens its page with the place lit (the place arrival), a provider opens its
 * card, a skill the Skills section, a shortcut Keybindings filtered to it.
 */
import { placeById, placeHref, type PlaceId } from "@threadlines/shared/appPlaces";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { resolvePlaceLink } from "../../appPlaceLinks";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { isElectron } from "../../env";
import { nextPlaceArrivalHash } from "../../placeArrival";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { SettingsSearchItem } from "./settingsSearchIndex";

/**
 * What a result opens: a place (lit on arrival), a page with its own reveal,
 * or Keybindings filtered to a shortcut.
 */
export type SettingsResultTarget =
  | { readonly placeId: PlaceId }
  | { readonly href: string }
  | { readonly shortcut: string };

export function settingsSearchItemTarget(item: SettingsSearchItem): SettingsResultTarget {
  switch (item.type) {
    case "place":
      return { placeId: item.place };
    case "provider":
      return { href: `/settings/providers?instance=${encodeURIComponent(item.instanceId)}` };
    case "shortcut":
      return { shortcut: commandLabel(item.binding.command) };
    case "skill":
      return { placeId: "plugins.skills" };
  }
}

/** Where a result lives, as a line reads it: "General › Terminal". */
export function settingsSearchItemWhere(item: SettingsSearchItem): string {
  const page = placeById(item.page).title;
  if (item.type === "place") {
    const place = placeById(item.place);
    // A page names itself; the right side says it is in Settings.
    if (place.kind === "page") return "Settings";
    if (place.kind === "row") {
      return `${page} › ${placeById(item.shownIn ?? (place.parent as PlaceId)).title}`;
    }
    return page;
  }
  if (item.type === "skill") return `${page} › Skills`;
  return page;
}

let lastShortcutOpening = 0;

/**
 * Numbers each opening of a shortcut, so the Keybindings page filters again
 * for it. Taken from the clock, so a reload never repeats one still in the URL.
 */
function nextShortcutOpening(): number {
  lastShortcutOpening = Math.max(Date.now(), lastShortcutOpening + 1);
  return lastShortcutOpening;
}

/**
 * Opens a result. Settings replaces the entry it is on (moving within
 * Settings, so leaving it goes back to before Settings); the palette pushes
 * one, so Back returns to the chat it was opened over. `beforeOpen` runs
 * first (Settings clears its search, so the page is what the arrival finds).
 */
export function useOpenSettingsResult(options: {
  readonly replace: boolean;
  readonly beforeOpen?: () => void;
}): (target: SettingsResultTarget) => void {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { replace, beforeOpen } = options;
  return useCallback(
    (target) => {
      if ("placeId" in target) {
        const link = resolvePlaceLink({
          href: placeHref(target.placeId),
          threadEnvironmentId: null,
          primaryEnvironmentId,
          isDesktopApp: isElectron,
        });
        if (link?.kind !== "open") return;
        beforeOpen?.();
        void navigate({
          href: `${link.href}#${nextPlaceArrivalHash(target.placeId)}`,
          // The hash names a place, not an element id; usePlaceArrival scrolls.
          hashScrollIntoView: false,
          replace,
        });
        return;
      }
      const href =
        "href" in target
          ? target.href
          : `/settings/keybindings?q=${encodeURIComponent(target.shortcut)}&n=${nextShortcutOpening()}`;
      beforeOpen?.();
      void navigate({ href, replace });
    },
    [beforeOpen, navigate, primaryEnvironmentId, replace],
  );
}
