import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { useServerKeybindings } from "../../rpc/serverState";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { selectSettingsSearchActive, useSettingsSearchStore } from "./settingsSearchStore";

/**
 * The settings search field (docs/design/settings-search.md), kept apart from
 * the results so the settings menu stays small: the results know every
 * settings row.
 */

/** Marks the field, so Escape in it clears the search or leaves Settings like anywhere else. */
export const SETTINGS_SEARCH_FIELD_ATTRIBUTE = "data-settings-search-field";

export function SettingsSearchField({ className }: { readonly className?: string }) {
  const query = useSettingsSearchStore((state) => state.query);
  const setQuery = useSettingsSearchStore((state) => state.setQuery);
  const clear = useSettingsSearchStore((state) => state.clear);
  const focusRequest = useSettingsSearchStore((state) => state.focusRequest);
  const inputRef = useRef<HTMLInputElement>(null);
  const keybindings = useServerKeybindings();
  const shortcut = shortcutLabelForCommand(keybindings, "chat.find");

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  return (
    // Pressed in like every text field, 32px like the thread list's search bar.
    <label
      className={cn(
        "relative flex h-8 w-full min-w-0 cursor-text items-center gap-2 rounded-lg bg-field px-2.5 text-muted-foreground shadow-(--field-shadow) focus-ring-within",
        className,
      )}
    >
      <SearchIcon aria-hidden className="size-3.5 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        autoComplete="off"
        {...{ [SETTINGS_SEARCH_FIELD_ATTRIBUTE]: "" }}
        className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder placeholder:italic"
      />
      {query.length > 0 ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="-me-1.5 size-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : shortcut ? (
        // Keyboard chrome means nothing to a touch pointer.
        <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px] pointer-coarse:hidden">
          {shortcut}
        </Kbd>
      ) : null}
    </label>
  );
}

/** Whether a search is showing results. */
export const useSettingsSearchActive = (): boolean =>
  useSettingsSearchStore(selectSettingsSearchActive);
